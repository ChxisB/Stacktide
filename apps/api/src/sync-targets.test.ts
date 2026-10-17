import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  deleteEnvironment,
  syncTargets,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
// What a connection holds and a target must never show.
const TOKEN = "glpat-CANARY-CONNECTION-TOKEN-0123456789";

let t: TestDb;
let o1: string;
let o2: string;
let p1: string;
let p2: string;
let px: string;
let conn: string;
let otherType: string;
let foreign: string;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol" | "dave", { id: string; cookie: string }>;
let app: ReturnType<typeof makeApp>;

const makeApp = () =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
  });

beforeAll(async () => {
  t = await createTestDb();
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  p1 = (await createProject(t.db, { organizationId: o1, name: "api" })).id;
  p2 = (await createProject(t.db, { organizationId: o1, name: "web" })).id;
  px = (await createProject(t.db, { organizationId: o2, name: "other" })).id;
  for (const slug of ["dev", "prod", "stage"]) {
    await createEnvironment(t.db, { organizationId: o1, projectId: p1, name: slug, slug });
  }
  const seal = (organizationId: string, type: string) =>
    createConnection(t.db, keys, { organizationId, type, name: `c-${type}`, token: TOKEN });
  conn = (await seal(o1, "gitlab")).id;
  otherType = (await seal(o1, "other")).id;
  foreign = (await seal(o2, "gitlab")).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob", "carol", "dave"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [o1]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(902, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob
  roleTable.set(903, { orgRoles: {}, projectRoles: { [p1]: "reporter" } }); // carol
  // dave: nothing
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

const seen: string[] = [];
async function call(
  who: keyof typeof people | undefined,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(
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
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const base = (org = o1, project = p1) => `/organizations/${org}/projects/${project}/sync-targets`;
let n = 0;
const body = (over: object = {}) => ({
  name: `t${++n}`,
  type: "gitlab-variables",
  connectionId: conn,
  config: { project: 7 },
  ...over,
});
const create = async (over: object = {}) => {
  const res = await call("alice", "POST", base(), body(over));
  expect(res.status).toBe(201);
  return res.json as { id: string; name: string };
};
const rows = () => t.db.select().from(syncTargets);
const events = (id: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, id));

describe("creating a target", () => {
  test("stores it with the defaults and answers with no credential", async () => {
    const res = await call(
      "alice",
      "POST",
      base(),
      body({ name: "  main  ", config: { project: 7 } }),
    );
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: o1,
      projectId: p1,
      name: "main",
      type: "gitlab-variables",
      connectionId: conn,
      config: { project: 7 },
      environmentMapping: {},
      unmanagedPolicy: "ignore",
      autoSync: false,
      autoRemediate: false,
    });
    expect(Object.keys(res.json).sort()).toEqual(
      [
        "autoRemediate",
        "autoSync",
        "config",
        "connectionId",
        "createdAt",
        "environmentMapping",
        "id",
        "name",
        "organizationId",
        "projectId",
        "type",
        "unmanagedPolicy",
        "updatedAt",
      ].sort(),
    );
  });

  test("keeps what it is given, and drops what the type does not know from a valid config", async () => {
    const res = await call(
      "alice",
      "POST",
      base(),
      body({
        config: { group: "acme/ops", protected: true },
        environmentMapping: { prod: "production", dev: "development" },
        unmanagedPolicy: "prune",
        autoSync: true,
        autoRemediate: true,
      }),
    );
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      config: { group: "acme/ops", protected: true },
      environmentMapping: { prod: "production", dev: "development" },
      unmanagedPolicy: "prune",
      autoSync: true,
      autoRemediate: true,
    });
  });

  test("is audited with ids and settings, and the connection's token is nowhere", async () => {
    const res = await call("alice", "POST", base(), body({ unmanagedPolicy: "adopt" }));
    const [e, ...more] = await events(res.json.id);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      action: "sync_target.create",
      resourceType: "sync_target",
      organizationId: o1,
      projectId: p1,
      actorId: people.alice.id,
      metadata: {
        name: res.json.name,
        type: "gitlab-variables",
        connectionId: conn,
        unmanagedPolicy: "adopt",
        autoSync: false,
      },
    });
  });

  test("an invalid config is a 422 that names the shape and never echoes the config", async () => {
    const canary = "glpat-CONFIG-CANARY-0123456789";
    const before = (await rows()).length;
    const bad = [{}, { project: 7, token: canary }, { project: canary, group: 3 }, { project: 0 }];
    for (const config of bad) {
      const res = await call("alice", "POST", base(), body({ config }));
      expect([res.status, res.json.code]).toEqual([422, "invalid_config"]);
      expect(res.text).not.toContain(canary);
    }
    expect((await rows()).length).toBe(before);
  });

  test("refuses an unknown type, an unknown field and a type given as a different case", async () => {
    for (const over of [
      { type: "nope" },
      { type: "GitLab-Variables" },
      { extra: 1 },
      { token: TOKEN },
      { unmanagedPolicy: "delete" },
      { autoSync: "yes" },
      { autoRemediate: "yes" },
      { name: "   " },
      { connectionId: "not-a-uuid" },
    ]) {
      const res = await call("alice", "POST", base(), body(over));
      expect([over, res.status]).toEqual([over, 422]);
    }
  });

  test("the connection must be in this organization and of the kind the type needs", async () => {
    const gone = await call("alice", "POST", base(), body({ connectionId: foreign }));
    expect([gone.status, gone.json.code]).toEqual([422, "unknown_connection"]);
    const missing = await call("alice", "POST", base(), body({ connectionId: Bun.randomUUIDv7() }));
    expect([missing.status, missing.json.code]).toEqual([422, "unknown_connection"]);
    const wrong = await call("alice", "POST", base(), body({ connectionId: otherType }));
    expect([wrong.status, wrong.json.code]).toEqual([422, "connection_type_mismatch"]);
  });

  test("a mapping names environments of this project, with distinct scopes that are not *", async () => {
    const unknown = await call("alice", "POST", base(), body({ environmentMapping: { qa: "qa" } }));
    expect([unknown.status, unknown.json.code]).toEqual([422, "unknown_environment"]);
    for (const environmentMapping of [
      { prod: "*" },
      { prod: "" },
      { prod: "  " },
      { prod: "x".repeat(256) },
      { prod: "same", dev: "same" },
      { "Not A Slug": "x" },
      { prod: 5 },
    ]) {
      const res = await call("alice", "POST", base(), body({ environmentMapping }));
      expect([environmentMapping, res.status]).toEqual([environmentMapping, 422]);
    }
    // another project's environments are not this one's
    const elsewhere = await call(
      "alice",
      "POST",
      base(o1, p2),
      body({ environmentMapping: { prod: "p" } }),
    );
    expect([elsewhere.status, elsewhere.json.code]).toEqual([422, "unknown_environment"]);
  });

  test("a mapping holds at most 100 environments", async () => {
    const slugs = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`e${i}`, `scope-${i}`]));
    const over = await call("alice", "POST", base(), body({ environmentMapping: slugs(101) }));
    expect([over.status, over.json.code]).toEqual([422, "validation_failed"]);
    // 100 passes the shape and then fails on the environments, which do not exist
    const edge = await call("alice", "POST", base(), body({ environmentMapping: slugs(100) }));
    expect([edge.status, edge.json.code]).toEqual([422, "unknown_environment"]);
  });

  test("a project that does not exist is a 404, also for an org admin", async () => {
    const none = Bun.randomUUIDv7();
    expect((await call("alice", "GET", base(o1, none))).status).toBe(404);
    expect((await call("alice", "POST", base(o1, none), body())).status).toBe(404);
  });

  test("a name is unique within the project", async () => {
    await create({ name: "dup" });
    const again = await call("alice", "POST", base(), body({ name: "dup" }));
    expect([again.status, again.json.code]).toEqual([409, "name_taken"]);
    expect((await call("alice", "POST", base(o1, p2), body({ name: "dup" }))).status).toBe(201);
  });

  test("a refused request stores nothing and writes no audit row", async () => {
    const [targetsBefore, eventsBefore] = [
      (await rows()).length,
      (await t.db.select().from(auditEvents)).length,
    ];
    await call("alice", "POST", base(), body({ connectionId: foreign }));
    await call("alice", "POST", base(), body({ config: {} }));
    await call("alice", "POST", base(), body({ environmentMapping: { qa: "qa" } }));
    await call("bob", "POST", base(), body());
    expect((await rows()).length).toBe(targetsBefore);
    expect((await t.db.select().from(auditEvents)).length).toBe(eventsBefore);
  });
});

