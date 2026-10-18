import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type BulkOp, CHANGE_REQUEST_MAX_OPEN, createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  changeRequests,
  createApiToken,
  createChangeRequest,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  setEnvironmentProtection,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { createApp } from "./app";
import { changeRequestExpireHandler } from "./change-request-expire";
import { callerPrincipal } from "./credentials";
import { devPrincipal } from "./principal";
import { hashToken, newApiToken, randomToken } from "./tokens";
import type { JobContext } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
type Who = "alice" | "bob" | "carol" | "dave" | "erin" | "gina";
let t: TestDb;
const roleTable = new Map<number, Roles>();
const people = {} as Record<Who, { id: string; cookie: string }>;
const ids = {} as Record<"o1" | "o2" | "p1" | "p2", string>;
const tokens = {} as Record<"read" | "approve" | "create", string>;

const makeApp = (
  provider: typeof keys | undefined,
  principal = callerPrincipal({
    db: t.db,
    roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
  }),
) =>
  createApp({
    logger: createLogger({ level: "debug", write: () => {} }),
    db: t.db,
    principal,
    ready: async () => {},
    keys: provider,
  });
let app: ReturnType<typeof makeApp>;

/** Every answer, searched for values at the end. */
const seen: { text: string; reveal: boolean }[] = [];
async function call(
  who: Who | { bearer: string } | null,
  method: string,
  path: string,
  body?: unknown,
  application = app,
  contentType = "application/json",
) {
  const headers: Record<string, string> = {};
  if (typeof who === "string") headers.cookie = people[who].cookie;
  else if (who) headers.authorization = `Bearer ${who.bearer}`;
  if (body !== undefined) headers["content-type"] = contentType;
  const res = await application.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  seen.push({ text, reveal: method === "GET" && /\/value(\?|$)/.test(path) });
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined) as any,
  };
}

const markers: string[] = [];
let n = 0;
const sekrit = (label: string) => {
  const marker = `SEKRIT-${label}-${++n}-${Bun.randomUUIDv7()}`;
  markers.push(marker);
  return marker;
};

const envBase = (env: string, project = ids.p1, org = ids.o1) =>
  `/organizations/${org}/projects/${project}/environments/${env}`;
const varsOf = (env: string) => `${envBase(env)}/variables`;
const crsOf = (env: string, id = "", project = ids.p1, org = ids.o1) =>
  `${envBase(env, project, org)}/change-requests${id && `/${id}`}`;

const ref = (who: Who) => `user:${people[who].id}`;
const asPerson = (who: Who) => ({ kind: "user", id: people[who].id, ref: ref(who) });

beforeAll(async () => {
  t = await createTestDb();
  ids.o1 = (await createOrganization(t.db, { slug: "one", name: "one" })).id;
  ids.o2 = (await createOrganization(t.db, { slug: "two", name: "two" })).id;
  ids.p1 = (await createProject(t.db, { organizationId: ids.o1, name: "p1" })).id;
  ids.p2 = (await createProject(t.db, { organizationId: ids.o1, name: "p2" })).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob", "carol", "dave", "erin", "gina"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [ids.o1]: "admin" }, projectRoles: {} }); // alice: maintainer
  roleTable.set(902, { orgRoles: { [ids.o1]: "member" }, projectRoles: {} }); // bob: developer
  roleTable.set(903, { orgRoles: {}, projectRoles: { [ids.p1]: "reporter" } }); // carol
  roleTable.set(904, { orgRoles: { [ids.o2]: "owner" }, projectRoles: {} }); // dave: a stranger
  roleTable.set(905, { orgRoles: { [ids.o1]: "admin" }, projectRoles: {} }); // erin: maintainer
  roleTable.set(906, { orgRoles: {}, projectRoles: { [ids.p1]: "maintainer" } }); // gina: maintainer, not an org admin
  for (const [name, who, scopes] of [
    ["read", "alice", ["project.read", "change_request.read"]],
    ["approve", "alice", ["project.read", "change_request.approve"]],
    ["create", "alice", ["project.read", "change_request.create"]],
  ] as const) {
    const fresh = newApiToken();
    await createApiToken(t.db, {
      userId: people[who].id,
      name,
      prefix: fresh.prefix,
      tokenHash: fresh.tokenHash,
      scopes,
      ttlMs: 60_000,
    });
    tokens[name] = fresh.token;
  }
  app = makeApp(keys);
});
afterAll(async () => {
  await t.drop();
});

const eventsOf = (action: string, resourceId?: string) =>
  t.db
    .select()
    .from(auditEvents)
    .where(
      resourceId
        ? and(eq(auditEvents.action, action), eq(auditEvents.resourceId, resourceId))
        : eq(auditEvents.action, action),
    );

/** An environment with some variables, made through the API while it is still open to direct writes. */
let envN = 0;
const makeEnv = async (
  vars: Record<string, ["plain" | "secret", string]> = {},
  options: { protect?: boolean; project?: string } = {},
) => {
  const slug = `e${++envN}`;
  const project = options.project ?? ids.p1;
  const e = await createEnvironment(t.db, {
    organizationId: ids.o1,
    projectId: project,
    name: slug,
    slug,
  });
  for (const [key, [kind, value]] of Object.entries(vars)) {
    const res = await call("alice", "POST", `${envBase(e.id, project)}/variables`, {
      key,
      kind,
      value,
    });
    expect(res.status).toBe(201);
  }
  if (options.protect !== false) {
    await setEnvironmentProtection(t.db, ids.o1, project, e.id, true);
  }
  return e.id;
};
const setProtection = (env: string, value: boolean) =>
  setEnvironmentProtection(t.db, ids.o1, ids.p1, env, value);

