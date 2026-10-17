import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLogger, DomainError } from "@orch/core";
import { createOrganization, createProject, createSession, upsertUser } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab, type Gitlab, GitlabError } from "@orch/gitlab";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { gitlabRoles } from "./membership";
import { hashToken, randomToken } from "./tokens";

let t: TestDb;
let mock: MockGitlab;
let api: Gitlab;
let clock: number;
const lines: string[] = [];

beforeEach(async () => {
  t = await createTestDb();
  mock = createMockGitlab();
  api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  clock = 1_000_000;
  lines.length = 0;
});
afterEach(async () => {
  mock.stop();
  await t.drop();
});

const roles = (over: Partial<Parameters<typeof gitlabRoles>[0]> = {}) =>
  gitlabRoles({
    db: t.db,
    gitlab: api,
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    now: () => clock,
    ...over,
  });
let nextUser = 100;
const person = (name = "u") =>
  upsertUser(t.db, { gitlabId: nextUser++, username: `${name}${nextUser}`, name });
const linkedOrg = async (path: string) => {
  const group = mock.addGroup(path);
  const org = await createOrganization(t.db, {
    slug: path.replaceAll("/", "-"),
    name: path,
    gitlabGroupId: group.id,
  });
  return { group, org };
};
const memberRequests = () => mock.requests.filter((r) => r.path.includes("/members/all/"));

describe("which GitLab access level holds which role", () => {
  test("a group level becomes the organization role, below Reporter nothing", async () => {
    const user = await person();
    const expected: Record<number, string | undefined> = {
      10: undefined,
      20: "viewer",
      30: "member",
      40: "admin",
      50: "owner",
    };
    const orgs = new Map<number, string>();
    for (const level of Object.keys(expected).map(Number)) {
      const { group, org } = await linkedOrg(`g${level}`);
      mock.addMember({ group: group.id }, user.gitlabId, level);
      orgs.set(level, org.id);
    }
    const got = await roles()(user);
    for (const [level, role] of Object.entries(expected)) {
      expect([level, got.orgRoles[orgs.get(Number(level)) ?? ""]]).toEqual([level, role]);
    }
    expect(got.projectRoles).toEqual({});
  });

  test("a project level becomes the project role, below Reporter nothing", async () => {
    const user = await person();
    const org = await createOrganization(t.db, { slug: "acme", name: "Acme" });
    const expected: Record<number, string | undefined> = {
      10: undefined,
      20: "reporter",
      30: "developer",
      40: "maintainer",
      50: "maintainer",
    };
    const projects = new Map<number, string>();
    for (const level of Object.keys(expected).map(Number)) {
      const gl = mock.addProject({ path: `acme/p${level}` });
      mock.addMember({ project: gl.id }, user.gitlabId, level);
      const p = await createProject(t.db, {
        organizationId: org.id,
        name: `p${level}`,
        gitlabProjectId: gl.id,
      });
      projects.set(level, p.id);
    }
    const got = await roles()(user);
    for (const [level, role] of Object.entries(expected)) {
      expect([level, got.projectRoles[projects.get(Number(level)) ?? ""]]).toEqual([level, role]);
    }
    expect(got.orgRoles).toEqual({}); // the org is not linked to a group
  });

  test("membership inherited from a parent group counts", async () => {
    const user = await person();
    const top = mock.addGroup("acme");
    const { org } = await linkedOrg("acme/platform");
    mock.addMember({ group: top.id }, user.gitlabId, 40);
    expect((await roles()(user)).orgRoles).toEqual({ [org.id]: "admin" });
  });

  test("an invite not yet accepted, and a blocked account, hold nothing", async () => {
    const [invited, blocked] = [await person(), await person()];
    const { group } = await linkedOrg("acme");
    mock.addUser({ id: blocked.gitlabId, username: "b", name: "B", state: "blocked" });
    mock.addMember({ group: group.id }, invited.gitlabId, 50, "awaiting");
    mock.addMember({ group: group.id }, blocked.gitlabId, 50);
    expect((await roles()(invited)).orgRoles).toEqual({});
    expect((await roles()(blocked)).orgRoles).toEqual({});
  });

  test("a group or project that is gone from GitLab holds nothing, and is not an error", async () => {
    const user = await person();
    const org = await createOrganization(t.db, {
      slug: "ghost",
      name: "G",
      gitlabGroupId: 987_654,
    });
    await createProject(t.db, { organizationId: org.id, name: "p", gitlabProjectId: 987_655 });
    expect(await roles()(user)).toEqual({ orgRoles: {}, projectRoles: {} });
  });

  test("only linked organizations and projects are asked about, with the user's own id", async () => {
    const user = await person();
    const { group } = await linkedOrg("acme");
    await createOrganization(t.db, { slug: "unlinked", name: "U" });
    const other = await createOrganization(t.db, { slug: "other", name: "O" });
    await createProject(t.db, { organizationId: other.id, name: "unlinked" });
    const gl = mock.addProject({ path: "acme/web" });
    await createProject(t.db, { organizationId: other.id, name: "web", gitlabProjectId: gl.id });
    await roles()(user);
    expect(
      memberRequests()
        .map((r) => r.path)
        .sort(),
    ).toEqual(
      [
        `/api/v4/groups/${group.id}/members/all/${user.gitlabId}`,
        `/api/v4/projects/${gl.id}/members/all/${user.gitlabId}`,
      ].sort(),
    );
  });
});

