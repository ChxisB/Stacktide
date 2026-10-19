import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createLogger, LEASES_PER_PRINCIPAL, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createApiToken,
  createCiToken,
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  secretLeases,
  startLease,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, newApiToken, newCiToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const HOUR = 3_600_000;

let t: TestDb;
let mock: MockGitlab;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<
  "alice" | "bob" | "carol" | "dana" | "erin",
  { id: string; cookie: string }
>;
const ids = {} as Record<"o1" | "o2" | "o3" | "o4" | "p1" | "p2" | "p3" | "p4" | "dev", string>;
let remote = { p1: 0, p3: 0 };

// the shared app's allowance is wide: tests take many leases as one person, and the limit has its own test
const makeApp = (scale = 100) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
    hardening: { rateLimitScale: scale },
  });
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab();
  remote = {
    p1: mock.addProject({ path: "platform/one" }).id,
    p3: mock.addProject({ path: "platform/three" }).id,
  };
  const org = async (slug: string) => (await createOrganization(t.db, { slug, name: slug })).id;
  ids.o1 = await org("one");
  ids.o2 = await org("two");
  ids.o3 = await org("three"); // two GitLab connections
  ids.o4 = await org("four"); // none
  const project = async (organizationId: string, name: string, gitlabProjectId?: number) =>
    (
      await createProject(t.db, {
        organizationId,
        name,
        ...(gitlabProjectId && { gitlabProjectId }),
      })
    ).id;
  ids.p1 = await project(ids.o1, "p1", remote.p1);
  ids.p2 = await project(ids.o1, "p2"); // not linked to GitLab
  ids.p3 = await project(ids.o1, "p3", remote.p3);
  ids.p4 = await project(ids.o3, "p4", remote.p1);
  ids.dev = (
    await createEnvironment(t.db, {
      organizationId: ids.o1,
      projectId: ids.p1,
      name: "dev",
      slug: "dev",
    })
  ).id;
  const connect = (organizationId: string, name: string) =>
    createConnection(t.db, keys, {
      organizationId,
      type: "gitlab",
      name,
      config: { baseUrl: mock.url },
      token: mock.token,
    });
  await connect(ids.o1, "live");
  await connect(ids.o2, "live");
  await connect(ids.o3, "a");
  await connect(ids.o3, "b");
  let gitlabId = 700;
  for (const name of ["alice", "bob", "carol", "erin", "dana"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(701, { orgRoles: { [ids.o1]: "admin", [ids.o3]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(702, { orgRoles: {}, projectRoles: { [ids.p1]: "developer" } }); // bob
  roleTable.set(703, { orgRoles: {}, projectRoles: { [ids.p1]: "reporter" } }); // carol
  roleTable.set(704, { orgRoles: { [ids.o2]: "admin" }, projectRoles: {} }); // erin
  roleTable.set(705, { orgRoles: {}, projectRoles: { [ids.p1]: "maintainer" } }); // dana
  app = makeApp();
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});
beforeEach(async () => {
  // every test counts its own leases (the cap is per principal, the sweeper is not under test here)
  await t.db.delete(secretLeases);
});

type Who = keyof typeof people | { bearer: string } | undefined;
const seen: string[] = [];
async function call(who: Who, method: string, path: string, body?: unknown, a = app) {
  const headers: Record<string, string> = {};
  if (typeof who === "string") headers.cookie = people[who].cookie;
  else if (who) headers.authorization = `Bearer ${who.bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await a.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  seen.push(text);
  return {
    status: res.status,
    text,
    headers: res.headers,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const leases = (org = ids.o1, p = ids.p1) => `/organizations/${org}/projects/${p}/leases`;
const take = (who: Who, body: unknown = { scopes: ["read_repository"] }, path = leases()) =>
  call(who, "POST", path, body);
const rows = (action: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, action));
const requests = () => mock.requests.length;

const apiToken = async (who: "alice" | "bob" | "carol", scopes: string[]) => {
  const fresh = newApiToken();
  await createApiToken(t.db, {
    userId: people[who].id,
    name: "t",
    prefix: fresh.prefix,
    tokenHash: fresh.tokenHash,
    scopes,
    ttlMs: HOUR,
  });
  return { bearer: fresh.token };
};
const ciToken = async (
  over: {
    project?: string;
    scopes?: string[];
    job?: number;
    environment?: string;
    ttlMs?: number;
  } = {},
) => {
  const fresh = newCiToken();
  await createCiToken(t.db, {
    organizationId: ids.o1,
    projectId: over.project ?? ids.p1,
    ...(over.environment && { environmentId: over.environment }),
    tokenHash: fresh.tokenHash,
    scopes: over.scopes ?? ["project.read", "run.summary", "lease.issue", "lease.revoke"],
    gitlabProjectId: 1,
    gitlabJobId: over.job ?? 4242,
    ref: "main",
    refProtected: true,
    ttlMs: over.ttlMs ?? HOUR,
  });
  return { bearer: fresh.token };
};

describe("who may take, see and end a lease", () => {
  test("a developer takes one, a reporter only sees the list, an outsider finds nothing", async () => {
    expect((await take("bob")).status).toBe(201);
    expect((await take("alice")).status).toBe(201); // an org admin is a maintainer here

    expect((await take("carol")).status).toBe(403);
    const list = await call("carol", "GET", leases());
    expect(list.status).toBe(200);
    expect(list.json.items).toHaveLength(2);
    const id = list.json.items[0].id;
    expect((await call("carol", "DELETE", `${leases()}/${id}`)).status).toBe(403);

    // another organization's admin: the project is not theirs to know of
    for (const r of [
      await take("erin"),
      await call("erin", "GET", leases()),
      await call("erin", "DELETE", `${leases()}/${id}`),
    ]) {
      expect(r.status).toBe(404);
    }
    expect((await take(undefined)).status).toBe(401);
    expect((await call(undefined, "GET", leases())).status).toBe(401);
  });

  test("an API token needs the scope by name, and a project path does not reach into another organization", async () => {
    expect((await take(await apiToken("bob", ["project.read"]))).status).toBe(403);
    expect((await take(await apiToken("bob", ["lease.issue"]))).status).toBe(201);
    expect((await take(await apiToken("bob", ["lease.*"]))).status).toBe(201);
    // the project of one organization under another's path
    expect((await take("alice", undefined, leases(ids.o2, ids.p1))).status).toBe(404);
    expect((await take("alice", undefined, leases(ids.o1, crypto.randomUUID()))).status).toBe(404);
  });
});

describe("the project's GitLab link is what a lease is made on", () => {
  test("only an org admin re-points it; a project maintainer cannot aim leases at another GitLab project", async () => {
    const other = mock.addProject({ path: "platform/other" }).id;
    const patch = (who: Who, body: unknown) =>
      call(who, "PATCH", `/organizations/${ids.o1}/projects/${ids.p1}`, body);
    for (const gitlabProjectId of [other, null]) {
      const res = await patch("dana", { gitlabProjectId });
      expect([res.status, res.json.code]).toEqual([403, "forbidden"]);
    }
    // the rest of a project is still the maintainer's
    expect((await patch("dana", { defaultBranch: "trunk" })).status).toBe(200);
    const made = await take("dana");
    expect(made.status).toBe(201);
    expect(mock.requests.at(-1)?.path).toContain(`/projects/${remote.p1}/`);

    expect((await patch("alice", { gitlabProjectId: other })).json.gitlabProjectId).toBe(other);
    expect((await patch("alice", { gitlabProjectId: remote.p1 })).status).toBe(200);
  });
});

describe("taking a lease", () => {
  test("answers once with the value, in no-store, and nothing that names the credential at GitLab", async () => {
    const before = Date.now();
    const res = await take("bob", { scopes: ["read_api", "read_repository"], ttlSeconds: 600 });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { value, ...lease } = res.json;
    expect(value).toMatch(/^glpat-/);
    expect(mock.accessTokenValid(value)).toBe(true);
    expect(lease).toEqual({
      id: expect.any(String),
      organizationId: ids.o1,
      projectId: ids.p1,
      principal: `user:${people.bob.id}`,
      provider: "gitlab-token",
      scopes: ["read_api", "read_repository"],
      expiresAt: expect.any(String),
      revokedAt: null,
      createdAt: expect.any(String),
    });
    const ttl = Date.parse(lease.expiresAt) - before;
    expect(ttl).toBeGreaterThan(599_000);
    expect(ttl).toBeLessThan(602_000);

    // the default is an hour
    const dflt = await take("bob");
    expect(Date.parse(dflt.json.expiresAt) - Date.now()).toBeGreaterThan(HOUR - 5000);

    const [event] = (await rows("lease.issue")).filter((e) => e.resourceId === lease.id);
    expect(event).toMatchObject({
      actorKind: "user",
      actorId: people.bob.id,
      organizationId: ids.o1,
      projectId: ids.p1,
    });
    expect(JSON.stringify(event?.metadata)).toContain("read_repository");
  });

  test("the request cannot widen the lease or name another project; nothing is asked of GitLab when it is refused", async () => {
    const before = requests();
    const refused = [
      { scopes: ["api"] },
      { scopes: ["read_repository", "write_repository"] },
      { scopes: [] },
      {},
      { scopes: ["read_repository"], ttlSeconds: 59 },
      { scopes: ["read_repository"], ttlSeconds: 86_401 },
      { scopes: ["read_repository"], ttlSeconds: 90.5 },
      { scopes: ["read_repository"], projectId: remote.p3 },
      { scopes: ["read_repository"], accessLevel: 40 },
      { scopes: ["read_repository"], connectionId: crypto.randomUUID() },
    ];
    for (const body of refused) expect((await take("bob", body)).status).toBe(422);
    expect(
      (await take("bob", { scopes: ["read_repository"], provider: "postgres-role" })).json,
    ).toMatchObject({
      code: "unknown_provider",
    });
    expect(requests()).toBe(before);
  });

  test("the token is made on the project the platform project is linked to", async () => {
    const res = await take("bob");
    const [row] = await t.db.select().from(secretLeases).where(eq(secretLeases.id, res.json.id));
    expect(row?.remoteProjectId).toBe(remote.p1);
    expect(row?.handle).toMatch(/^\d+$/);
  });

  test("a project that is not linked to GitLab, and an organization without exactly one GitLab connection, are refused", async () => {
    const before = requests();
    const unlinked = await take("alice", undefined, leases(ids.o1, ids.p2));
    expect([unlinked.status, unlinked.json.code]).toEqual([409, "project_not_linked"]);
    const many = await call(
      { bearer: (await apiToken("alice", ["lease.*"])).bearer },
      "POST",
      leases(ids.o3, ids.p4),
      { scopes: ["read_repository"] },
    );
    expect([many.status, many.json.code]).toEqual([409, "connection_ambiguous"]);
    expect(requests()).toBe(before);

    const bare = await createProject(t.db, {
      organizationId: ids.o4,
      name: "bare",
      gitlabProjectId: 5,
    });
    roleTable.set(701, {
      orgRoles: { [ids.o1]: "admin", [ids.o3]: "admin", [ids.o4]: "admin" },
      projectRoles: {},
    });
    const none = await take("alice", undefined, leases(ids.o4, bare.id));
    expect([none.status, none.json.code]).toEqual([409, "no_gitlab_connection"]);
  });

  test("a provider the connection cannot use is a refusal in words that name nothing, and leaves no lease", async () => {
    // a connection whose token the mock does not know: GitLab says 401
    const org = await createOrganization(t.db, { slug: "badtoken", name: "b" });
    await createConnection(t.db, keys, {
      organizationId: org.id,
      type: "gitlab",
      name: "bad",
      config: { baseUrl: mock.url },
      token: "glpat-not-a-token-of-the-mock",
    });
    const p = await createProject(t.db, {
      organizationId: org.id,
      name: "x",
      gitlabProjectId: remote.p1,
    });
    roleTable.set(701, {
      orgRoles: { [ids.o1]: "admin", [org.id]: "admin" },
      projectRoles: {},
    });
    const res = await take("alice", undefined, leases(org.id, p.id));
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("lease_denied");
    expect(res.text).not.toContain("glpat");
    expect(await t.db.select().from(secretLeases).where(eq(secretLeases.projectId, p.id))).toEqual(
      [],
    );
  });

  test("the cap per principal is a 429 of its own, and counts the person whichever way they come", async () => {
    const principal = `user:${people.bob.id}`;
    const start = (over = {}) =>
      startLease(t.db, {
        organizationId: ids.o1,
        projectId: ids.p1,
        principal,
        provider: "gitlab-token",
        connectionId: crypto.randomUUID(),
        remoteProjectId: remote.p1,
        scopes: ["read_repository"],
        expiresAt: new Date(Date.now() + HOUR),
        ...over,
      });
    for (let i = 0; i < LEASES_PER_PRINCIPAL; i++) await start();
    const before = requests();
    for (const who of ["bob", await apiToken("bob", ["lease.issue"])] as const) {
      const res = await take(who);
      expect([res.status, res.json.code]).toEqual([429, "too_many_leases"]);
    }
    expect(requests()).toBe(before);
    // somebody else is unaffected
    expect((await take("alice")).status).toBe(201);
  });

  test("it is rate limited per caller, with the time to wait", async () => {
    const strict = makeApp(0.1); // two a minute
    const answers = [];
    for (let i = 0; i < 3; i++) answers.push(await take("carol", undefined, undefined));
    expect(answers.map((a) => a.status)).toEqual([403, 403, 403]); // not allowed is not counted as one asked
    const bobs = [];
    for (let i = 0; i < 3; i++)
      bobs.push(await call("bob", "POST", leases(), { scopes: ["read_repository"] }, strict));
    expect(bobs.map((r) => r.status)).toEqual([201, 201, 429]);
    expect(bobs[2]?.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(bobs[2]?.json.code).toBe("rate_limited");
  });
});

describe("listing and ending leases", () => {
  test("a list is in pages, shows who holds what and never a value", async () => {
    const made = [await take("bob"), await take("alice"), await take("bob")];
    const first = await call("carol", "GET", `${leases()}?limit=2`);
    expect(first.json.items.map((l: { id: string }) => l.id)).toEqual(
      made.slice(0, 2).map((m) => m.json.id),
    );
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const second = await call(
      "carol",
      "GET",
      `${leases()}?limit=2&cursor=${first.json.nextCursor}`,
    );
    expect(second.json.items.map((l: { id: string }) => l.id)).toEqual([made[2]?.json.id]);
    expect(second.json.nextCursor).toBeNull();
    for (const m of made) {
      expect(first.text + second.text).not.toContain(m.json.value);
    }
    expect(first.text).not.toContain("handle");
    expect(first.json.items[0].principal).toBe(`user:${people.bob.id}`);
    // another project's list is empty
    expect((await call("alice", "GET", leases(ids.o1, ids.p3))).json.items).toEqual([]);
  });

  test("any developer ends a lease: the token dies, it is audited once, and a second try says so", async () => {
    const made = await take("alice");
    const { id, value } = made.json;
    expect(mock.accessTokenValid(value)).toBe(true);

    const res = await call("bob", "DELETE", `${leases()}/${id}`);
    expect(res.status).toBe(204);
    expect(mock.accessTokenValid(value)).toBe(false);
    const events = (await rows("lease.revoke")).filter((e) => e.resourceId === id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorKind: "user",
      actorId: people.bob.id,
      projectId: ids.p1,
    });

    const again = await call("bob", "DELETE", `${leases()}/${id}`);
    expect([again.status, again.json.code]).toEqual([409, "lease_ended"]);
    expect((await rows("lease.revoke")).filter((e) => e.resourceId === id)).toHaveLength(1);
    const list = await call("bob", "GET", leases());
    expect(list.json.items.find((l: { id: string }) => l.id === id).revokedAt).toEqual(
      expect.any(String),
    );
  });

  test("a lease is found only under its own project and organization", async () => {
    const { id } = (await take("alice")).json;
    expect((await call("alice", "DELETE", `${leases(ids.o1, ids.p3)}/${id}`)).status).toBe(404);
    expect((await call("alice", "DELETE", `${leases()}/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call("alice", "DELETE", `${leases()}/not-an-id`)).status).toBe(422);
    expect((await call("erin", "DELETE", `${leases()}/${id}`)).status).toBe(404);
  });

  test("a revoke GitLab cannot do leaves the lease live, and says so without GitLab's words", async () => {
    const { id, value } = (await take("alice")).json;
    const broken = createApp({
      logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
      db: t.db,
      principal: callerPrincipal({
        db: t.db,
        roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
      }),
      ready: async () => {},
      leasers: new Map([
        [
          "gitlab-token",
          {
            type: "gitlab-token",
            issue: async () => {
              throw new Error("unused");
            },
            revoke: async () => {
              throw new (await import("@orch/rotation")).RotationError(
                "failed",
                "GitLab said CANARYWORDS",
              );
            },
          },
        ],
      ]),
    });
    const res = await call("alice", "DELETE", `${leases()}/${id}`, undefined, broken);
    expect([res.status, res.json.code]).toEqual([502, "lease_failed"]);
    expect(res.text).not.toContain("CANARYWORDS");
    expect(mock.accessTokenValid(value)).toBe(true);
    const [row] = await t.db.select().from(secretLeases).where(eq(secretLeases.id, id));
    expect(row?.revokedAt).toBeNull();
  });
});