describe("reading targets", () => {
  test("lists in creation order, a page at a time", async () => {
    const [a, b, c] = [await create(), await create(), await create()];
    const elsewhere = (await call("alice", "GET", base(o1, p2))).json.items;
    expect(elsewhere.map((x: { id: string }) => x.id)).not.toContain(a.id);
    const all = (await call("alice", "GET", `${base()}?limit=100`)).json.items.map(
      (x: { id: string }) => x.id,
    );
    const at = all.indexOf(a.id);
    expect(all.slice(at, at + 3)).toEqual([a.id, b.id, c.id]);
    const first = await call("alice", "GET", `${base()}?limit=2`);
    expect(first.json.items).toHaveLength(2);
    expect(first.json.nextCursor).toBeString();
    const next = await call("alice", "GET", `${base()}?limit=2&cursor=${first.json.nextCursor}`);
    expect(next.json.items[0].id).toBe(all[2]);
    expect((await call("alice", "GET", `${base()}?cursor=garbage`)).status).toBe(400);
  });

  test("gets one, and only through its own organization and project", async () => {
    const x = await create();
    const got = await call("alice", "GET", `${base()}/${x.id}`);
    expect(got.json).toMatchObject({ id: x.id, name: x.name });
    for (const path of [
      `${base(o1, p2)}/${x.id}`,
      `${base(o2, px)}/${x.id}`,
      `${base(o2, p1)}/${x.id}`,
    ]) {
      expect([path, (await call("alice", "GET", path)).status]).toEqual([path, 404]);
    }
    expect((await call("alice", "GET", `${base()}/${Bun.randomUUIDv7()}`)).status).toBe(404);
  });
});