const variableOf = async (env: string, key: string) => {
  const list = await call("alice", "GET", varsOf(env));
  const found = list.json.items.find((v: { key: string }) => v.key === key);
  if (!found) return undefined;
  const revealed = await call("alice", "GET", `${varsOf(env)}/${found.id}/value`);
  return {
    id: found.id as string,
    kind: found.kind as string,
    value: revealed.json.value as string,
  };
};
const keysOf = async (env: string) =>
  (await call("alice", "GET", varsOf(env))).json.items.map((v: { key: string }) => v.key).sort();

const propose = async (who: Who, env: string, ops: BulkOp[]) => {
  const res = await call(who, "POST", crsOf(env), { ops });
  expect(res.status).toBe(201);
  return res.json as { id: string; status: string };
};

describe("protecting an environment", () => {
  test("is for org admins: a project maintainer, a developer and a reporter are refused, a stranger finds no such project", async () => {
    const env = await makeEnv({}, { protect: false });
    const path = `${envBase(env)}/protection`;
    for (const [who, status] of [
      ["alice", 200],
      ["erin", 200],
      ["gina", 403],
      ["bob", 403],
      ["carol", 403],
      ["dave", 404],
      [null, 401],
    ] as const) {
      expect([who, (await call(who, "PUT", path, { protected: true })).status]).toEqual([
        who,
        status,
      ]);
    }
  });

  test("switches it on and off, shows in the environment, and is audited with the value it replaced", async () => {
    const env = await makeEnv({}, { protect: false });
    const path = `${envBase(env)}/protection`;
    expect((await call("alice", "GET", envBase(env))).json.protected).toBe(false);
    const on = await call("alice", "PUT", path, { protected: true });
    expect(on.json).toMatchObject({ id: env, protected: true });
    expect((await call("alice", "GET", envBase(env))).json.protected).toBe(true);
    expect((await call("alice", "PUT", path, { protected: false })).json.protected).toBe(false);
    const rows = (await eventsOf("environment.protection.update", env)).sort(
      (a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id),
    );
    expect(rows.map((r) => r.metadata)).toEqual([
      { slug: expect.any(String), protected: true, previousProtected: false },
      { slug: expect.any(String), protected: false, previousProtected: true },
    ]);
    expect(rows.every((r) => r.actorId === people.alice.id)).toBe(true);
  });

  test("asks for exactly a boolean, and for an environment that is there", async () => {
    const env = await makeEnv({}, { protect: false });
    const path = `${envBase(env)}/protection`;
    for (const body of [
      {},
      { protected: "yes" },
      { protected: true, extra: 1 },
      { protected: null },
    ]) {
      expect((await call("alice", "PUT", path, body)).status).toBe(422);
    }
    expect((await call("alice", "PUT", path, [true])).status).toBe(422);
    expect((await call("alice", "PUT", path, "protected=1", app, "text/plain")).status).toBe(415);
    const missing = `${envBase(crypto.randomUUID())}/protection`;
    expect((await call("alice", "PUT", missing, { protected: true })).status).toBe(404);
    expect((await call("alice", "GET", envBase(env))).json.protected).toBe(false);
  });
});

