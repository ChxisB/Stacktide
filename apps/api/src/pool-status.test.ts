import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createPool,
  createProject,
  createSession,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab } from "@orch/gitlab/mock";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let conn1: string;
let conn2: string;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"admin" | "maintainer" | "member" | "outsider", string>;
let app: ReturnType<typeof makeApp>;
const makeApp = () =>
  createApp({
    logger: createLogger({ level: "debug", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
  });
const projectRoles: Record<string, "maintainer"> = {};

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  const connect = async (organizationId: string) =>
    (
      await createConnection(t.db, keys, {
        organizationId,
        type: "gitlab",
        name: "live",
        config: { baseUrl: mock.url },
        token: mock.token,
      })
    ).id;
  conn1 = await connect(o1);
  conn2 = await connect(o2);
  let gitlabId = 1100;
  for (const [name, roles] of [
    ["admin", { orgRoles: { [o1]: "admin" }, projectRoles: {} }],
    ["maintainer", { orgRoles: { [o1]: "member" }, projectRoles }],
    ["member", { orgRoles: { [o1]: "member" }, projectRoles: {} }],
    ["outsider", { orgRoles: { [o2]: "admin" }, projectRoles: {} }],
  ] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = `orch_session=${session}`;
    roleTable.set(gitlabId, roles as Roles);
  }
  app = makeApp();
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

async function call(who: keyof typeof people | undefined, path: string) {
  const res = await app.handle(
    new Request(`http://localhost${path}`, { headers: who ? { cookie: people[who] } : {} }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

let n = 0;
/** A project on a GitLab project of its own, and a pool asking for `tags`. */
async function world(tags: string[] = ["prod-runners"], linked = true) {
  const id = ++n;
  const gl = mock.addProject({ path: `pools/p${id}` });
  const project = await createProject(t.db, {
    organizationId: o1,
    name: `p${id}`,
    ...(linked && { gitlabProjectId: gl.id }),
  });
  const pool = await t.db.transaction((tx) =>
    createPool(tx, { organizationId: o1, name: `pool-${id}`, tags }),
  );
  if (!pool) throw new Error("no pool");
  const url = (c = conn1, p = pool.id, org = o1, proj = project.id) =>
    `/organizations/${org}/projects/${proj}/pools/${p}/status?connectionId=${c}`;
  const asked = () => mock.requests.filter((r) => r.path === `/api/v4/projects/${gl.id}/runners`);
  return { gl, project, pool, url, asked, path: gl.path };
}

describe("a pool's health, as GitLab shows it for a project (POOL-4)", () => {
  test("every runner with the pool's tags online: healthy, counted, nothing else shown", async () => {
    const w = await world(["prod-runners"]);
    mock.addRunner(w.path, { tags: ["prod-runners"] });
    mock.addRunner(w.path, { tags: ["prod-runners", "gpu"] });
    mock.addRunner(w.path, { tags: ["other"], status: "offline" });
    const res = await call("admin", w.url());
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      poolId: w.pool.id,
      tags: ["prod-runners"],
      state: "healthy",
      online: 2,
      total: 2,
      reason: null,
    });
  });

  test("none online: offline, with how many there are", async () => {
    const w = await world();
    mock.addRunner(w.path, { tags: ["prod-runners"], status: "offline" });
    mock.addRunner(w.path, { tags: ["prod-runners"], status: "offline" });
    expect((await call("admin", w.url())).json).toMatchObject({
      state: "offline",
      online: 0,
      total: 2,
    });
  });

  test("some online: degraded; a paused runner is not usable; stale and never-contacted ones are not counted", async () => {
    const w = await world();
    mock.addRunner(w.path, { tags: ["prod-runners"] });
    mock.addRunner(w.path, { tags: ["prod-runners"], paused: true });
    mock.addRunner(w.path, { tags: ["prod-runners"], status: "offline" });
    mock.addRunner(w.path, { tags: ["prod-runners"], status: "stale" });
    mock.addRunner(w.path, { tags: ["prod-runners"], status: "never_contacted" });
    expect((await call("admin", w.url())).json).toMatchObject({
      state: "degraded",
      online: 1,
      total: 3,
    });
  });

  test("a runner needs every one of the pool's tags", async () => {
    const w = await world(["a", "b"]);
    mock.addRunner(w.path, { tags: ["a"] });
    mock.addRunner(w.path, { tags: ["b"] });
    expect((await call("admin", w.url())).json).toMatchObject({
      state: "offline",
      online: 0,
      total: 0,
    });
    mock.addRunner(w.path, { tags: ["a", "b", "c"] });
    expect((await call("admin", w.url())).json).toMatchObject({ state: "healthy", online: 1 });
  });

  test("the answer holds no runner address, description or token, whatever GitLab sends", async () => {
    const w = await world();
    mock.addRunner(w.path, {
      tags: ["prod-runners"],
      description: "runner-canary-description",
      ipAddress: "10.77.77.77",
    });
    const res = await call("admin", w.url());
    expect(res.status).toBe(200);
    for (const secret of ["runner-canary-description", "10.77.77.77", mock.token]) {
      expect(res.text).not.toContain(secret);
    }
    expect(Object.keys(res.json).sort()).toEqual(
      ["online", "poolId", "reason", "state", "tags", "total"].sort(),
    );
  });

  test("a token without the permission gives unknown, never healthy", async () => {
    const w = await world();
    mock.addRunner(w.path, { tags: ["prod-runners"] });
    mock.inject({ method: "GET", path: `/api/v4/projects/${w.gl.id}/runners`, status: 403 });
    expect((await call("admin", w.url())).json).toEqual({
      poolId: w.pool.id,
      tags: ["prod-runners"],
      state: "unknown",
      online: 0,
      total: 0,
      reason: "not_permitted",
    });
    mock.inject({ method: "GET", path: `/api/v4/projects/${w.gl.id}/runners`, status: 401 });
    expect((await call("admin", w.url())).json).toMatchObject({
      state: "unknown",
      reason: "not_permitted",
    });
  });

  test("GitLab failing gives unknown too, and GitLab having no such project says so", async () => {
    const w = await world();
    mock.inject({
      method: "GET",
      path: `/api/v4/projects/${w.gl.id}/runners`,
      status: 502,
      times: 5,
    });
    expect((await call("admin", w.url())).json).toMatchObject({
      state: "unknown",
      reason: "unavailable",
    });
    const gone = await world();
    // the project row points at a GitLab project that does not exist
    const missing = await createProject(t.db, {
      organizationId: o1,
      name: "gone",
      gitlabProjectId: 987_654_321,
    });
    expect((await call("admin", gone.url(conn1, gone.pool.id, o1, missing.id))).json).toMatchObject(
      {
        state: "unknown",
        reason: "unlinked",
      },
    );
  });

  test("a project that is not on GitLab asks GitLab nothing and is unknown", async () => {
    const w = await world(["prod-runners"], false);
    const before = mock.requests.length;
    const res = await call("admin", w.url());
    expect(res.json).toMatchObject({ state: "unknown", reason: "unlinked", online: 0, total: 0 });
    expect(mock.requests.length).toBe(before);
  });

  test("reading it writes nothing to the audit log", async () => {
    const w = await world();
    mock.addRunner(w.path, { tags: ["prod-runners"] });
    const before = (await t.db.select().from(auditEvents)).length;
    await call("admin", w.url());
    expect((await t.db.select().from(auditEvents)).length).toBe(before);
  });
});

describe("who may ask, and for what", () => {
  test("an organization admin: yes. A project maintainer or member: no, because it uses the organization's connection", async () => {
    const w = await world();
    projectRoles[w.project.id] = "maintainer";
    expect((await call("admin", w.url())).status).toBe(200);
    expect((await call("maintainer", w.url())).status).toBe(403);
    expect((await call("member", w.url())).status).toBe(403);
  });

  test("no session is 401; another organization's admin sees nothing of it", async () => {
    const w = await world();
    expect((await call(undefined, w.url())).status).toBe(401);
    expect((await call("outsider", w.url())).status).toBe(404);
    expect(w.asked()).toHaveLength(0);
  });

  test("another organization's pool, project or connection, an unknown pool and a missing connection id do not reach GitLab", async () => {
    const w = await world();
    const stranger = (await createOrganization(t.db, { slug: "three", name: "Three" })).id;
    const foreign = await t.db.transaction((tx) =>
      createPool(tx, { organizationId: stranger, name: "theirs", tags: ["x"] }),
    );
    const bad = [
      w.url(conn1, foreign?.id),
      w.url(conn1, "0190b2a0-0000-7000-8000-000000000000"),
      w.url(conn2),
      `/organizations/${o1}/projects/${w.project.id}/pools/${w.pool.id}/status`,
    ];
    const statuses = [];
    for (const path of bad) statuses.push((await call("admin", path)).status);
    expect(statuses).toEqual([404, 404, 404, 422]);
    expect(w.asked()).toHaveLength(0);
  });
});