describe("a CI job", () => {
  test("with the scope takes a lease as its job, and ends its own and no one else's", async () => {
    const job = await ciToken({ job: 9001 });
    const made = await take(job);
    expect(made.status).toBe(201);
    expect(made.json.principal).toBe(`ci:${ids.p1}:job-9001`);
    expect(mock.accessTokenValid(made.json.value)).toBe(true);
    const [event] = (await rows("lease.issue")).filter((e) => e.resourceId === made.json.id);
    expect(event).toMatchObject({ actorKind: "ci", projectId: ids.p1 });

    // the scopes name `lease.issue` and `lease.revoke` only: it does not read the list
    expect((await call(job, "GET", leases())).status).toBe(403);

    const theirs = (await take("alice")).json.id;
    expect((await call(job, "DELETE", `${leases()}/${theirs}`)).status).toBe(404);
    // another token of the same job is the same holder
    const again = await ciToken({ job: 9001 });
    expect((await call(again, "DELETE", `${leases()}/${made.json.id}`)).status).toBe(204);
    expect(mock.accessTokenValid(made.json.value)).toBe(false);
  });

  test("a second token for the same job does not get a second allowance", async () => {
    for (let i = 0; i < LEASES_PER_PRINCIPAL; i++) {
      await startLease(t.db, {
        organizationId: ids.o1,
        projectId: ids.p1,
        principal: `ci:${ids.p1}:job-77`,
        provider: "gitlab-token",
        connectionId: crypto.randomUUID(),
        remoteProjectId: remote.p1,
        scopes: ["read_repository"],
        expiresAt: new Date(Date.now() + HOUR),
      });
    }
    for (const bearer of [await ciToken({ job: 77 }), await ciToken({ job: 77 })]) {
      const res = await take(bearer);
      expect([res.status, res.json.code]).toEqual([429, "too_many_leases"]);
    }
    expect((await take(await ciToken({ job: 78 }))).status).toBe(201);
  });

  test("holds a lease no longer than its own token lives, and none when that is under the shortest lease", async () => {
    const MIN = 60_000;
    const short = await take(await ciToken({ ttlMs: 5 * MIN }), {
      scopes: ["read_repository"],
      ttlSeconds: 3600,
    });
    expect(short.status).toBe(201);
    const ends = Date.parse(short.json.expiresAt) - Date.now();
    expect(ends).toBeLessThanOrEqual(5 * MIN);
    expect(ends).toBeGreaterThan(4 * MIN);
    // a lease within the token's life is as asked
    const within = await take(await ciToken({ ttlMs: HOUR }), {
      scopes: ["read_repository"],
      ttlSeconds: 600,
    });
    expect(Date.parse(within.json.expiresAt) - Date.now()).toBeGreaterThan(590_000);

    const before = requests();
    const ending = await take(await ciToken({ ttlMs: 30_000 }));
    expect([ending.status, ending.json.code]).toEqual([409, "ci_token_ending"]);
    expect(requests()).toBe(before);
  });

  test("without the scope, in an environment, or for another project, it gets nothing", async () => {
    const before = requests();
    const plain = await ciToken({ scopes: ["project.read", "run.summary"] });
    expect((await take(plain)).status).toBe(403);
    // tied to an environment, a job reaches nothing but that environment's own resources
    const tied = await ciToken({
      environment: ids.dev,
      scopes: ["project.read", "environment.read", "secret.reveal", "lease.issue", "lease.revoke"],
    });
    expect((await take(tied)).status).toBe(403);
    // its project's token on another project of the same organization: not even visible
    const other = await ciToken({ project: ids.p3 });
    for (const r of [
      await take(other),
      await call(other, "DELETE", `${leases()}/${crypto.randomUUID()}`),
    ]) {
      expect(r.status).toBe(404);
    }
    expect(requests()).toBe(before);
  });
});

test("no value is in any answer, audit event, lease row or log line (leak canary)", async () => {
  const values: string[] = [];
  for (const who of [
    "bob",
    "alice",
    await ciToken({ job: 5 }),
    await apiToken("bob", ["lease.*"]),
  ] as const) {
    const res = await take(who);
    expect(res.status).toBe(201);
    values.push(res.json.value);
  }
  // end two of them, list, and read the table back
  for (const l of (await call("alice", "GET", leases())).json.items.slice(0, 2)) {
    await call("alice", "DELETE", `${leases()}/${l.id}`);
  }
  const everything = [
    JSON.stringify(await t.db.select().from(secretLeases)),
    JSON.stringify(await t.db.select().from(auditEvents)),
    lines.join("\n"),
    // every answer but the four that carried a value, once each
    ...seen.filter((s) => !values.some((v) => s.includes(v))),
  ].join("\n");
  for (const v of values) expect(everything.includes(v)).toBe(false);
  // and the four answers that did carry one carried only their own
  for (const s of seen.filter((x) => values.some((v) => x.includes(v)))) {
    expect(values.filter((v) => s.includes(v))).toHaveLength(1);
  }
});
