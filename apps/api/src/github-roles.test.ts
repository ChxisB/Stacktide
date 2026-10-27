import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLogger, DomainError, type OrgRole } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import { createConnection, createOrganization, importProject } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { githubForge } from "@orch/forge";
import { createGithubClient } from "@orch/github";
import { createMockGithub, type MockGithub } from "@orch/github/mock";
import { githubRoles } from "./github-roles";

// FRG-25: what a GitHub account holds here is its permission on the repositories of github.com connections,
// read with the connection's own token.

const CONNECTION_TOKEN = "ghp_connection-SECRET-CANARY-1234";
const keys = envKeyProvider(`k1:${Buffer.alloc(32, 3).toString("base64")}`);

let t: TestDb;
let mock: MockGithub;
let clock: number;
const lines: string[] = [];
let n = 0;

beforeEach(async () => {
  t = await createTestDb();
  mock = createMockGithub();
  clock = 1_000_000;
  lines.length = 0;
});
afterEach(async () => {
  mock.stop();
  await t.drop();
});

/** The lookup, with the mock standing in for github.com (the connections say github.com, which is what picks them). */
const lookup = (over: Partial<Parameters<typeof githubRoles>[0]> = {}) =>
  githubRoles({
    db: t.db,
    keys,
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    forge: (_connection, token) =>
      githubForge(
        createGithubClient({ baseUrl: mock.url, allowInsecureHttp: true, token, maxRetries: 0 }),
      ),
    now: () => clock,
    ...over,
  });

/** A repository on GitHub, its project here, and the connection that reads it. */
async function linkedRepo(owner = `acme${++n}`, baseUrl = "https://github.com", type = "github") {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const connection = await createConnection(t.db, keys, {
    organizationId: org.id,
    type,
    name: `c${n}`,
    config: { baseUrl },
    token: CONNECTION_TOKEN,
  });
  const repo = mock.addRepo(owner, "web");
  const { project } = await importProject(t.db, {
    organizationId: org.id,
    connectionId: connection.id,
    gitlabProjectId: repo.id,
    name: "web",
    defaultBranch: "main",
    types: [],
  });
  return { owner, org, connection, project };
}