describe("the cache", () => {
  test("roles are kept for the TTL, per user, then GitLab is asked again", async () => {
    const [a, b] = [await person("a"), await person("b")];
    const { group, org } = await linkedOrg("acme");
    mock.addMember({ group: group.id }, a.gitlabId, 50);
    const get = roles({ ttlMs: 60_000 });
    expect((await get(a)).orgRoles).toEqual({ [org.id]: "owner" });
    expect(memberRequests()).toHaveLength(1);

    // Removed in GitLab: still held until the TTL ends, to the millisecond.
    mock.removeMember({ group: group.id }, a.gitlabId);
    clock += 59_999;
    expect((await get(a)).orgRoles).toEqual({ [org.id]: "owner" });
    expect(memberRequests()).toHaveLength(1);
    clock += 1;
    expect((await get(a)).orgRoles).toEqual({});
    expect(memberRequests()).toHaveLength(2);

    // Another user never gets someone else's answer.
    expect((await get(b)).orgRoles).toEqual({});
    expect(memberRequests()).toHaveLength(3);
    expect((await get(b)).orgRoles).toEqual({});
    expect(memberRequests()).toHaveLength(3);
  });

  test("a membership gained in GitLab shows up once the TTL has passed", async () => {
    const user = await person();
    const { group, org } = await linkedOrg("acme");
    const get = roles({ ttlMs: 1000 });
    expect((await get(user)).orgRoles).toEqual({});
    mock.addMember({ group: group.id }, user.gitlabId, 30);
    expect((await get(user)).orgRoles).toEqual({});
    clock += 1000;
    expect((await get(user)).orgRoles).toEqual({ [org.id]: "member" });
  });

  test("requests at the same time share one lookup", async () => {
    const user = await person();
    const { group } = await linkedOrg("acme");
    mock.addMember({ group: group.id }, user.gitlabId, 40);
    const get = roles();
    const all = await Promise.all([get(user), get(user), get(user)]);
    expect(new Set(all.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(memberRequests()).toHaveLength(1);
  });

  test("the cache is bounded: the oldest user goes first", async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    await linkedOrg("acme");
    const get = roles({ maxUsers: 2 });
    await get(a);
    await get(b);
    await get(c); // evicts a
    expect(memberRequests()).toHaveLength(3);
    await get(b);
    await get(c);
    expect(memberRequests()).toHaveLength(3);
    await get(a);
    expect(memberRequests()).toHaveLength(4);
  });

  test("a full cache drops the expired entry, not the live one", async () => {
    const [a, b, c] = [await person(), await person(), await person()];
    await linkedOrg("acme");
    const get = roles({ maxUsers: 2, ttlMs: 1000 });
    await get(a);
    clock += 500;
    await get(b);
    clock += 600; // a has expired, b has not
    await get(c);
    expect(memberRequests()).toHaveLength(3);
    await get(b); // still cached
    expect(memberRequests()).toHaveLength(3);
  });
});

describe("when GitLab cannot answer", () => {
  test("the lookup fails with 503, and the failure is not cached", async () => {
    const user = await person();
    const { group, org } = await linkedOrg("acme");
    mock.addMember({ group: group.id }, user.gitlabId, 50);
    const get = roles();
    mock.inject({ path: /members\/all/, status: 500 });
    const error = await get(user).catch((e) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: "membership_unavailable", status: 503 });
    expect((await get(user)).orgRoles).toEqual({ [org.id]: "owner" }); // asked again
  });

  test("an expired answer is never served in place of a failed lookup", async () => {
    const user = await person();
    const { group, org } = await linkedOrg("acme");
    mock.addMember({ group: group.id }, user.gitlabId, 50);
    const get = roles({ ttlMs: 1000 });
    expect((await get(user).then((r) => r.orgRoles))[org.id]).toBe("owner");
    clock += 1000;
    mock.inject({ path: /members\/all/, status: 500 });
    await expect(get(user)).rejects.toMatchObject({ status: 503 });
  });

  test("every GitLab error kind fails closed, and one failing link fails the whole lookup", async () => {
    const user = await person();
    const { group } = await linkedOrg("acme");
    await linkedOrg("beta");
    mock.addMember({ group: group.id }, user.gitlabId, 50);
    for (const status of [401, 403, 429, 500, 502, 503]) {
      mock.inject({ path: /members\/all/, status });
      await expect(roles()(user)).rejects.toMatchObject({ code: "membership_unavailable" });
    }
  });

  test("a GitLab that cannot be reached at all fails closed", async () => {
    const user = await person();
    await linkedOrg("acme");
    const down = createGitlab({
      baseUrl: "http://127.0.0.1:1",
      auth: { type: "private-token", token: "token-token-token" },
      maxRetries: 0,
      allowInsecureHttp: true,
      timeoutMs: 500,
    });
    await expect(roles({ gitlab: down })(user)).rejects.toMatchObject({ status: 503 });
  });

  test("the log says what failed and the response says nothing of GitLab; no token in either", async () => {
    const user = await person();
    await linkedOrg("acme");
    mock.inject({ path: /members\/all/, status: 403 });
    const error = (await roles()(user).catch((e) => e)) as DomainError;
    expect(error.message).toBe("GitLab membership could not be checked");
    const log = lines.join("\n");
    expect(log).toContain("gitlab membership lookup failed");
    expect(log).toContain('"kind":"forbidden"');
    expect(log).not.toContain(mock.token);
    expect(error.message).not.toContain(mock.token);
  });

  test("a refused token is logged as an error, a hiccup as a warning", async () => {
    const user = await person();
    await linkedOrg("acme");
    for (const [status, level] of [
      [401, "error"],
      [403, "error"],
      [500, "warn"],
    ] as const) {
      lines.length = 0;
      mock.inject({ path: /members\/all/, status });
      await roles()(user).catch(() => {});
      expect([status, JSON.parse(lines[0] ?? "{}").level]).toEqual([status, level]);
    }
  });

  test("an error that is not GitLab's is not dressed up as one", async () => {
    const user = await person();
    await linkedOrg("acme");
    const broken = {
      members: {
        accessLevel: () => Promise.reject(new TypeError("a bug")),
      },
    } as unknown as Gitlab;
    await expect(roles({ gitlab: broken })(user)).rejects.toThrow(TypeError);
  });

  test("no new lookups start after one has failed", async () => {
    const user = await person();
    for (let i = 0; i < 20; i++) await linkedOrg(`g${i}`);
    let started = 0;
    // The first lookup fails at once, the other worker's slow ones would carry on.
    const flaky = {
      members: {
        accessLevel: async () => {
          if (++started === 1) throw new GitlabError("server", "boom", 500);
          await Bun.sleep(5);
          return 0;
        },
      },
    } as unknown as Gitlab;
    await expect(roles({ gitlab: flaky, concurrency: 2 })(user)).rejects.toMatchObject({
      status: 503,
    });
    await Bun.sleep(30); // a worker that carried on would have started more by now
    expect(started).toBe(2);
  });

  test("a late failure does not drop the entry a newer lookup made", async () => {
    const user = await person();
    await linkedOrg("acme");
    let release: () => void = () => {};
    let calls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gitlab = {
      members: {
        accessLevel: async () => {
          if (++calls > 1) return 0;
          await gate; // the first lookup hangs, then fails
          throw new GitlabError("server", "boom", 500);
        },
      },
    } as unknown as Gitlab;
    const get = roles({ gitlab, ttlMs: 1000 });
    const first = get(user).catch(() => {});
    while (calls === 0) await Bun.sleep(1); // it is out, and hangs
    clock += 1000; // the first entry has expired while its lookup is still out
    await get(user); // a newer lookup answers and is cached
    release();
    await first;
    await get(user);
    expect(calls).toBe(2); // the newer answer was still there
  });
});