describe("direct writes to a protected environment", () => {
  test("every write route refuses with change_request_required and changes nothing; dry runs and reads still work", async () => {
    const env = await makeEnv({ KEEP: ["plain", "one"] });
    const base = varsOf(env);
    const keep = await variableOf(env, "KEEP");
    if (!keep) throw new Error("no variable");
    const versions = async () => (await call("alice", "GET", `${base}/${keep.id}/versions`)).json;
    const before = await versions();
    const refused: [string, string, unknown][] = [
      ["POST", base, { key: "NEW", kind: "plain", value: "x" }],
      ["PATCH", `${base}/${keep.id}`, { value: "two" }],
      ["DELETE", `${base}/${keep.id}`, undefined],
      ["POST", `${base}/${keep.id}/restore`, { version: 1 }],
      ["POST", `${base}/restore`, { at: new Date(Date.now() - 1000).toISOString(), prune: true }],
      ["POST", `${base}/import`, { source: "dotenv", content: "IMP=1", dryRun: false }],
      ["POST", `${base}/bulk`, { ops: [{ op: "set", key: "BLK", value: "1" }], dryRun: false }],
    ];
    for (const [method, path, body] of refused) {
      const res = await call("alice", method, path, body);
      expect([method, path.replace(base, ""), res.status, res.json?.code]).toEqual([
        method,
        path.replace(base, ""),
        409,
        "change_request_required",
      ]);
    }
    expect(await keysOf(env)).toEqual(["KEEP"]);
    expect((await variableOf(env, "KEEP"))?.value).toBe("one");
    expect(await versions()).toEqual(before);

    // looking is not changing: a dry run, the plan of a restore and every read
    const dryImport = await call("alice", "POST", `${base}/import`, {
      source: "dotenv",
      content: "IMP=1",
    });
    expect([dryImport.status, dryImport.json.dryRun]).toEqual([200, true]);
    const dryBulk = await call("alice", "POST", `${base}/bulk`, {
      ops: [{ op: "set", key: "BLK", value: "1" }],
    });
    expect([dryBulk.status, dryBulk.json.dryRun]).toEqual([200, true]);
    expect(
      (await call("alice", "GET", `${base}/snapshot?at=${new Date().toISOString()}`)).status,
    ).toBe(200);
    expect(await keysOf(env)).toEqual(["KEEP"]);
  });

  test("a write that began before protection was switched on cannot slip past it", async () => {
    const env = await makeEnv({}, { protect: false });
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const ready = new Promise<void>((r) => {
      locked = r;
    });
    // protection is on in a transaction that has not ended; the write must wait for it, then be refused
    const switching = t.db.transaction(async (tx) => {
      await setEnvironmentProtection(tx, ids.o1, ids.p1, env, true);
      locked();
      await held;
    });
    await ready;
    const write = call("alice", "POST", varsOf(env), { key: "RACE", kind: "plain", value: "1" });
    await Bun.sleep(300);
    release();
    await switching;
    const res = await write;
    expect([res.status, res.json.code]).toEqual([409, "change_request_required"]);
    expect(await keysOf(env)).toEqual([]);
  });

  test("a project's and an organization's variables are not held back, and the environment is writable again once unprotected", async () => {
    const env = await makeEnv({});
    const key = `OPEN_${envN}`;
    const project = await call(
      "alice",
      "POST",
      `/organizations/${ids.o1}/projects/${ids.p1}/variables`,
      {
        key,
        kind: "plain",
        value: "p",
      },
    );
    expect(project.status).toBe(201);
    const org = await call("alice", "POST", `/organizations/${ids.o1}/variables`, {
      key,
      kind: "plain",
      value: "o",
    });
    expect(org.status).toBe(201);
    expect(
      (await call("alice", "POST", varsOf(env), { key, kind: "plain", value: "e" })).status,
    ).toBe(409);
    await call("alice", "PUT", `${envBase(env)}/protection`, { protected: false });
    expect(
      (await call("alice", "POST", varsOf(env), { key, kind: "plain", value: "e" })).status,
    ).toBe(201);
    await call("alice", "PUT", `${envBase(env)}/protection`, { protected: true });
    expect(
      (await call("alice", "POST", varsOf(env), { key: "again", kind: "plain", value: "e" }))
        .status,
    ).toBe(409);
  });

  test("a protected environment cannot be deleted, an unprotected one can", async () => {
    const env = await makeEnv({});
    const gone = await call("alice", "DELETE", envBase(env));
    expect([gone.status, gone.json.code]).toEqual([409, "protected_environment"]);
    expect((await call("alice", "GET", envBase(env))).status).toBe(200);
    await setProtection(env, false);
    expect((await call("alice", "DELETE", envBase(env))).status).toBe(204);
  });
});