describe("a GitHub account's project roles", () => {
  test("follow its permission on the repository: read and triage report, write develops, maintain and admin maintain", async () => {
    const { owner, project } = await linkedRepo();
    const roles = lookup();
    const expected = [
      ["read", "reporter"],
      ["triage", "reporter"],
      ["write", "developer"],
      ["maintain", "maintainer"],
      ["admin", "maintainer"],
    ] as const;
    for (const [role, held] of expected) {
      const who = mock.addUser(`user-${role}`);
      mock.addCollaborator(owner, "web", who.login, role);
      expect(await roles(who.id)).toEqual({
        orgRoles: {},
        projectRoles: { [project.id]: held },
      });
    }
  });

  test("a stranger holds nothing, even on a public repository", async () => {
    await linkedRepo();
    const stranger = mock.addUser("stranger");
    expect(await lookup()(stranger.id)).toEqual({ orgRoles: {}, projectRoles: {} });
  });

  test("only github.com connections count: another host's repository, a GitLab connection and an unbound project say nothing", async () => {
    const { owner } = await linkedRepo(undefined, "https://ghe.example.com");
    await linkedRepo(undefined, "https://github.com", "gitlab");
    const who = mock.addUser("admin-everywhere");
    mock.addCollaborator(owner, "web", who.login, "admin");
    const before = mock.requests.length;
    expect(await lookup()(who.id)).toEqual({ orgRoles: {}, projectRoles: {} });
    expect(mock.requests.length).toBe(before); // GitHub was not even asked
  });

  test("each connection is opened once and each repository asked about once, then the answer is kept for the TTL", async () => {
    const { owner, project } = await linkedRepo();
    const who = mock.addUser("ada");
    mock.addCollaborator(owner, "web", who.login, "write");
    const roles = lookup({ ttlMs: 60_000 });
    const first = await roles(who.id);
    const asked = mock.requests.length;
    expect(await roles(who.id)).toEqual(first);
    expect(mock.requests.length).toBe(asked);
    clock += 60_001;
    expect(await roles(who.id)).toEqual({
      orgRoles: {},
      projectRoles: { [project.id]: "developer" },
    });
    expect(mock.requests.length).toBeGreaterThan(asked);
  });

  test("a change on GitHub shows once the TTL ends", async () => {
    const { owner, project } = await linkedRepo();
    const who = mock.addUser("ada");
    mock.addCollaborator(owner, "web", who.login, "admin");
    const roles = lookup({ ttlMs: 1000 });
    expect((await roles(who.id)).projectRoles[project.id]).toBe("maintainer");
    mock.addCollaborator(owner, "web", who.login, "read");
    clock += 1001;
    expect((await roles(who.id)).projectRoles[project.id]).toBe("reporter");
  });

  test("when GitHub cannot answer the request fails closed with 503, logs no token, and the failure is not kept", async () => {
    const { owner, project } = await linkedRepo();
    const who = mock.addUser("ada");
    mock.addCollaborator(owner, "web", who.login, "write");
    const roles = lookup();
    mock.inject({
      method: "GET",
      path: `/repos/${owner}/web/collaborators/${who.login}`,
      status: 500,
      times: 1,
    });
    const error = await roles(who.id).catch((e) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: "membership_unavailable", status: 503 });
    expect(JSON.stringify(error) + String(error.message)).not.toContain(CONNECTION_TOKEN);
    expect(lines.join("\n")).not.toContain(CONNECTION_TOKEN);
    expect(lines.join("\n")).toContain("github membership lookup failed");
    // asked again, not served the failure
    expect((await roles(who.id)).projectRoles[project.id]).toBe("developer");
  });

  test("a token GitHub refuses is loud in the log and still a 503 for the caller", async () => {
    const { owner } = await linkedRepo();
    const who = mock.addUser("ada");
    mock.addCollaborator(owner, "web", who.login, "write");
    mock.inject({
      method: "GET",
      path: `/repos/${owner}/web/collaborators/${who.login}`,
      status: 401,
      times: 1,
    });
    const error = await lookup()(who.id).catch((e) => e);
    expect(error).toMatchObject({ code: "membership_unavailable", status: 503 });
    expect(lines.map((l) => JSON.parse(l)).some((l) => l.level === "error")).toBe(true);
  });

  test("a stored token that cannot be opened is not guessed at: the lookup fails", async () => {
    await linkedRepo();
    const other = envKeyProvider(`k9:${Buffer.alloc(32, 9).toString("base64")}`);
    const error = await lookup({ keys: other })(mock.addUser("ada").id).catch((e) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.status).toBe(500);
    expect(String(error.message)).not.toContain(CONNECTION_TOKEN);
  });
});