describe("changing a target", () => {
  test("changes only what is named, validated like a create", async () => {
    const x = await create({ config: { project: 7 }, unmanagedPolicy: "adopt" });
    const res = await call("alice", "PATCH", `${base()}/${x.id}`, {
      name: "renamed",
      config: { group: 3 },
      environmentMapping: { prod: "production" },
      autoSync: true,
      autoRemediate: true,
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: x.id,
      name: "renamed",
      type: "gitlab-variables",
      config: { group: 3 },
      environmentMapping: { prod: "production" },
      unmanagedPolicy: "adopt", // untouched
      autoSync: true,
      autoRemediate: true,
      connectionId: conn,
    });
    const [e] = (await events(x.id)).filter((v) => v.action === "sync_target.update");
    expect(e?.metadata).toMatchObject({
      name: "renamed",
      fields: ["name", "config", "environmentMapping", "autoSync", "autoRemediate"],
      autoSync: true,
      autoRemediate: true,
    });
  });

  test("re-pointing a target at another connection is in the audit row", async () => {
    const x = await create();
    const second = await createConnection(t.db, keys, {
      organizationId: o1,
      type: "gitlab",
      name: "second",
      token: TOKEN,
    });
    await call("alice", "PATCH", `${base()}/${x.id}`, { connectionId: second.id });
    const [e] = (await events(x.id)).filter((v) => v.action === "sync_target.update");
    expect(e?.metadata).toMatchObject({ fields: ["connectionId"], connectionId: second.id });
  });

  test("turning on prune is in the audit row", async () => {
    const x = await create();
    await call("alice", "PATCH", `${base()}/${x.id}`, { unmanagedPolicy: "prune" });
    const [e] = (await events(x.id)).filter((v) => v.action === "sync_target.update");
    expect(e?.metadata).toMatchObject({ fields: ["unmanagedPolicy"], unmanagedPolicy: "prune" });
  });

  test("refuses the type, nothing, and what a create would refuse", async () => {
    const x = await create();
    const url = `${base()}/${x.id}`;
    const refused: [object, number, string?][] = [
      [{ type: "other" }, 422],
      [{}, 422],
      [{ token: TOKEN }, 422],
      [{ config: { project: 7, token: TOKEN } }, 422, "invalid_config"],
      [{ connectionId: foreign }, 422, "unknown_connection"],
      [{ connectionId: otherType }, 422, "connection_type_mismatch"],
      [{ environmentMapping: { qa: "q" } }, 422, "unknown_environment"],
      [{ environmentMapping: { prod: "*" } }, 422],
    ];
    for (const [patch, status, code] of refused) {
      const res = await call("alice", "PATCH", url, patch);
      expect([patch, res.status]).toEqual([patch, status]);
      if (code) expect(res.json.code).toBe(code);
    }
    expect((await call("alice", "GET", url)).json).toMatchObject({
      name: x.name,
      config: { project: 7 },
    });
    expect(await events(x.id)).toHaveLength(1); // only the create
  });

  test("a name taken in the project is a 409", async () => {
    const [a, b] = [await create(), await create()];
    const res = await call("alice", "PATCH", `${base()}/${a.id}`, { name: b.name });
    expect([res.status, res.json.code]).toEqual([409, "name_taken"]);
    expect((await call("alice", "PATCH", `${base()}/${a.id}`, { name: a.name })).status).toBe(200);
  });

  test("an old mapping to a since-deleted environment does not block an unrelated change", async () => {
    const env = await createEnvironment(t.db, {
      organizationId: o1,
      projectId: p1,
      name: "tmp",
      slug: "tmp",
    });
    const x = await create({ environmentMapping: { tmp: "temporary" } });
    await deleteEnvironment(t.db, o1, p1, env.id);
    const res = await call("alice", "PATCH", `${base()}/${x.id}`, { autoSync: true });
    expect(res.status).toBe(200);
    expect(res.json.environmentMapping).toEqual({ tmp: "temporary" });
    const again = await call("alice", "PATCH", `${base()}/${x.id}`, {
      environmentMapping: { tmp: "t" },
    });
    expect([again.status, again.json.code]).toEqual([422, "unknown_environment"]);
  });

  test("an unknown target, or one of another project, is a 404", async () => {
    const x = await create();
    expect(
      (await call("alice", "PATCH", `${base()}/${Bun.randomUUIDv7()}`, { autoSync: true })).status,
    ).toBe(404);
    expect(
      (await call("alice", "PATCH", `${base(o1, p2)}/${x.id}`, { autoSync: true })).status,
    ).toBe(404);
    expect((await call("alice", "GET", `${base()}/${x.id}`)).json.autoSync).toBe(false);
  });
});

