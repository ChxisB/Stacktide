import { afterEach, describe, expect, test } from "bun:test";
import { GitlabError } from "@orch/gitlab";
import { createGithubClient } from "./client";
import { membersApi } from "./members";
import { createMockGithub } from "./mock/server";
import { repoBase } from "./projects";

// FRG-15: a GitHub collaborator or organization member as the access level a GitLab member would hold.

let mock: ReturnType<typeof createMockGithub>;
afterEach(() => mock?.stop());

function setup(opts: Parameters<typeof createMockGithub>[0] = {}) {
  mock?.stop();
  mock = createMockGithub(opts);
  const repo = mock.addRepo("acme", "svc");
  const client = createGithubClient({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    token: "ghp_not-a-real-token-1234",
    maxRetries: 0,
  });
  const { members } = membersApi(client, repoBase(client));
  const asked = () => mock.requests.map((r) => `${r.method} ${r.path}`);
  return { repo, members, asked };
}

describe("a collaborator's permission as an access level", () => {
  const table: [string, number][] = [
    ["read", 20],
    ["triage", 20],
    ["write", 30],
    ["maintain", 40],
    ["admin", 50],
  ];
  for (const [role, level] of table) {
    test(`${role} is ${level}, named by owner/name or by the repository's id`, async () => {
      const { members, repo } = setup();
      const u = mock.addUser("ada");
      mock.addCollaborator("acme", "svc", "ada", role);
      expect(await members.accessLevel({ project: "acme/svc" }, u.id)).toBe(level);
      expect(await members.accessLevel({ project: repo.id }, u.id)).toBe(level);
    });
  }

  test("a role GitHub names that we do not know holds what its base permission does", async () => {
    const { members } = setup();
    const u = mock.addUser("ada");
    mock.addCollaborator("acme", "svc", "ada", "release-manager", "write");
    expect(await members.accessLevel({ project: "acme/svc" }, u.id)).toBe(30);
    const v = mock.addUser("bob");
    mock.addCollaborator("acme", "svc", "bob", "release-manager", "something-new");
    expect(await members.accessLevel({ project: "acme/svc" }, v.id)).toBe(0);
  });

  test("a stranger to a public repository holds nothing, though GitHub would let them read it", async () => {
    const { members, asked } = setup();
    const u = mock.addUser("stranger");
    expect(await members.accessLevel({ project: "acme/svc" }, u.id)).toBe(0);
    // asked who is a collaborator, and not what they may do
    expect(asked().some((r) => r.endsWith("/permission"))).toBe(false);
  });

  test("a user, a repository or an organization GitHub does not have holds nothing", async () => {
    const { members } = setup();
    const u = mock.addUser("ada");
    mock.addCollaborator("acme", "svc", "ada", "admin");
    expect(await members.accessLevel({ project: "acme/svc" }, 2_000_000_000)).toBe(0);
    expect(await members.accessLevel({ project: "acme/none" }, u.id)).toBe(0);
    expect(await members.accessLevel({ project: 2_000_000_000 }, u.id)).toBe(0);
    const org = mock.addOrg("acme-org");
    expect(await members.accessLevel({ project: "acme/svc" }, org.id)).toBe(0);
    expect(await members.accessLevel({ group: "no-such-org" }, u.id)).toBe(0);
    expect(await members.accessLevel({ group: 2_000_000_000 }, u.id)).toBe(0);
  });

  test("an organization is no user: its id holds nothing, whatever a repository or organization lists under its name", async () => {
    const { members } = setup();
    const org = mock.addOrg("some-org");
    mock.addCollaborator("acme", "svc", "some-org", "admin");
    mock.addOrgMember("acme", "some-org", "admin");
    mock.addOrg("acme");
    expect(await members.accessLevel({ project: "acme/svc" }, org.id)).toBe(0);
    expect(await members.accessLevel({ group: "acme" }, org.id)).toBe(0);
  });

  test("a failure that is not 'no such thing' is thrown, not read as no access", async () => {
    const { members } = setup({ denied: ["/collaborators"] });
    const u = mock.addUser("ada");
    mock.addCollaborator("acme", "svc", "ada", "admin");
    const e = await members.accessLevel({ project: "acme/svc" }, u.id).catch((x) => x);
    expect(e).toBeInstanceOf(GitlabError);
    expect(e.kind).toBe("forbidden");
  });

  test("a number that is not a user id, or a login that would leave the URL, sends nothing", async () => {
    const { members, asked } = setup();
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      const e = await members.accessLevel({ project: "acme/svc" }, bad).catch((x) => x);
      expect(e).toBeInstanceOf(GitlabError);
      expect(e.kind).toBe("invalid");
    }
    expect(asked()).toEqual([]);
    const odd = mock.addUser("..");
    const e = await members.accessLevel({ project: "acme/svc" }, odd.id).catch((x) => x);
    expect(e.kind).toBe("invalid");
    expect(asked().some((r) => r.includes("/collaborators"))).toBe(false);
  });
});

describe("an organization member as an access level", () => {
  test("an owner is 50 and a member 30, by login or by the organization's id", async () => {
    const { members } = setup();
    const org = mock.addOrg("acme");
    const [boss, dev] = [mock.addUser("boss"), mock.addUser("dev")];
    mock.addOrgMember("acme", "boss", "admin");
    mock.addOrgMember("acme", "dev", "member");
    expect(await members.accessLevel({ group: "acme" }, boss.id)).toBe(50);
    expect(await members.accessLevel({ group: org.id }, boss.id)).toBe(50);
    expect(await members.accessLevel({ group: "acme" }, dev.id)).toBe(30);
    expect(await members.accessLevel({ group: org.id }, dev.id)).toBe(30);
  });

  test("an invitation not yet accepted, a billing manager and a stranger hold nothing", async () => {
    const { members } = setup();
    mock.addOrg("acme");
    const [invited, biller, stranger] = [
      mock.addUser("invited"),
      mock.addUser("biller"),
      mock.addUser("stranger"),
    ];
    mock.addOrgMember("acme", "invited", "admin", "pending");
    mock.addOrgMember("acme", "biller", "billing_manager");
    expect(await members.accessLevel({ group: "acme" }, invited.id)).toBe(0);
    expect(await members.accessLevel({ group: "acme" }, biller.id)).toBe(0);
    expect(await members.accessLevel({ group: "acme" }, stranger.id)).toBe(0);
  });

  test("an organization name that would leave the URL sends nothing", async () => {
    const { members, asked } = setup();
    const u = mock.addUser("ada");
    for (const group of ["a/b", "..", ""]) {
      const e = await members.accessLevel({ group }, u.id).catch((x) => x);
      expect(e.kind).toBe("invalid");
    }
    expect(asked().filter((r) => r.includes("/memberships"))).toEqual([]);
    // and an organization's id has to be a whole number, or nothing is asked about it
    for (const group of [0, -1, 1.5, Number.NaN]) {
      const e = await members.accessLevel({ group }, u.id).catch((x) => x);
      expect(e.kind).toBe("invalid");
    }
    expect(asked().filter((r) => r.includes("/organizations"))).toEqual([]);
  });
});