// FRG-34: an organization linked to a GitHub organization is read with the deployment's membership token, not a
// connection's: a new organization has no connection yet.
describe("a GitHub account's organization roles", () => {
  const MEMBERSHIP_TOKEN = "ghp_membership-SECRET-CANARY-9921";
  const orgForge = () =>
    githubForge(
      createGithubClient({
        baseUrl: mock.url,
        allowInsecureHttp: true,
        token: MEMBERSHIP_TOKEN,
        maxRetries: 0,
      }),
    );
  /** An organization here, linked to a new organization on GitHub. */
  async function linkedOrg() {
    const hub = mock.addOrg(`hub${++n}`);
    const org = await createOrganization(t.db, {
      slug: `o${++n}`,
      name: "O",
      githubOrgId: hub.id,
    });
    return { hub, org };
  }

  test("an owner of the GitHub organization is an owner here, a member a member, and anyone else holds nothing", async () => {
    const { hub, org } = await linkedOrg();
    const roles = lookup({ orgForge: orgForge() });
    const held: [string, OrgRole | undefined][] = [
      ["admin", "owner"],
      ["member", "member"],
      ["billing_manager", undefined], // pays the bills, reads no code
    ];
    for (const [role, expected] of held) {
      const who = mock.addUser(`user-${role}`);
      mock.addOrgMember(hub.login, who.login, role);
      expect(await roles(who.id)).toEqual({
        orgRoles: expected ? { [org.id]: expected } : {},
        projectRoles: {},
      });
    }
    const pending = mock.addUser("invited");
    mock.addOrgMember(hub.login, pending.login, "admin", "pending");
    expect((await roles(pending.id)).orgRoles).toEqual({});
    expect((await roles(mock.addUser("stranger").id)).orgRoles).toEqual({});
  });

  test("a project role and an organization role come from one lookup", async () => {
    const { owner, project } = await linkedRepo();
    const { hub, org } = await linkedOrg();
    const who = mock.addUser("ada");
    mock.addCollaborator(owner, "web", who.login, "write");
    mock.addOrgMember(hub.login, who.login, "admin");
    expect(await lookup({ orgForge: orgForge() })(who.id)).toEqual({
      orgRoles: { [org.id]: "owner" },
      projectRoles: { [project.id]: "developer" },
    });
  });

  test("without the deployment's membership token, or for an organization with no GitHub link, GitHub is not asked", async () => {
    const { hub } = await linkedOrg();
    await createOrganization(t.db, { slug: `plain${++n}`, name: "Plain" });
    const who = mock.addUser("ada");
    mock.addOrgMember(hub.login, who.login, "admin");
    const before = mock.requests.length;
    expect(await lookup()(who.id)).toEqual({ orgRoles: {}, projectRoles: {} });
    expect(mock.requests.length).toBe(before);
    // with the token, only the linked organization is asked about
    await lookup({ orgForge: orgForge() })(who.id);
    const asked = mock.requests.slice(before).map((r) => r.path);
    expect(asked.filter((path) => path.startsWith("/orgs/"))).toEqual([
      `/orgs/${hub.login}/memberships/${who.login}`,
    ]);
  });

  test("the membership token is the one that reads organizations, and no token reaches the log or an error", async () => {
    const { hub } = await linkedOrg();
    const who = mock.addUser("ada");
    mock.addOrgMember(hub.login, who.login, "member");
    await lookup({ orgForge: orgForge() })(who.id);
    const calls = mock.requests.filter((r) => r.path.startsWith("/orgs/"));
    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls)).not.toContain(CONNECTION_TOKEN);
    mock.inject({
      method: "GET",
      path: `/orgs/${hub.login}/memberships/${who.login}`,
      status: 500,
      times: 1,
    });
    const roles = lookup({ orgForge: orgForge() });
    const error = await roles(who.id).catch((e) => e);
    expect(error).toMatchObject({ code: "membership_unavailable", status: 503 });
    expect(JSON.stringify(error) + String(error.message) + lines.join("\n")).not.toContain(
      MEMBERSHIP_TOKEN,
    );
  });

  test("a failed answer is not kept, and a change on GitHub shows once the TTL ends", async () => {
    const { hub, org } = await linkedOrg();
    const who = mock.addUser("ada");
    mock.addOrgMember(hub.login, who.login, "admin");
    const roles = lookup({ orgForge: orgForge(), ttlMs: 1000 });
    mock.inject({
      method: "GET",
      path: `/orgs/${hub.login}/memberships/${who.login}`,
      status: 500,
      times: 1,
    });
    await expect(roles(who.id)).rejects.toMatchObject({ status: 503 });
    expect((await roles(who.id)).orgRoles).toEqual({ [org.id]: "owner" });
    mock.addOrgMember(hub.login, who.login, "member");
    expect((await roles(who.id)).orgRoles).toEqual({ [org.id]: "owner" }); // kept
    clock += 1001;
    expect((await roles(who.id)).orgRoles).toEqual({ [org.id]: "member" });
  });
});
