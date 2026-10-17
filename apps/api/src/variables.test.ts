// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${KEY}` is the reference syntax under test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  upsertUser,
  variables,
  variableVersions,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { count, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const keys = envKeyProvider(`k2:${key(2)},k1:${key(1)}`);
const OTHER_KEYS = envKeyProvider(`k9:${key(9)}`);

let t: TestDb;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol" | "erin", { id: string; cookie: string }>;
const ids = {} as Record<"o1" | "o2" | "o3" | "p1" | "p2" | "p3" | "dev" | "other" | "e3", string>;

const makeApp = (provider: typeof keys | undefined) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys: provider,
  });
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await createTestDb();
  const org = async (slug: string) => (await createOrganization(t.db, { slug, name: slug })).id;
  ids.o1 = await org("one");
  ids.o2 = await org("two");
  ids.o3 = await org("three");
  const project = async (organizationId: string, name: string) =>
    (await createProject(t.db, { organizationId, name })).id;
  ids.p1 = await project(ids.o1, "p1");
  ids.p2 = await project(ids.o1, "p2");
  ids.p3 = await project(ids.o3, "p3");
  const env = async (organizationId: string, projectId: string, slug: string) =>
    (await createEnvironment(t.db, { organizationId, projectId, name: slug, slug })).id;
  ids.dev = await env(ids.o1, ids.p1, "dev");
  ids.other = await env(ids.o1, ids.p2, "other");
  ids.e3 = await env(ids.o3, ids.p3, "e3");
  let gitlabId = 900;
  for (const name of ["alice", "bob", "carol", "erin"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [ids.o1]: "admin", [ids.o3]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(902, {
    orgRoles: { [ids.o1]: "member" },
    projectRoles: { [ids.p1]: "maintainer" },
  }); // bob
  roleTable.set(903, { orgRoles: {}, projectRoles: { [ids.p1]: "reporter" } }); // carol
  roleTable.set(904, { orgRoles: { [ids.o2]: "admin" }, projectRoles: {} }); // erin
  app = makeApp(keys);
});
afterAll(async () => {
  await t.drop();
});