describe("deleting a target", () => {
  test("removes it once, and is audited", async () => {
    const x = await create();
    expect((await call("alice", "DELETE", `${base()}/${x.id}`)).status).toBe(204);
    expect((await call("alice", "DELETE", `${base()}/${x.id}`)).status).toBe(404);
    expect((await call("alice", "GET", `${base()}/${x.id}`)).status).toBe(404);
    const log = await events(x.id);
    expect(log.map((e) => e.action).sort()).toEqual(["sync_target.create", "sync_target.delete"]);
    expect(log.find((e) => e.action === "sync_target.delete")?.metadata).toEqual({
      name: x.name,
      type: "gitlab-variables",
    });
  });

  test("a connection in use cannot be deleted until its targets are", async () => {
    const own = await createConnection(t.db, keys, {
      organizationId: o1,
      type: "gitlab",
      name: "busy",
      token: TOKEN,
    });
    const x = await create({ connectionId: own.id });
    const url = `/organizations/${o1}/connections/${own.id}`;
    const refused = await call("alice", "DELETE", url);
    expect([refused.status, refused.json.code]).toEqual([409, "connection_in_use"]);
    expect((await call("alice", "DELETE", `${base()}/${x.id}`)).status).toBe(204);
    expect((await call("alice", "DELETE", url)).status).toBe(204);
  });

  test("a project's targets go with it", async () => {
    const gone = await createProject(t.db, { organizationId: o1, name: "short-lived" });
    const x = await call("alice", "POST", base(o1, gone.id), body());
    expect(x.status).toBe(201);
    expect((await call("alice", "DELETE", `/organizations/${o1}/projects/${gone.id}`)).status).toBe(
      204,
    );
    expect((await rows()).filter((r) => r.projectId === gone.id)).toEqual([]);
  });
});

describe("who may", () => {
  test("anyone who can read the project reads targets; only org admins change them", async () => {
    const x = await create();
    for (const who of ["alice", "bob", "carol"] as const) {
      expect([who, (await call(who, "GET", base())).status]).toEqual([who, 200]);
      expect([who, (await call(who, "GET", `${base()}/${x.id}`)).status]).toEqual([who, 200]);
    }
    for (const who of ["bob", "carol"] as const) {
      const attempts = [
        call(who, "POST", base(), body()),
        call(who, "PATCH", `${base()}/${x.id}`, { autoSync: true }),
        call(who, "DELETE", `${base()}/${x.id}`),
      ];
      for (const res of await Promise.all(attempts)) {
        expect([who, res.status, res.json.code]).toEqual([who, 403, "forbidden"]);
      }
    }
    expect((await call("alice", "GET", `${base()}/${x.id}`)).json.autoSync).toBe(false);
  });

  test("someone who cannot see the project gets a 404, and no one signed in a 401", async () => {
    const x = await create();
    for (const [method, path, payload] of [
      ["GET", base(), undefined],
      ["GET", `${base()}/${x.id}`, undefined],
      ["POST", base(), body()],
      ["PATCH", `${base()}/${x.id}`, { autoSync: true }],
      ["DELETE", `${base()}/${x.id}`, undefined],
    ] as const) {
      expect([method, (await call("dave", method, path, payload)).status]).toEqual([method, 404]);
      expect([method, (await call(undefined, method, path, payload)).status]).toEqual([
        method,
        401,
      ]);
    }
  });

  test("an org admin of one organization has no say in another's targets", async () => {
    const res = await call("alice", "POST", base(o2, px), body({ connectionId: foreign }));
    expect(res.status).toBe(404);
    expect((await call("alice", "GET", base(o2, px))).status).toBe(404);
  });
});

test("no response, audit row or log line holds the connection's token", async () => {
  const audit = JSON.stringify(await t.db.select().from(auditEvents));
  const stored = JSON.stringify(await rows());
  expect(seen.length).toBeGreaterThan(50);
  expect([...seen, audit, stored, ...lines].filter((s) => s.includes(TOKEN))).toEqual([]);
});