describe("lookups in flight", () => {
  test("no more than `concurrency` at a time, and all of them are made", async () => {
    const user = await person();
    for (let i = 0; i < 12; i++) await linkedOrg(`g${i}`);
    let now = 0;
    let peak = 0;
    let calls = 0;
    const slow = {
      members: {
        accessLevel: async () => {
          calls++;
          peak = Math.max(peak, ++now);
          await Bun.sleep(3);
          now--;
          return 40;
        },
      },
    } as unknown as Gitlab;
    const got = await roles({ gitlab: slow, concurrency: 3 })(user);
    expect(Object.keys(got.orgRoles)).toHaveLength(12);
    expect(calls).toBe(12);
    expect(peak).toBe(3);
  });
});

describe("through the API", () => {
  const app = () =>
    createApp({
      logger: createLogger({ level: "error", write: (line) => lines.push(line) }),
      db: t.db,
      principal: callerPrincipal({ db: t.db, roles: roles({ ttlMs: 60_000 }) }),
      ready: async () => {},
    });
  async function signedIn(name: string) {
    const user = await person(name);
    const token = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(token), ttlMs: 60_000 });
    return { user, cookie: `orch_session=${token}` };
  }
  const get = (a: ReturnType<typeof app>, cookie: string, path: string) =>
    a.handle(new Request(`http://localhost${path}`, { headers: { cookie } })).then(async (res) => ({
      status: res.status,
      // biome-ignore lint/suspicious/noExplicitAny: a test reading whatever JSON came back
      json: (await res.json().catch(() => undefined)) as any,
    }));

  test("GitLab membership is what lets a user in, and what keeps others out", async () => {
    const [member, stranger] = [await signedIn("member"), await signedIn("stranger")];
    const { group, org } = await linkedOrg("acme");
    const { org: hidden } = await linkedOrg("secret");
    mock.addMember({ group: group.id }, member.user.gitlabId, 30);
    const a = app();

    const list = await get(a, member.cookie, "/organizations");
    expect(list.status).toBe(200);
    expect(list.json.items.map((o: { id: string }) => o.id)).toEqual([org.id]);
    expect((await get(a, member.cookie, `/organizations/${org.id}`)).status).toBe(200);
    expect((await get(a, member.cookie, `/organizations/${hidden.id}`)).status).toBe(404);

    expect((await get(a, stranger.cookie, "/organizations")).json.items).toEqual([]);
    expect((await get(a, stranger.cookie, `/organizations/${org.id}`)).status).toBe(404);
  });

  test("GitLab down is a 503 for a signed-in caller, never an empty list or a guess", async () => {
    const member = await signedIn("member");
    const { group, org } = await linkedOrg("acme");
    mock.addMember({ group: group.id }, member.user.gitlabId, 30);
    const a = app();
    mock.inject({ path: /members\/all/, status: 500, times: 2 });
    for (const path of ["/organizations", `/organizations/${org.id}`]) {
      const r = await get(a, member.cookie, path);
      expect([path, r.status, r.json.code]).toEqual([path, 503, "membership_unavailable"]);
    }
    expect((await get(a, member.cookie, `/organizations/${org.id}`)).status).toBe(200);
  });

  test("losing the GitLab membership means losing access when the TTL ends", async () => {
    const member = await signedIn("member");
    const { group, org } = await linkedOrg("acme");
    mock.addMember({ group: group.id }, member.user.gitlabId, 30);
    const a = app();
    expect((await get(a, member.cookie, `/organizations/${org.id}`)).status).toBe(200);
    mock.removeMember({ group: group.id }, member.user.gitlabId);
    expect((await get(a, member.cookie, `/organizations/${org.id}`)).status).toBe(200);
    clock += 60_000;
    expect((await get(a, member.cookie, `/organizations/${org.id}`)).status).toBe(404);
  });
});