type Who = keyof typeof people;
/** Every answer, to be searched for secrets at the end; `reveal` ones are the one place a secret may be. */
const seen: { path: string; text: string; reveal: boolean }[] = [];
async function call(
  who: Who | undefined,
  method: string,
  path: string,
  body?: unknown,
  application = app,
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await application.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  seen.push({ path, text, reveal: method === "GET" && /\/value(\?|$)/.test(path) });
  return {
    status: res.status,
    text,
    headers: res.headers,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const base = {
  organization: (org = ids.o1) => `/organizations/${org}/variables`,
  project: (p = ids.p1, org = ids.o1) => `/organizations/${org}/projects/${p}/variables`,
  environment: (e = ids.dev, p = ids.p1, org = ids.o1) =>
    `/organizations/${org}/projects/${p}/environments/${e}/variables`,
};
const LEVELS = ["organization", "project", "environment"] as const;
const resolvedPath = (e = ids.dev, p = ids.p1, org = ids.o1) =>
  `/organizations/${org}/projects/${p}/environments/${e}/resolved-variables`;

/** A value that must never show up anywhere but a reveal. */
const markers: string[] = [];
let n = 0;
const sekrit = (label: string) => {
  const marker = `SEKRIT-${label}-${++n}-${Bun.randomUUIDv7()}`;
  markers.push(marker);
  return marker;
};

interface Dto {
  id: string;
  level: string;
  key: string;
  kind: string;
  version: number;
  value: string | null;
  description: string;
  projectId: string | null;
  environmentId: string | null;
  createdAt: string;
}
let k = 0;
const make = async (path: string, over: object = {}, who: Who = "alice") => {
  const res = await call(who, "POST", path, { key: `K${++k}`, kind: "plain", value: "v", ...over });
  expect(res.status).toBe(201);
  return res.json as Dto;
};
const events = (action: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, action));

describe("creating a variable", () => {
  test("at every level and kind: sealed, and answered without a secret or file value", async () => {
    for (const level of LEVELS) {
      for (const kind of ["plain", "secret", "file"]) {
        const value = kind === "plain" ? "visible" : sekrit(`${level}-${kind}`);
        const res = await call("alice", "POST", base[level](), {
          key: `C_${level}_${kind}`,
          kind,
          value,
          description: "d",
        });
        expect(res.status).toBe(201);
        expect(Object.keys(res.json).sort()).toEqual([
          "createdAt",
          "description",
          "environmentId",
          "id",
          "key",
          "kind",
          "level",
          "organizationId",
          "projectId",
          "updatedAt",
          "value",
          "version",
        ]);
        expect(res.json).toMatchObject({
          level,
          kind,
          version: 1,
          description: "d",
          organizationId: ids.o1,
          projectId: level === "organization" ? null : ids.p1,
          environmentId: level === "environment" ? ids.dev : null,
          value: kind === "plain" ? value : null,
        });
      }
    }
    const rows = await t.db.select().from(variableVersions);
    expect(rows.length).toBeGreaterThanOrEqual(9);
    for (const row of rows) {
      const stored = Buffer.from(row.valueEnc).toString("latin1");
      expect(stored).not.toContain("visible");
      for (const m of markers) expect(stored).not.toContain(m);
    }
  });

  test("a key is used once per level; another level, or a deleted one, frees it", async () => {
    const a = await make(base.project(), { key: "DUP" });
    const again = await call("alice", "POST", base.project(), {
      key: "DUP",
      kind: "plain",
      value: "x",
    });
    expect([again.status, again.json.code]).toEqual([409, "key_taken"]);
    await make(base.environment(), { key: "DUP" });
    await make(base.organization(), { key: "DUP" });
    expect((await call("alice", "DELETE", `${base.project()}/${a.id}`)).status).toBe(204);
    await make(base.project(), { key: "DUP" });
  });

  test("refuses what is not a key, kind or value, without echoing the value", async () => {
    const marker = sekrit("echo");
    const bad: object[] = [
      { key: "1bad" },
      { key: "has space" },
      { key: "" },
      { key: "K".repeat(256) },
      { kind: "other" },
      { kind: undefined },
      { value: undefined },
      { value: 5 },
      { value: "x".repeat(65_537) },
      { value: `${marker}\ud800` }, // a lone surrogate cannot be encoded
      { description: "d".repeat(1001) },
      { extra: 1 },
      { reason: "r".repeat(501) },
    ];
    for (const over of bad) {
      const res = await call("alice", "POST", base.project(), {
        key: "OK_KEY",
        kind: "secret",
        value: marker,
        ...over,
      });
      expect([res.status, res.json.code]).toEqual([422, "validation_failed"]);
      expect(res.text).not.toContain(marker);
      expect(res.text.length).toBeLessThan(2000);
    }
    const stored = await t.db
      .select({ total: count() })
      .from(variables)
      .where(eq(variables.key, "OK_KEY"));
    expect(stored).toEqual([{ total: 0 }]);
  });

  test("a value may be 65,536 characters, not more", async () => {
    const big = await make(base.project(), { value: "x".repeat(65_536) });
    expect((await call("alice", "GET", `${base.project()}/${big.id}`)).json.value).toHaveLength(
      65_536,
    );
  });

  test("a project, environment or organization that is not there is a 404", async () => {
    const body = { key: "NOPE", kind: "plain", value: "v" };
    // an environment of another project, a project of another organization
    for (const path of [
      base.environment(ids.other, ids.p1),
      base.project(ids.p2, ids.o2),
      base.environment(ids.dev, ids.p1, ids.o2),
    ]) {
      const res = await call("alice", "POST", path, body);
      // alice has no role in o2 (the guard answers 404), and p2's environment is not in p1 (the key says so)
      expect([res.status, res.json.code]).toEqual([404, "not_found"]);
    }
    // a caller who may write, in the right organization, to a project that is not in it
    const res = await call("erin", "POST", base.project(ids.p1, ids.o2), body);
    expect([res.status, res.json.code]).toEqual([404, "not_found"]);
    const res2 = await call("erin", "POST", base.environment(ids.dev, ids.p2, ids.o2), body);
    expect([res2.status, res2.json.code]).toEqual([404, "not_found"]);
    const [{ total } = { total: 0 }] = await t.db
      .select({ total: count() })
      .from(variables)
      .where(eq(variables.key, "NOPE"));
    expect(total).toBe(0);
  });

  test("without master keys it is a 503 and nothing is stored", async () => {
    const bare = makeApp(undefined);
    const before = await t.db.select({ total: count() }).from(variables);
    const res = await call(
      "alice",
      "POST",
      base.project(),
      { key: "NOKEYS", kind: "secret", value: sekrit("nokeys") },
      bare,
    );
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect(await t.db.select({ total: count() }).from(variables)).toEqual(before);
  });

  test("is audited with where, what and how it is kept, never the value", async () => {
    const value = sekrit("audit");
    const v = await make(base.environment(), { key: "AUDITED", kind: "secret", value });
    const row = (await events("variable.create")).find((e) => e.resourceId === v.id);
    expect(row).toMatchObject({
      actorKind: "user",
      actorId: people.alice.id,
      resourceType: "variable",
      organizationId: ids.o1,
      projectId: ids.p1,
    });
    expect(row?.metadata).toEqual({
      level: "environment",
      environmentId: ids.dev,
      key: "AUDITED",
      kind: "secret",
    });
  });
});

describe("reading variables", () => {
  test("each level lists only its own, in creation order, a page at a time", async () => {
    const own = {} as Record<(typeof LEVELS)[number], string[]>;
    const where = {
      organization: base.organization(ids.o3),
      project: base.project(ids.p3, ids.o3),
      environment: base.environment(ids.e3, ids.p3, ids.o3),
    };
    for (const level of LEVELS) {
      own[level] = [];
      for (const kind of ["plain", "secret", "plain", "file", "plain"]) {
        const v = await make(where[level], {
          kind,
          value: kind === "plain" ? "p" : sekrit(`list-${level}`),
        });
        own[level].push(v.id);
      }
    }
    for (const level of LEVELS) {
      const got: Dto[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: Awaited<ReturnType<typeof call>> = await call(
          "alice",
          "GET",
          `${where[level]}?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        );
        expect(res.status).toBe(200);
        got.push(...res.json.items);
        cursor = res.json.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(got.map((v) => v.id)).toEqual(own[level]);
      expect(got.every((v) => v.level === level)).toBe(true);
      expect(got.every((v) => (v.kind === "plain") === (v.value !== null))).toBe(true);
    }
  });

  test("one variable: a plain value shows, a secret or file value does not", async () => {
    const plain = await make(base.project(), { value: "shown" });
    const secret = await make(base.project(), { kind: "secret", value: sekrit("get") });
    const got = await call("alice", "GET", `${base.project()}/${plain.id}`);
    expect([got.status, got.json.value]).toEqual([200, "shown"]);
    const hidden = await call("alice", "GET", `${base.project()}/${secret.id}`);
    expect([hidden.status, hidden.json.value, hidden.json.kind]).toEqual([200, null, "secret"]);
  });

  test("an id is found only under its own organization, project and level", async () => {
    const proj = await make(base.project());
    const env = await make(base.environment());
    const org = await make(base.organization());
    const wrong = [
      `${base.project()}/${env.id}`,
      `${base.project()}/${org.id}`,
      `${base.environment()}/${proj.id}`,
      `${base.organization()}/${proj.id}`,
      `${base.project(ids.p2)}/${proj.id}`,
      `${base.environment(ids.other, ids.p2)}/${env.id}`,
      `${base.organization(ids.o2)}/${org.id}`,
      `${base.project(ids.p1, ids.o2)}/${proj.id}`,
    ];
    for (const path of wrong) {
      for (const suffix of ["", "/versions", "/value"]) {
        const as = path.includes(ids.o2) ? "erin" : "alice";
        const res = await call(as, "GET", `${path}${suffix}`);
        expect([path + suffix, res.status]).toEqual([path + suffix, 404]);
      }
    }
    expect((await call("alice", "GET", `${base.project()}/${proj.id}`)).status).toBe(200);
  });

  test("a parent that is not there is a 404 for a list too, and for its resolved set", async () => {
    const gone = crypto.randomUUID();
    for (const path of [
      base.project(gone),
      base.environment(gone),
      base.environment(ids.other, ids.p1), // an environment of another project
      resolvedPath(gone),
      resolvedPath(ids.other, ids.p1),
    ]) {
      const res = await call("alice", "GET", path);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });

  test("who may read: a project reporter reads the project, not the organization's", async () => {
    const v = await make(base.project(), { value: "r" });
    await make(base.organization());
    expect((await call("carol", "GET", `${base.project()}/${v.id}`)).status).toBe(200);
    expect((await call("carol", "GET", base.environment())).status).toBe(200);
    expect((await call("carol", "GET", base.organization())).status).toBe(404); // cannot see it
    expect((await call("bob", "GET", base.organization())).status).toBe(200); // a member can
    expect((await call("erin", "GET", base.project())).status).toBe(404);
    expect((await call(undefined, "GET", base.project())).status).toBe(401);
    expect((await call("alice", "GET", base.project(ids.p2, ids.o2))).status).toBe(404);
  });
});

describe("changing variables", () => {
  test("a new value is a new version; a description alone is not", async () => {
    const v = await make(base.project(), { value: "one" });
    const path = `${base.project()}/${v.id}`;
    const next = await call("bob", "PATCH", path, { value: "two", reason: "rotate" });
    expect([next.status, next.json.version, next.json.value]).toEqual([200, 2, "two"]);
    const noted = await call("alice", "PATCH", path, { description: "now with words" });
    expect([noted.json.version, noted.json.description, noted.json.value]).toEqual([
      2,
      "now with words",
      "two",
    ]);
    const history = await call("alice", "GET", `${path}/versions`);
    expect(history.status).toBe(200);
    expect(history.json.items).toEqual([
      expect.objectContaining({
        version: 2,
        actorKind: "user",
        actorId: people.bob.id,
        reason: "rotate",
      }),
      expect.objectContaining({
        version: 1,
        actorKind: "user",
        actorId: people.alice.id,
        reason: null,
      }),
    ]);
    expect(history.text).not.toContain("one");
    expect(history.text).not.toContain("two");
    const page = await call("alice", "GET", `${path}/versions?limit=1`);
    const rest = await call(
      "alice",
      "GET",
      `${path}/versions?limit=1&cursor=${page.json.nextCursor}`,
    );
    expect([page.json.items[0].version, rest.json.items[0].version, rest.json.nextCursor]).toEqual([
      2,
      1,
      null,
    ]);
  });

  test("a key and a kind cannot change, and a change must change something", async () => {
    const v = await make(base.project(), { kind: "secret", value: sekrit("fixed") });
    const path = `${base.project()}/${v.id}`;
    for (const body of [
      {},
      { key: "RENAMED" },
      { kind: "plain" },
      { reason: "why" },
      { description: "d", reason: "why" },
      { value: 1 },
      { description: "d", key: "RENAMED" },
      { value: "x", kind: "plain" },
    ]) {
      const res = await call("alice", "PATCH", path, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    expect((await call("alice", "GET", path)).json).toMatchObject({
      key: v.key,
      kind: "secret",
      version: 1,
    });
  });

  test("deleting hides it everywhere and frees the key", async () => {
    const v = await make(base.environment(), { key: "GONE", kind: "secret", value: sekrit("del") });
    const path = `${base.environment()}/${v.id}`;
    expect((await call("alice", "DELETE", path)).status).toBe(204);
    for (const suffix of ["", "/versions", "/value"]) {
      expect((await call("alice", "GET", `${path}${suffix}`)).status).toBe(404);
    }
    expect((await call("alice", "PATCH", path, { value: "x" })).status).toBe(404);
    expect((await call("alice", "DELETE", path)).status).toBe(404);
    const listed = await call("alice", "GET", base.environment());
    expect(listed.json.items.some((x: Dto) => x.id === v.id)).toBe(false);
    await make(base.environment(), { key: "GONE" });
    const row = (await events("variable.delete")).find((e) => e.resourceId === v.id);
    expect(row?.metadata).toEqual({
      level: "environment",
      environmentId: ids.dev,
      key: "GONE",
      kind: "secret",
    });
  });

  test("who may write: maintainers and organization admins, not a reporter or a member", async () => {
    const v = await make(base.project());
    const body = { key: "W", kind: "plain", value: "v" };
    expect((await call("carol", "POST", base.project(), body)).status).toBe(403);
    expect((await call("carol", "PATCH", `${base.project()}/${v.id}`, { value: "x" })).status).toBe(
      403,
    );
    expect((await call("carol", "DELETE", `${base.project()}/${v.id}`)).status).toBe(403);
    expect((await call("bob", "POST", base.organization(), body)).status).toBe(403);
    expect((await call("bob", "POST", base.environment(), { ...body, key: "WB" })).status).toBe(
      201,
    );
    expect((await call("erin", "DELETE", `${base.project()}/${v.id}`)).status).toBe(404);
    expect((await call("alice", "GET", `${base.project()}/${v.id}`)).status).toBe(200);
  });

  test("an update is audited with the fields it changed and the version, never the value", async () => {
    const value = sekrit("upd");
    const v = await make(base.project(), { kind: "secret", value: sekrit("before") });
    const res = await call("alice", "PATCH", `${base.project()}/${v.id}`, {
      value,
      description: "d2",
    });
    expect(res.status).toBe(200);
    await call("alice", "PATCH", `${base.project()}/${v.id}`, { value: sekrit("upd2") });
    await call("alice", "PATCH", `${base.project()}/${v.id}`, { description: "d3" });
    const rows = (await events("variable.update")).filter((e) => e.resourceId === v.id);
    const meta = { level: "project", key: v.key, kind: "secret" };
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.metadata)).toEqual(
      expect.arrayContaining([
        { ...meta, fields: ["description", "value"], version: 2 },
        { ...meta, fields: ["value"], version: 3 },
        { ...meta, fields: ["description"], version: 3 },
      ]),
    );
  });
});

describe("without master keys", () => {
  test("whatever opens a value answers 503; deleting and the history need no key", async () => {
    const v = await make(base.project(), { kind: "secret", value: sekrit("nokeys2") });
    const bare = makeApp(undefined);
    const path = `${base.project()}/${v.id}`;
    for (const [method, url, body] of [
      ["GET", base.project()],
      ["GET", base.organization()],
      ["GET", base.environment()],
      ["GET", path],
      ["GET", `${path}/value`],
      ["PATCH", path, { value: "x" }],
      ["GET", resolvedPath()],
    ] as const) {
      const res = await call("alice", method, url, body, bare);
      expect([method, url, res.status, res.json.code]).toEqual([
        method,
        url,
        503,
        "secrets_unavailable",
      ]);
    }
    expect((await call("alice", "GET", `${path}/versions`, undefined, bare)).status).toBe(200);
    expect((await call("alice", "DELETE", path, undefined, bare)).status).toBe(204);
  });
});

describe("revealing a secret", () => {
  test("a maintainer gets it, once per request, uncached and audited", async () => {
    const value = sekrit("reveal");
    const v = await make(base.project(), { kind: "secret", value });
    const res = await call("bob", "GET", `${base.project()}/${v.id}/value`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: v.id, key: v.key, kind: "secret", version: 1, value });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const row = (await events("variable.reveal")).find((e) => e.resourceId === v.id);
    expect(row).toMatchObject({ actorId: people.bob.id, projectId: ids.p1 });
    expect(row?.metadata).toEqual({ level: "project", key: v.key, kind: "secret", version: 1 });
    expect(JSON.stringify(row)).not.toContain(value);
  });

  test("any version; one that is not there is a 404", async () => {
    const [first, second] = [sekrit("v1"), sekrit("v2")];
    const v = await make(base.environment(), { kind: "file", value: first });
    const path = `${base.environment()}/${v.id}`;
    await call("alice", "PATCH", path, { value: second });
    expect((await call("alice", "GET", `${path}/value`)).json).toMatchObject({
      version: 2,
      value: second,
    });
    expect((await call("alice", "GET", `${path}/value?version=1`)).json).toMatchObject({
      version: 1,
      value: first,
    });
    expect((await call("alice", "GET", `${path}/value?version=3`)).status).toBe(404);
    expect((await call("alice", "GET", `${path}/value?version=0`)).status).toBe(422);
    expect((await call("alice", "GET", `${path}/value?version=x`)).status).toBe(422);
  });

  test("not a reporter, not a stranger, and an organization's secret needs an admin", async () => {
    const mine = await make(base.project(), { kind: "secret", value: sekrit("p") });
    const org = await make(base.organization(), { kind: "secret", value: sekrit("o") });
    expect((await call("carol", "GET", `${base.project()}/${mine.id}/value`)).status).toBe(403);
    expect((await call("erin", "GET", `${base.project()}/${mine.id}/value`)).status).toBe(404);
    expect((await call(undefined, "GET", `${base.project()}/${mine.id}/value`)).status).toBe(401);
    expect((await call("bob", "GET", `${base.organization()}/${org.id}/value`)).status).toBe(403);
    expect((await call("alice", "GET", `${base.organization()}/${org.id}/value`)).status).toBe(200);
    // nothing was revealed, or audited, for the refused
    const refused = (await events("variable.reveal")).filter((e) => e.resourceId === mine.id);
    expect(refused).toHaveLength(0);
  });
});

describe("the resolved set of an environment", () => {
  test("most specific wins, references are filled in, what reads a secret is hidden", async () => {
    const [token, file] = [sekrit("rtoken"), sekrit("rfile")];
    const org = (key: string, over: object) => make(base.organization(), { key, ...over });
    const project = (key: string, over: object) => make(base.project(), { key, ...over });
    const env = (key: string, over: object) => make(base.environment(), { key, ...over });
    await org("R_BASE", { value: "org" });
    await project("R_BASE", { value: "project" });
    const winner = await env("R_BASE", { value: "env" });
    await env("R_HOST", { value: "h" });
    await project("R_URL", { value: "https://${R_HOST}/x" });
    await org("R_TOKEN", { kind: "secret", value: token });
    await project("R_USES", { value: "t=${R_TOKEN}" });
    await project("R_FILE", { kind: "file", value: file });
    await project("R_MISSING", { value: "${R_NOPE}" });
    await project("R_A", { value: "${R_B}" });
    await project("R_B", { value: "${R_A}" });
    await project("R_LITERAL", { value: "$${R_HOST}" });

    const res = await call("carol", "GET", resolvedPath());
    expect(res.status).toBe(200);
    const mine = res.json.variables.filter((v: { key: string }) => v.key.startsWith("R_"));
    expect(mine).toEqual([
      expect.objectContaining({ key: "R_BASE", level: "environment", id: winner.id, value: "env" }),
      expect.objectContaining({ key: "R_FILE", kind: "file", tainted: false, value: null }),
      expect.objectContaining({ key: "R_HOST", value: "h" }),
      expect.objectContaining({ key: "R_LITERAL", value: "${R_HOST}" }),
      expect.objectContaining({ key: "R_TOKEN", kind: "secret", tainted: false, value: null }),
      expect.objectContaining({
        key: "R_URL",
        kind: "plain",
        tainted: false,
        value: "https://h/x",
      }),
      expect.objectContaining({ key: "R_USES", kind: "secret", tainted: true, value: null }),
    ]);
    const issues = res.json.issues.filter((i: { key: string }) => i.key.startsWith("R_"));
    expect(issues).toEqual([
      { code: "cycle", key: "R_A", path: ["R_A", "R_B", "R_A"] },
      { code: "missing", key: "R_MISSING", ref: "R_NOPE" },
    ]);
    expect(res.text).not.toContain(token);
    expect(res.text).not.toContain(file);
  });

  test("is for readers of the project, and of an environment that is in it", async () => {
    expect((await call("erin", "GET", resolvedPath())).status).toBe(404);
    expect((await call(undefined, "GET", resolvedPath())).status).toBe(401);
    expect((await call("alice", "GET", resolvedPath(ids.other, ids.p1))).status).toBe(404);
    expect((await call("alice", "GET", resolvedPath(ids.dev, ids.p1, ids.o2))).status).toBe(404);
  });
});

describe("when the stored secrets cannot be opened", () => {
  test("a fixed 500 that names no value, and a log line with a code only", async () => {
    const value = sekrit("unreadable");
    const v = await make(base.project(), { value: "p" });
    await make(base.project(), { kind: "secret", value });
    const wrongKeys = makeApp(OTHER_KEYS);
    const from = lines.length;
    for (const path of [base.project(), `${base.project()}/${v.id}`, resolvedPath()]) {
      const res = await call("alice", "GET", path, undefined, wrongKeys);
      expect([path, res.status, res.json.code]).toEqual([path, 500, "secret_unreadable"]);
    }
    const reveal = await call(
      "alice",
      "GET",
      `${base.project()}/${v.id}/value`,
      undefined,
      wrongKeys,
    );
    expect([reveal.status, reveal.json.code]).toEqual([500, "secret_unreadable"]);
    const mine = lines.slice(from);
    expect(mine.some((l) => l.includes("cannot be opened") && l.includes('"code"'))).toBe(true);
    expect(mine.join("\n")).not.toContain(value);
  });
});

const wait = () => Bun.sleep(8); // more than the millisecond a moment is named by
const versionsOf = async (path: string) =>
  (await call("alice", "GET", `${path}/versions`)).json.items as {
    version: number;
    reason: string | null;
  }[];

describe("rolling one variable back", () => {
  test("an earlier value is put back as a new version; a secret stays hidden", async () => {
    const [a, b, c] = [sekrit("rb-1"), sekrit("rb-2"), sekrit("rb-3")];
    const v = await make(base.environment(), { kind: "secret", value: a });
    const path = `${base.environment()}/${v.id}`;
    for (const value of [b, c])
      expect((await call("alice", "PATCH", path, { value })).status).toBe(200);

    const res = await call("alice", "POST", `${path}/restore`, { version: 1 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: v.id, kind: "secret", version: 4, value: null });
    expect((await call("alice", "GET", `${path}/value`)).json).toMatchObject({
      version: 4,
      value: a,
    });
    // the history is only added to
    expect((await call("alice", "GET", `${path}/value?version=2`)).json.value).toBe(b);
    expect((await call("alice", "GET", `${path}/value?version=3`)).json.value).toBe(c);
    expect(await versionsOf(path)).toMatchObject([
      { version: 4, reason: "restored from version 1" },
      { version: 3 },
      { version: 2 },
      { version: 1 },
    ]);

    // a reason of its own, and the current version can be put back too
    const again = await call("alice", "POST", `${path}/restore`, {
      version: 2,
      reason: "ticket 7",
    });
    expect(again.json.version).toBe(5);
    expect((await versionsOf(path))[0]).toMatchObject({ version: 5, reason: "ticket 7" });
    expect((await call("alice", "GET", `${path}/value`)).json.value).toBe(b);

    const plain = await make(base.project(), { value: "first" });
    const plainPath = `${base.project()}/${plain.id}`;
    await call("alice", "PATCH", plainPath, { value: "second" });
    expect(
      (await call("alice", "POST", `${plainPath}/restore`, { version: 1 })).json,
    ).toMatchObject({
      version: 3,
      value: "first",
    });
  });

  test("is audited with the version it came from, never the value", async () => {
    const v = await make(base.project(), { kind: "secret", value: sekrit("rb-audit") });
    const path = `${base.project()}/${v.id}`;
    await call("alice", "PATCH", path, { value: sekrit("rb-audit-2") });
    await call("alice", "POST", `${path}/restore`, { version: 1 });
    const rows = (await events("variable.update")).filter((e) => e.resourceId === v.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((e) => e.metadata)).toContainEqual({
      level: "project",
      key: v.key,
      kind: "secret",
      fields: ["value"],
      version: 3,
      restoredVersion: 1,
    });
  });

  test("a version or a variable that is not there is a 404, and the body names one version", async () => {
    const v = await make(base.environment(), { value: "x" });
    const path = `${base.environment()}/${v.id}`;
    const gone = await make(base.environment(), { value: "x" });
    await call("alice", "DELETE", `${base.environment()}/${gone.id}`);
    for (const url of [
      `${path}/restore`, // version 99 below
      `${base.environment()}/${gone.id}/restore`,
      `${base.environment()}/${crypto.randomUUID()}/restore`,
      `${base.project()}/${v.id}/restore`, // an environment's variable, asked for as the project's
    ]) {
      const res = await call("alice", "POST", url, { version: url === `${path}/restore` ? 99 : 1 });
      expect([url, res.status]).toEqual([url, 404]);
    }
    for (const body of [
      {},
      { version: 0 },
      { version: 1.5 },
      { version: "1" },
      { version: 1, key: "X" },
    ]) {
      const res = await call("alice", "POST", `${path}/restore`, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    expect(await versionsOf(path)).toHaveLength(1);
  });

  test("needs the right to write and the master keys", async () => {
    const v = await make(base.project(), { kind: "secret", value: sekrit("rb-who") });
    const path = `${base.project()}/${v.id}/restore`;
    expect((await call("carol", "POST", path, { version: 1 })).status).toBe(403);
    expect((await call("erin", "POST", path, { version: 1 })).status).toBe(404);
    expect((await call(undefined, "POST", path, { version: 1 })).status).toBe(401);
    expect((await call("bob", "POST", path, { version: 1 })).status).toBe(200);
    const org = await make(base.organization(), { value: "o" });
    const orgPath = `${base.organization()}/${org.id}/restore`;
    expect((await call("bob", "POST", orgPath, { version: 1 })).status).toBe(403);
    expect((await call("alice", "POST", orgPath, { version: 1 })).status).toBe(200);
    const before = (await versionsOf(`${base.project()}/${v.id}`)).length;
    const bare = await call("alice", "POST", path, { version: 1 }, makeApp(undefined));
    expect([bare.status, bare.json.code]).toEqual([503, "secrets_unavailable"]);
    expect(await versionsOf(`${base.project()}/${v.id}`)).toHaveLength(before);
  });
});

let freshCount = 0;
/** An organization of its own, so that a level holds only what a test put there. */
async function fresh() {
  const slug = `fx${++freshCount}-${Bun.randomUUIDv7().slice(-8)}`;
  const org = (await createOrganization(t.db, { slug, name: slug })).id;
  const project = (await createProject(t.db, { organizationId: org, name: "fx" })).id;
  const env = (
    await createEnvironment(t.db, {
      organizationId: org,
      projectId: project,
      name: "fx",
      slug: "fx",
    })
  ).id;
  const alice = roleTable.get(901);
  roleTable.set(901, { orgRoles: { ...alice?.orgRoles, [org]: "admin" }, projectRoles: {} });
  return {
    organization: base.organization(org),
    project: base.project(project, org),
    environment: base.environment(env, project, org),
  };
}

/**
 * What a level goes through after the moment `T`: A and B change, C is deleted, D is added, E stays,
 * and F is deleted and made again as another kind.
 */
async function timeline(path: string) {
  const mk = (key: string, kind: string, value: string) =>
    make(path, { key, kind, value, description: `about ${key}` });
  const [b1, b2, f1] = [sekrit("tl-b1"), sekrit("tl-b2"), sekrit("tl-f1")];
  const A = await mk("A", "plain", "a1");
  const B = await mk("B", "secret", b1);
  const C = await mk("C", "plain", "c1");
  const E = await mk("E", "plain", "e1");
  const F = await mk("F", "secret", f1);
  await wait();
  const T = F.createdAt as string;
  await wait();
  await call("alice", "PATCH", `${path}/${A.id}`, { value: "a2" });
  await call("alice", "PATCH", `${path}/${B.id}`, { value: b2 });
  await call("alice", "DELETE", `${path}/${C.id}`);
  const D = await mk("D", "plain", "d1");
  await call("alice", "DELETE", `${path}/${F.id}`);
  await mk("F", "plain", "f2");
  return { A, B, C, D, E, F, T, b1, b2 };
}

const counts = async () => ({
  variables: (await t.db.select({ n: count() }).from(variables))[0]?.n,
  versions: (await t.db.select({ n: count() }).from(variableVersions))[0]?.n,
  audits: (await t.db.select({ n: count() }).from(auditEvents))[0]?.n,
});
// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
const byKey = (rows: { key: string }[]): Record<string, any> =>
  Object.fromEntries(rows.map((r) => [r.key, r]));
const list = async (path: string) =>
  byKey((await call("alice", "GET", `${path}?limit=100`)).json.items);

describe("a level at an earlier moment", () => {
  test("shows what existed then: values of plain variables, versions of the others", async () => {
    const f = await fresh();
    for (const level of LEVELS) {
      const path = f[level];
      const { T, A, B, C, D } = await timeline(path);
      const then = await call("alice", "GET", `${path}/snapshot?at=${T}`);
      expect(then.status).toBe(200);
      expect(then.json.at).toBe(T);
      expect(then.json.variables.map((v: { key: string }) => v.key)).toEqual([
        "A",
        "B",
        "C",
        "E",
        "F",
      ]);
      const got = byKey(then.json.variables);
      expect(got.A).toMatchObject({ id: A.id, kind: "plain", value: "a1", version: 1 });
      expect(got.B).toMatchObject({ id: B.id, kind: "secret", value: null, version: 1 });
      expect(got.C).toMatchObject({ id: C.id, value: "c1" });
      expect(got.F).toMatchObject({ kind: "secret", value: null });
      expect(got).not.toHaveProperty("D");
      expect(Object.keys(then.json.variables[0]).sort()).toEqual([
        "description",
        "id",
        "key",
        "kind",
        "value",
        "version",
      ]);

      const now = await call("alice", "GET", `${path}/snapshot?at=${new Date().toISOString()}`);
      const current = byKey(now.json.variables);
      expect(Object.keys(current).sort()).toEqual(["A", "B", "D", "E", "F"]);
      expect(current.A).toMatchObject({ value: "a2", version: 2 });
      expect(current.B).toMatchObject({ value: null, version: 2 });
      expect(current.D.id).toBe(D.id);
      expect(current.F).toMatchObject({ kind: "plain", value: "f2" });

      const before = await call("alice", "GET", `${path}/snapshot?at=2000-01-01T00:00:00Z`);
      expect(before.json.variables).toEqual([]);
    }
  });

  test("asks for a moment that is there and not ahead of us, at a level that is there", async () => {
    const f = await fresh();
    for (const at of ["", "?at=", "?at=yesterday", "?at=2020-01-01", "?at=2999-01-01T00:00:00Z"]) {
      for (const route of ["snapshot", "restore-plan"]) {
        const res = await call("alice", "GET", `${f.environment}/${route}${at}`);
        expect([route, at, res.status]).toEqual([route, at, 422]);
      }
    }
    // an unencoded "+" reaches the server as a space, and the answer says what to do
    const spaced = await call(
      "alice",
      "GET",
      `${f.environment}/snapshot?at=2020-01-01T02:00:00+02:00`,
    );
    expect([spaced.status, spaced.text]).toEqual([422, expect.stringContaining("%2B")]);
    // a zone is part of the moment: 02:00 at +02:00 is midnight UTC
    const zoned = await call(
      "alice",
      "GET",
      `${f.environment}/snapshot?at=2020-01-01T02:00:00%2B02:00`,
    );
    expect([zoned.status, zoned.json.at]).toEqual([200, "2020-01-01T00:00:00.000Z"]);
    const missing = base.environment(crypto.randomUUID(), ids.p1);
    for (const route of ["snapshot", "restore-plan"]) {
      const res = await call("alice", "GET", `${missing}/${route}?at=2020-01-01T00:00:00Z`);
      expect([route, res.status]).toEqual([route, 404]);
    }
    const res = await call("alice", "POST", `${missing}/restore`, { at: "2020-01-01T00:00:00Z" });
    expect(res.status).toBe(404);
  });

  test("the plan says what a restore would do, names no value and changes nothing", async () => {
    const f = await fresh();
    const { T } = await timeline(f.environment);
    const before = await counts();
    const res = await call("alice", "GET", `${f.environment}/restore-plan?at=${T}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      at: T,
      changes: [
        { change: "update", key: "A", kind: "plain" },
        { change: "update", key: "B", kind: "secret" },
        { change: "create", key: "C", kind: "plain" },
        { change: "remove", key: "D", kind: "plain" },
        { change: "conflict", key: "F", kind: "secret" },
      ],
    });
    for (const text of ["a1", "a2", "c1", "d1", "f2"]) expect(res.text).not.toContain(`"${text}"`);
    expect(await counts()).toEqual(before);
    // a plan for a moment when nothing was there asks to remove everything, and still changes nothing
    const wipe = await call(
      "alice",
      "GET",
      `${f.environment}/restore-plan?at=2000-01-01T00:00:00Z`,
    );
    expect(wipe.json.changes.map((c: { change: string }) => c.change)).toEqual([
      "remove",
      "remove",
      "remove",
      "remove",
      "remove",
    ]);
    expect(await counts()).toEqual(before);
  });

  test("a restore puts back what changed or went, keeps what was added, and never touches another level", async () => {
    for (const level of LEVELS) {
      const f = await fresh();
      const others = LEVELS.filter((l) => l !== level);
      for (const other of others) await make(f[other], { key: "A", value: `other-${level}` });
      const path = f[level];
      const { T, A, B, C, D, F, b1 } = await timeline(path);
      const before = await counts();

      const res = await call("alice", "POST", `${path}/restore`, { at: T });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        at: T,
        changes: [
          { change: "update", key: "A", kind: "plain", applied: true },
          { change: "update", key: "B", kind: "secret", applied: true },
          { change: "create", key: "C", kind: "plain", applied: true },
          { change: "remove", key: "D", kind: "plain", applied: false },
          { change: "conflict", key: "F", kind: "secret", applied: false },
        ],
      });

      const now = await list(path);
      expect(now.A).toMatchObject({ id: A.id, value: "a1", version: 3 });
      expect(now.B).toMatchObject({ id: B.id, value: null, version: 3 });
      expect((await call("alice", "GET", `${path}/${B.id}/value`)).json.value).toBe(b1);
      expect(now.C).toMatchObject({
        kind: "plain",
        value: "c1",
        version: 1,
        description: "about C",
      });
      expect(now.C.id).not.toBe(C.id);
      expect((await call("alice", "GET", `${path}/${C.id}`)).status).toBe(404);
      expect(now.D.id).toBe(D.id); // added since: kept without prune
      expect(now.F).toMatchObject({ kind: "plain", value: "f2" }); // a kind cannot change
      expect(now.F.id).not.toBe(F.id);
      expect((await versionsOf(`${path}/${A.id}`))[0]).toMatchObject({
        version: 3,
        reason: `restored to ${T}`,
      });
      for (const other of others) expect((await list(f[other])).A.value).toBe(`other-${level}`);
      const after = await counts();
      expect(after.variables).toBe((before.variables ?? 0) + 1); // C, made again
      expect(after.versions).toBe((before.versions ?? 0) + 3);
    }
  });

  test("done twice, it changes nothing the second time; with prune it removes what was added", async () => {
    const f = await fresh();
    const path = f.project;
    const { T, D } = await timeline(path);
    expect((await call("alice", "POST", `${path}/restore`, { at: T })).status).toBe(200);
    const plan = await call("alice", "GET", `${path}/restore-plan?at=${T}`);
    expect(plan.json.changes).toEqual([
      { change: "remove", key: "D", kind: "plain" },
      { change: "conflict", key: "F", kind: "secret" },
    ]);
    const before = await counts();
    const again = await call("alice", "POST", `${path}/restore`, { at: T });
    expect(again.json.changes.every((c: { applied: boolean }) => !c.applied)).toBe(true);
    expect({ ...(await counts()), audits: 0 }).toEqual({ ...before, audits: 0 });

    const pruned = await call("alice", "POST", `${path}/restore`, { at: T, prune: true });
    expect(pruned.json.changes).toEqual([
      { change: "remove", key: "D", kind: "plain", applied: true },
      { change: "conflict", key: "F", kind: "secret", applied: false },
    ]);
    expect((await call("alice", "GET", `${path}/${D.id}`)).status).toBe(404);
    expect((await call("alice", "GET", `${path}/restore-plan?at=${T}`)).json.changes).toEqual([
      { change: "conflict", key: "F", kind: "secret" },
    ]);
  });

  test("is audited: a row for each change, and one for the restore, with names and counts only", async () => {
    const f = await fresh();
    const path = f.environment;
    const { T } = await timeline(path);
    await call("alice", "POST", `${path}/restore`, { at: T, prune: true });
    const mine = (action: string) =>
      events(action).then((rows) =>
        rows.filter((e) => (e.metadata as { restoredTo?: string } | null)?.restoredTo === T),
      );
    const names = async (action: string) =>
      (await mine(action)).map((e) => (e.metadata as { key?: string }).key).sort();
    expect(await names("variable.update")).toEqual(["A", "B"]);
    expect(await names("variable.create")).toEqual(["C"]);
    expect(await names("variable.delete")).toEqual(["D"]);
    const [summary, ...rest] = await mine("variable.restore_level");
    expect(rest).toEqual([]);
    expect(summary?.metadata).toEqual({
      level: "environment",
      environmentId: expect.any(String),
      restoredTo: T,
      prune: true,
      plannedCount: 5,
      appliedCount: 4,
    });
    // nothing to do is on record too
    const rowsBefore = (await mine("variable.restore_level")).length;
    await call("alice", "POST", `${path}/restore`, { at: T });
    expect((await mine("variable.restore_level")).length).toBe(rowsBefore + 1);
  });

  test("who may: readers look, maintainers restore a project, only admins an organization", async () => {
    const past = "2020-01-01T00:00:00Z";
    const level = (
      who: Who | undefined,
      path: string,
      method: string,
      tail: string,
      body?: unknown,
    ) => call(who, method, `${path}/${tail}`, body).then((r) => r.status);
    expect(await level("carol", base.project(), "GET", `snapshot?at=${past}`)).toBe(200);
    // a plan compares secrets with their past, so it takes the right to restore
    expect(await level("carol", base.project(), "GET", `restore-plan?at=${past}`)).toBe(403);
    expect(await level("bob", base.project(), "GET", `restore-plan?at=${past}`)).toBe(200);
    expect(await level("bob", base.organization(), "GET", `restore-plan?at=${past}`)).toBe(403);
    const one = await make(base.project(), { value: "x" });
    expect(await level("carol", base.project(), "POST", `${one.id}/restore`, { version: 1 })).toBe(
      403,
    );
    expect(await level("carol", base.organization(), "GET", `snapshot?at=${past}`)).toBe(404);
    expect(await level("carol", base.project(), "POST", "restore", { at: past })).toBe(403);
    expect(await level("carol", base.environment(), "POST", "restore", { at: past })).toBe(403);
    expect(await level("bob", base.project(), "POST", "restore", { at: past })).toBe(200);
    expect(await level("bob", base.environment(), "POST", "restore", { at: past })).toBe(200);
    expect(await level("bob", base.organization(), "GET", `snapshot?at=${past}`)).toBe(200);
    expect(await level("bob", base.organization(), "POST", "restore", { at: past })).toBe(403);
    expect(await level("alice", base.organization(), "POST", "restore", { at: past })).toBe(200);
    expect(await level("erin", base.project(), "GET", `snapshot?at=${past}`)).toBe(404);
    expect(await level("erin", base.project(), "POST", "restore", { at: past })).toBe(404);
    expect(await level(undefined, base.project(), "GET", `snapshot?at=${past}`)).toBe(401);
  });

  test("needs the master keys, and a body that names a moment and nothing else", async () => {
    const f = await fresh();
    const { T } = await timeline(f.environment);
    const bare = makeApp(undefined);
    const before = await counts();
    for (const [method, tail, body] of [
      ["GET", `snapshot?at=${T}`],
      ["GET", `restore-plan?at=${T}`],
      ["POST", "restore", { at: T }],
    ] as const) {
      const res = await call("alice", method, `${f.environment}/${tail}`, body, bare);
      expect([tail, res.status, res.json.code]).toEqual([tail, 503, "secrets_unavailable"]);
    }
    expect(await counts()).toEqual(before);
    for (const body of [
      {},
      { at: "yesterday" },
      { at: "2999-01-01T00:00:00Z" },
      { at: T, prune: "yes" },
      { at: T, prune: 1 },
      { at: T, extra: true },
    ]) {
      const res = await call("alice", "POST", `${f.environment}/restore`, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    expect(await counts()).toEqual(before);
  });
});

describe("secrets stay secret", () => {
  test("no answer, log line or audit row of this suite holds a secret, except a reveal", async () => {
    expect(markers.length).toBeGreaterThan(20);
    expect(seen.length).toBeGreaterThan(100);
    const audits = JSON.stringify(await t.db.select().from(auditEvents));
    for (const m of markers) {
      expect(audits).not.toContain(m);
      expect(lines.join("\n")).not.toContain(m);
      for (const s of seen) {
        if (!s.reveal) expect([s.path, s.text.includes(m)]).toEqual([s.path, false]);
      }
    }
    // the check can fail: reveals do carry the value
    const revealed = seen.filter((s) => s.reveal && markers.some((m) => s.text.includes(m)));
    expect(revealed.length).toBeGreaterThan(3);
    // and so does the database, in plaintext, nowhere
    for (const row of await t.db.select().from(variableVersions)) {
      const stored = Buffer.from(row.valueEnc).toString("latin1");
      for (const m of markers) expect(stored).not.toContain(m);
    }
  });
});