describe("proposing a change", () => {
  test("is for developers and up; a reporter is refused, a stranger finds no such project, nobody is unauthenticated", async () => {
    const env = await makeEnv({});
    const ops = [{ op: "set", key: "A", value: "1" }];
    for (const [who, status] of [
      ["bob", 201],
      ["gina", 201],
      ["alice", 201],
      ["carol", 403],
      ["dave", 404],
      [null, 401],
    ] as const) {
      expect([who, (await call(who, "POST", crsOf(env), { ops })).status]).toEqual([who, status]);
    }
  });

  test("stores it open for a week with key names and actions only, changes no variable, and is audited", async () => {
    const env = await makeEnv({ OLD: ["secret", sekrit("old")], GONE: ["plain", "x"] });
    const value = sekrit("new");
    const res = await call("bob", "POST", crsOf(env), {
      ops: [
        { op: "set", key: "FRESH", kind: "secret", value },
        { op: "set", key: "OLD", value: sekrit("update") },
        { op: "rename", key: "GONE", to: "MOVED" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: ids.o1,
      projectId: ids.p1,
      environmentId: env,
      kind: "variables",
      status: "open",
      author: { kind: "user", id: people.bob.id },
      decidedBy: null,
      decidedAt: null,
      appliedAt: null,
    });
    expect(res.json.diff).toEqual([
      { action: "set", key: "FRESH", kind: "secret" },
      { action: "set", key: "OLD" },
      { action: "rename", key: "GONE", to: "MOVED" },
    ]);
    const left = new Date(res.json.expiresAt).getTime() - Date.now();
    expect(Math.abs(left - 7 * 86_400_000)).toBeLessThan(60_000);
    expect(res.text).not.toContain(value);
    expect(await keysOf(env)).toEqual(["GONE", "OLD"]);
    const [event] = await eventsOf("change_request.create", res.json.id);
    expect(event).toMatchObject({
      actorKind: "user",
      actorId: people.bob.id,
      resourceType: "change_request",
      organizationId: ids.o1,
      projectId: ids.p1,
      metadata: { environmentId: env, count: 3 },
    });
    // the request is what is stored: sealed, and gone from the database once decided
    const [row] = await t.db
      .select()
      .from(changeRequests)
      .where(eq(changeRequests.id, res.json.id));
    expect(Buffer.from(row?.opsEnc ?? []).includes(value)).toBe(false);
  });

  test("an environment holds a limited number of open requests; deciding one makes room", async () => {
    const env = await makeEnv({});
    const other = await makeEnv({});
    const ops: BulkOp[] = [{ op: "set", key: "A", kind: "plain", value: "1" }];
    const first = await propose("bob", env, ops);
    for (let i = 1; i < CHANGE_REQUEST_MAX_OPEN; i++) {
      await createChangeRequest(t.db, keys, {
        organizationId: ids.o1,
        projectId: ids.p1,
        environmentId: env,
        ops,
        author: asPerson("bob"),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    }
    const full = await call("bob", "POST", crsOf(env), { ops });
    expect([full.status, full.json.code]).toEqual([409, "too_many_change_requests"]);
    expect((await call("bob", "POST", crsOf(other), { ops })).status).toBe(201);
    expect((await call("gina", "POST", crsOf(env, `${first.id}/reject`))).status).toBe(200);
    expect((await call("bob", "POST", crsOf(env), { ops })).status).toBe(201);
  });

  test("may also be made for an environment that is not protected", async () => {
    const env = await makeEnv({}, { protect: false });
    const made = await propose("bob", env, [
      { op: "set", key: "VOLUNTARY", kind: "plain", value: "1" },
    ]);
    expect((await call("alice", "POST", crsOf(env, `${made.id}/approve`))).status).toBe(200);
    expect(await keysOf(env)).toEqual(["VOLUNTARY"]);
  });

  test("asks for steps of the bulk edit, naming each key once, as JSON", async () => {
    const env = await makeEnv({});
    const bad: unknown[] = [
      {},
      { ops: [] },
      {
        ops: [
          { op: "set", key: "A", value: "1" },
          { op: "delete", key: "A" },
        ],
      },
      { ops: [{ op: "set", key: "1bad", value: "1" }] },
      { ops: [{ op: "wipe", key: "A" }] },
      { ops: [{ op: "set", key: "A", value: "1" }], dryRun: true },
      { ops: [{ op: "set", key: "A", value: "x".repeat(1_048_577) }] },
      [],
    ];
    for (const body of bad) {
      expect([
        JSON.stringify(body).slice(0, 60),
        (await call("bob", "POST", crsOf(env), body)).status,
      ]).toEqual([JSON.stringify(body).slice(0, 60), 422]);
    }
    expect((await call("bob", "POST", crsOf(env), "ops=1", app, "text/plain")).status).toBe(415);
    expect((await call("bob", "GET", crsOf(env))).json.items).toEqual([]);
  });

  test("needs an environment of that project, and the master keys", async () => {
    const env = await makeEnv({});
    const ops = [{ op: "set", key: "A", value: "1" }];
    expect((await call("bob", "POST", crsOf(crypto.randomUUID()), { ops })).status).toBe(404);
    expect((await call("alice", "POST", crsOf(env, "", ids.p2), { ops })).status).toBe(404);
    const [{ n: stored } = { n: 0 }] = await t.db.select({ n: count() }).from(changeRequests);
    const blind = await call("bob", "POST", crsOf(env), { ops }, makeApp(undefined));
    expect([blind.status, blind.json.code]).toEqual([503, "secrets_unavailable"]);
    const [{ n: after } = { n: 0 }] = await t.db.select({ n: count() }).from(changeRequests);
    expect(after).toBe(stored);
  });
});

describe("reading requests", () => {
  test("is for reporters and up; a stranger finds nothing, nobody is unauthenticated", async () => {
    const env = await makeEnv({});
    const made = await propose("bob", env, [{ op: "set", key: "A", kind: "plain", value: "1" }]);
    for (const [who, status] of [
      ["carol", 200],
      ["bob", 200],
      ["gina", 200],
      ["dave", 404],
      [null, 401],
    ] as const) {
      expect([who, (await call(who, "GET", crsOf(env))).status]).toEqual([who, status]);
      expect([who, (await call(who, "GET", crsOf(env, made.id))).status]).toEqual([who, status]);
    }
  });

  test("lists newest first, by status, a page at a time, and only the environment's own", async () => {
    const env = await makeEnv({});
    const other = await makeEnv({});
    const first = await propose("bob", env, [{ op: "set", key: "A", kind: "plain", value: "1" }]);
    const second = await propose("bob", env, [{ op: "set", key: "B", kind: "plain", value: "1" }]);
    const third = await propose("bob", env, [{ op: "set", key: "C", kind: "plain", value: "1" }]);
    await propose("bob", other, [{ op: "set", key: "Z", kind: "plain", value: "1" }]);
    await call("gina", "POST", crsOf(env, `${second.id}/reject`));
    const all = await call("carol", "GET", crsOf(env));
    expect(all.json.items.map((r: { id: string }) => r.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
    const open = await call("carol", "GET", `${crsOf(env)}?status=open`);
    expect(open.json.items.map((r: { id: string }) => r.id)).toEqual([third.id, first.id]);
    const rejected = await call("carol", "GET", `${crsOf(env)}?status=rejected`);
    expect(rejected.json.items.map((r: { id: string }) => r.id)).toEqual([second.id]);
    const page1 = await call("carol", "GET", `${crsOf(env)}?limit=2`);
    expect(page1.json.items.map((r: { id: string }) => r.id)).toEqual([third.id, second.id]);
    const page2 = await call(
      "carol",
      "GET",
      `${crsOf(env)}?limit=2&cursor=${page1.json.nextCursor}`,
    );
    expect(page2.json.items.map((r: { id: string }) => r.id)).toEqual([first.id]);
    expect(page2.json.nextCursor).toBeNull();
    for (const [bad, status] of [
      ["status=nope", 422],
      ["limit=0", 422],
      ["cursor=garbage", 400],
    ] as const) {
      expect([bad, (await call("carol", "GET", `${crsOf(env)}?${bad}`)).status]).toEqual([
        bad,
        status,
      ]);
    }
  });

  test("one request is found only under its own environment, project and organization", async () => {
    const env = await makeEnv({});
    const other = await makeEnv({});
    const made = await propose("bob", env, [{ op: "set", key: "A", kind: "plain", value: "1" }]);
    expect((await call("alice", "GET", crsOf(env, made.id))).status).toBe(200);
    expect((await call("alice", "GET", crsOf(other, made.id))).status).toBe(404);
    expect((await call("alice", "GET", crsOf(env, made.id, ids.p2))).status).toBe(404);
    expect((await call("alice", "GET", crsOf(env, crypto.randomUUID()))).status).toBe(404);
    expect((await call("alice", "POST", crsOf(other, `${made.id}/approve`))).status).toBe(404);
    expect((await call("alice", "POST", crsOf(other, `${made.id}/reject`))).status).toBe(404);
    expect((await call("dave", "GET", crsOf(env, made.id, ids.p1, ids.o2))).status).toBe(404);
    expect((await call("alice", "GET", crsOf(crypto.randomUUID()))).status).toBe(404);
  });

  test("a token needs the action by name, for each route", async () => {
    const env = await makeEnv({});
    const ops = [{ op: "set", key: "A", kind: "plain", value: "1" }];
    expect((await call({ bearer: tokens.read }, "GET", crsOf(env))).status).toBe(200);
    expect((await call({ bearer: tokens.read }, "POST", crsOf(env), { ops })).status).toBe(403);
    const made = await call({ bearer: tokens.create }, "POST", crsOf(env), { ops });
    expect(made.status).toBe(201);
    expect((await call({ bearer: tokens.create }, "GET", crsOf(env))).status).toBe(403);
    expect(
      (await call({ bearer: tokens.read }, "POST", crsOf(env, `${made.json.id}/approve`))).status,
    ).toBe(403);
    expect(
      (await call({ bearer: tokens.read }, "POST", crsOf(env, `${made.json.id}/reject`))).status,
    ).toBe(403);
  });
});

describe("deciding", () => {
  test("a developer's change waits, a maintainer's approval applies it as them, and the audit log has both people", async () => {
    const env = await makeEnv({
      OLD: ["secret", sekrit("old")],
      GONE: ["plain", "bye"],
      MOVE: ["plain", "stay"],
    });
    const fresh = sekrit("fresh");
    const changed = sekrit("changed");
    const made = await propose("bob", env, [
      { op: "set", key: "FRESH", kind: "secret", value: fresh },
      { op: "set", key: "OLD", value: changed },
      { op: "delete", key: "GONE" },
      { op: "rename", key: "MOVE", to: "MOVED" },
    ]);
    // waiting: nothing has happened
    expect(await keysOf(env)).toEqual(["GONE", "MOVE", "OLD"]);

    const done = await call("alice", "POST", crsOf(env, `${made.id}/approve`));
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({
      id: made.id,
      status: "applied",
      author: { kind: "user", id: people.bob.id },
      decidedBy: { kind: "user", id: people.alice.id },
    });
    expect(done.json.decidedAt).not.toBeNull();
    expect(done.json.appliedAt).not.toBeNull();
    expect(done.text).not.toContain(fresh);

    expect(await keysOf(env)).toEqual(["FRESH", "MOVED", "OLD"]);
    expect(await variableOf(env, "FRESH")).toMatchObject({ kind: "secret", value: fresh });
    expect((await variableOf(env, "OLD"))?.value).toBe(changed);
    expect((await variableOf(env, "MOVED"))?.value).toBe("stay");
    // the values are gone from the request, and the history says whose change it was
    const [row] = await t.db.select().from(changeRequests).where(eq(changeRequests.id, made.id));
    expect(row?.opsEnc).toBeNull();
    const old = await variableOf(env, "OLD");
    const versions = (await call("alice", "GET", `${varsOf(env)}/${old?.id}/versions`)).json.items;
    expect(versions[0]).toMatchObject({
      actorKind: "user",
      actorId: people.alice.id,
      reason: `change request ${made.id}`,
    });

    // the trail names the proposer and the approver, here and in the log's own listing
    const [created] = await eventsOf("change_request.create", made.id);
    const [approved] = await eventsOf("change_request.approve", made.id);
    expect(created?.actorId).toBe(people.bob.id);
    expect(approved).toMatchObject({
      actorId: people.alice.id,
      metadata: {
        environmentId: env,
        authorKind: "user",
        authorId: people.bob.id,
        count: 4,
        appliedCount: 4,
      },
    });
    const log = await call(
      "alice",
      "GET",
      `/organizations/${ids.o1}/audit-events?projectId=${ids.p1}&limit=50`,
    );
    const mine = log.json.items.filter(
      (e: { metadata: { changeRequestId?: string }; resourceId: string }) =>
        e.resourceId === made.id || e.metadata.changeRequestId === made.id,
    );
    expect(mine.map((e: { action: string }) => e.action).sort()).toEqual([
      "change_request.approve",
      "change_request.create",
      "variable.create",
      "variable.delete",
      "variable.update",
      "variable.update",
    ]);
    const changes = mine.filter((e: { action: string }) => e.action.startsWith("variable."));
    for (const e of changes) {
      expect(e).toMatchObject({
        actorId: people.alice.id,
        metadata: {
          source: "change_request",
          changeRequestId: made.id,
          authorKind: "user",
          authorId: people.bob.id,
        },
      });
    }
  });

  test("only maintainers decide: a developer and a reporter are refused, a stranger finds nothing, nobody is unauthenticated", async () => {
    const env = await makeEnv({});
    const fresh = () =>
      propose("bob", env, [{ op: "set", key: `K${++n}`, kind: "plain", value: "1" }]);
    for (const [who, status] of [
      ["carol", 403],
      ["bob", 403],
      ["dave", 404],
      [null, 401],
      ["gina", 200],
      ["erin", 200],
    ] as const) {
      for (const verb of ["approve", "reject"] as const) {
        const made = await fresh();
        const res = await call(who, "POST", crsOf(env, `${made.id}/${verb}`));
        expect([who, verb, res.status]).toEqual([who, verb, status]);
        const after = (await call("alice", "GET", crsOf(env, made.id))).json.status;
        expect(after).toBe(status !== 200 ? "open" : verb === "approve" ? "applied" : "rejected");
      }
    }
  });

  test("nobody approves their own request: not with the session, not with their own token, either way round", async () => {
    const env = await makeEnv({});
    const own = await propose("alice", env, [
      { op: "set", key: "SELF", kind: "plain", value: "1" },
    ]);
    for (const who of ["alice", { bearer: tokens.approve }] as const) {
      const res = await call(who, "POST", crsOf(env, `${own.id}/approve`));
      expect([res.status, res.json.code]).toEqual([403, "self_approval"]);
    }
    // proposed with the token, approved with the session: the same person
    const viaToken = await call({ bearer: tokens.create }, "POST", crsOf(env), {
      ops: [{ op: "set", key: "SELF2", kind: "plain", value: "1" }],
    });
    expect(viaToken.status).toBe(201);
    const res = await call("alice", "POST", crsOf(env, `${viaToken.json.id}/approve`));
    expect([res.status, res.json.code]).toEqual([403, "self_approval"]);

    expect(await keysOf(env)).toEqual([]);
    expect((await call("alice", "GET", crsOf(env, own.id))).json.status).toBe("open");
    expect(await eventsOf("change_request.approve", own.id)).toHaveLength(0);

    // someone else may
    expect((await call("erin", "POST", crsOf(env, `${own.id}/approve`))).status).toBe(200);
    expect((await call("erin", "POST", crsOf(env, `${viaToken.json.id}/approve`))).status).toBe(
      200,
    );
    expect(await keysOf(env)).toEqual(["SELF", "SELF2"]);
  });

  test("an author may take their own request back; with no one signed in the dev principal is no one else", async () => {
    const env = await makeEnv({});
    const own = await propose("alice", env, [
      { op: "set", key: "TAKEN", kind: "plain", value: "1" },
    ]);
    const rejected = await call("alice", "POST", crsOf(env, `${own.id}/reject`));
    expect([rejected.status, rejected.json.status]).toEqual([200, "rejected"]);

    const dev = makeApp(keys, devPrincipal);
    const made = await call(
      null,
      "POST",
      crsOf(env),
      { ops: [{ op: "set", key: "DEV", kind: "plain", value: "1" }] },
      dev,
    );
    expect(made.status).toBe(201);
    const self = await call(null, "POST", crsOf(env, `${made.json.id}/approve`), undefined, dev);
    expect([self.status, self.json.code]).toEqual([403, "self_approval"]);
    expect((await call("alice", "POST", crsOf(env, `${made.json.id}/approve`))).status).toBe(200);
  });

  test("a rejection closes it, drops the values and says who and whose", async () => {
    const env = await makeEnv({});
    const value = sekrit("rejected");
    const made = await propose("bob", env, [{ op: "set", key: "NO", kind: "secret", value }]);
    const res = await call("gina", "POST", crsOf(env, `${made.id}/reject`));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      status: "rejected",
      decidedBy: { kind: "user", id: people.gina.id },
      appliedAt: null,
    });
    expect(res.json.decidedAt).not.toBeNull();
    expect(await keysOf(env)).toEqual([]);
    const [row] = await t.db.select().from(changeRequests).where(eq(changeRequests.id, made.id));
    expect(row?.opsEnc).toBeNull();
    const [event] = await eventsOf("change_request.reject", made.id);
    expect(event).toMatchObject({
      actorId: people.gina.id,
      metadata: { environmentId: env, authorKind: "user", authorId: people.bob.id },
    });
  });

  test("a decided request is closed: it cannot be approved, rejected or applied twice", async () => {
    const env = await makeEnv({ KEEP: ["plain", "1"] });
    const applied = await propose("bob", env, [{ op: "set", key: "KEEP", value: "2" }]);
    const rejected = await propose("bob", env, [{ op: "set", key: "KEEP", value: "3" }]);
    expect((await call("alice", "POST", crsOf(env, `${applied.id}/approve`))).status).toBe(200);
    expect((await call("alice", "POST", crsOf(env, `${rejected.id}/reject`))).status).toBe(200);
    for (const [id, status] of [
      [applied.id, "applied"],
      [rejected.id, "rejected"],
    ] as const) {
      for (const verb of ["approve", "reject"]) {
        const res = await call("erin", "POST", crsOf(env, `${id}/${verb}`));
        expect([id, verb, res.status, res.json.code]).toEqual([
          id,
          verb,
          409,
          "change_request_closed",
        ]);
        expect(res.json.detail ?? res.text).toContain(status);
      }
    }
    expect((await variableOf(env, "KEEP"))?.value).toBe("2");
    expect(await eventsOf("change_request.approve", applied.id)).toHaveLength(1);
    expect(await eventsOf("change_request.approve", rejected.id)).toHaveLength(0);
  });

  test("a request nobody decided in time cannot be approved, and nothing is applied", async () => {
    const env = await makeEnv({});
    const late = await createChangeRequest(t.db, keys, {
      organizationId: ids.o1,
      projectId: ids.p1,
      environmentId: env,
      ops: [{ op: "set", key: "LATE", kind: "plain", value: "1" }],
      author: asPerson("bob"),
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await call("alice", "POST", crsOf(env, `${late.id}/approve`));
    expect([res.status, res.json.code]).toEqual([409, "change_request_expired"]);
    expect(await keysOf(env)).toEqual([]);
    expect(await eventsOf("change_request.approve", late.id)).toHaveLength(0);
  });

  test("a request the variables have moved away from is refused whole and can be rejected", async () => {
    const env = await makeEnv({ GONE: ["plain", "1"], KEEP: ["plain", "1"] });
    const made = await propose("bob", env, [
      { op: "set", key: "KEEP", value: "2" },
      { op: "rename", key: "GONE", to: "MOVED" },
    ]);
    // someone removes GONE meanwhile (protection off for a moment)
    await setProtection(env, false);
    const gone = await variableOf(env, "GONE");
    expect((await call("alice", "DELETE", `${varsOf(env)}/${gone?.id}`)).status).toBe(204);
    await setProtection(env, true);

    const res = await call("alice", "POST", crsOf(env, `${made.id}/approve`));
    expect([res.status, res.json.code]).toEqual([409, "change_conflict"]);
    expect(res.json.detail ?? res.text).toContain("GONE");
    // all or nothing: KEEP was not changed either, and the request is still open
    expect((await variableOf(env, "KEEP"))?.value).toBe("1");
    expect((await call("alice", "GET", crsOf(env, made.id))).json.status).toBe("open");
    expect(await eventsOf("change_request.approve", made.id)).toHaveLength(0);
    expect((await call("alice", "POST", crsOf(env, `${made.id}/reject`))).json.status).toBe(
      "rejected",
    );
  });

  test("a delete of a key that someone else removed meanwhile is done, and the rest applies", async () => {
    const env = await makeEnv({ GONE: ["plain", "1"], KEEP: ["plain", "1"] });
    const made = await propose("bob", env, [
      { op: "set", key: "KEEP", value: "2" },
      { op: "delete", key: "GONE" },
    ]);
    await setProtection(env, false);
    const gone = await variableOf(env, "GONE");
    expect((await call("alice", "DELETE", `${varsOf(env)}/${gone?.id}`)).status).toBe(204);
    await setProtection(env, true);
    const res = await call("alice", "POST", crsOf(env, `${made.id}/approve`));
    expect([res.status, res.json.status]).toEqual([200, "applied"]);
    expect((await variableOf(env, "KEEP"))?.value).toBe("2");
    const [approved] = await eventsOf("change_request.approve", made.id);
    expect(approved?.metadata).toMatchObject({ count: 2, appliedCount: 1 });
  });

  test("a step that changes nothing is applied as nothing, and is counted that way", async () => {
    const env = await makeEnv({ SAME: ["plain", "same"] });
    const made = await propose("bob", env, [{ op: "set", key: "SAME", value: "same" }]);
    const res = await call("alice", "POST", crsOf(env, `${made.id}/approve`));
    expect(res.json.status).toBe("applied");
    const [approved] = await eventsOf("change_request.approve", made.id);
    expect(approved?.metadata).toMatchObject({ count: 1, appliedCount: 0 });
    const same = await variableOf(env, "SAME");
    const versions = (await call("alice", "GET", `${varsOf(env)}/${same?.id}/versions`)).json.items;
    expect(versions).toHaveLength(1);
  });

  test("the master keys are needed to approve, and without them nothing is decided", async () => {
    const env = await makeEnv({});
    const made = await propose("bob", env, [{ op: "set", key: "A", kind: "plain", value: "1" }]);
    const blind = makeApp(undefined);
    const res = await call("alice", "POST", crsOf(env, `${made.id}/approve`), undefined, blind);
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect((await call("alice", "GET", crsOf(env, made.id))).json.status).toBe("open");
    // rejecting opens nothing
    expect(
      (await call("alice", "POST", crsOf(env, `${made.id}/reject`), undefined, blind)).status,
    ).toBe(200);
  });
});

describe("the expiry job", () => {
  const ctx = (): JobContext => ({
    id: "job",
    queue: "change_request.expire",
    payload: {},
    attempt: 1,
    maxAttempts: 1,
    log: createLogger({ level: "debug", write: () => {} }),
    signal: new AbortController().signal,
  });
  const lapsed = (env: string, key: string, ago = 1000) =>
    createChangeRequest(t.db, keys, {
      organizationId: ids.o1,
      projectId: ids.p1,
      environmentId: env,
      ops: [{ op: "set", key, kind: "plain", value: sekrit("lapsed") }],
      author: asPerson("bob"),
      expiresAt: new Date(Date.now() - ago),
    });
  const stateOf = async (id: string) => {
    const [row] = await t.db.select().from(changeRequests).where(eq(changeRequests.id, id));
    return { status: row?.status, sealed: row?.opsEnc !== null };
  };

  test("closes the lapsed, drops their values, leaves the live ones and writes a record for each", async () => {
    const env = await makeEnv({});
    const old = await lapsed(env, "OLD");
    const live = await propose("bob", env, [{ op: "set", key: "LIVE", kind: "plain", value: "1" }]);
    await changeRequestExpireHandler({ db: t.db })(ctx());
    expect(await stateOf(old.id)).toEqual({ status: "expired", sealed: false });
    expect(await stateOf(live.id)).toEqual({ status: "open", sealed: true });
    const [event] = await eventsOf("change_request.expire", old.id);
    expect(event).toMatchObject({
      actorKind: "system",
      actorId: "change-request-expire",
      resourceType: "change_request",
      organizationId: ids.o1,
      projectId: ids.p1,
      metadata: { environmentId: env, authorKind: "user", authorId: people.bob.id },
    });
    expect(await eventsOf("change_request.expire", live.id)).toHaveLength(0);
    // it shows as expired, and cannot be approved or rejected
    expect((await call("alice", "GET", crsOf(env, old.id))).json.status).toBe("expired");
    const again = await call("alice", "POST", crsOf(env, `${old.id}/approve`));
    expect([again.status, again.json.code]).toEqual([409, "change_request_closed"]);
    // and a second run has nothing to do
    await changeRequestExpireHandler({ db: t.db })(ctx());
    expect(await eventsOf("change_request.expire", old.id)).toHaveLength(1);
  });

  test("works through a backlog a batch at a time and stops at the round limit", async () => {
    const env = await makeEnv({});
    const all = [await lapsed(env, "B1"), await lapsed(env, "B2"), await lapsed(env, "B3")];
    const open = async () =>
      (
        await t.db
          .select()
          .from(changeRequests)
          .where(
            and(
              inArray(
                changeRequests.id,
                all.map((r) => r.id),
              ),
              eq(changeRequests.status, "open"),
            ),
          )
      ).length;
    await changeRequestExpireHandler({ db: t.db, batch: 1, rounds: 2 })(ctx());
    expect(await open()).toBe(1);
    await changeRequestExpireHandler({ db: t.db, batch: 1, rounds: 2 })(ctx());
    expect(await open()).toBe(0);
  });

  test("with the job off a lapsed request still reads open, and rejecting it is what drops its values", async () => {
    const env = await makeEnv({});
    const old = await lapsed(env, "NOJOB");
    expect((await call("alice", "GET", crsOf(env, old.id))).json.status).toBe("open");
    expect((await call("alice", "POST", crsOf(env, `${old.id}/reject`))).json.status).toBe(
      "rejected",
    );
    expect(await stateOf(old.id)).toEqual({ status: "rejected", sealed: false });
  });

  test("a close that cannot be recorded is not done: the request stays open", async () => {
    const env = await makeEnv({});
    const old = await lapsed(env, "ATOMIC");
    await t.db.execute(sql`
      CREATE FUNCTION refuse_expire_record() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'no record'; END; $$`);
    await t.db.execute(sql`
      CREATE TRIGGER refuse_expire_record BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (NEW.action = 'change_request.expire') EXECUTE FUNCTION refuse_expire_record()`);
    try {
      await expect(changeRequestExpireHandler({ db: t.db })(ctx())).rejects.toThrow();
      expect(await stateOf(old.id)).toEqual({ status: "open", sealed: true });
    } finally {
      await t.db.execute(sql`DROP TRIGGER refuse_expire_record ON audit_events`);
      await t.db.execute(sql`DROP FUNCTION refuse_expire_record()`);
    }
    await changeRequestExpireHandler({ db: t.db })(ctx());
    expect(await stateOf(old.id)).toEqual({ status: "expired", sealed: false });
  });
});

describe("secrets", () => {
  test("no value appears in any answer, and none in the audit log", async () => {
    expect(markers.length).toBeGreaterThan(5);
    for (const marker of markers) {
      for (const s of seen.filter((s) => !s.reveal)) expect(s.text).not.toContain(marker);
    }
    const rows = await t.db.select().from(auditEvents);
    const text = JSON.stringify(rows);
    for (const marker of markers) expect(text).not.toContain(marker);
  });
});
