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
  getRotation,
  setRotation,
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
  seen.push({ path, text, reveal: method === "GET" && /\/values?(\?|$)/.test(path) });
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
  tags: string[];
  folder: string;
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
          "folder",
          "id",
          "key",
          "kind",
          "level",
          "organizationId",
          "projectId",
          "tags",
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

describe("tags", () => {
  const tagsOf = async (path: string, id: string) =>
    (await call("alice", "GET", `${path}/${id}`)).json.tags;

  test("a variable has none until given some; given some they are sorted without repeats, at every level", async () => {
    for (const path of [base.organization(), base.project(), base.environment()]) {
      const bare = await make(path);
      expect(bare.tags).toEqual([]);
      const tagged = await make(path, { tags: ["eu", "api", "eu", "0-9"] });
      expect(tagged.tags).toEqual(["0-9", "api", "eu"]);
      expect(await tagsOf(path, tagged.id)).toEqual(["0-9", "api", "eu"]);
      const listed = await call("alice", "GET", path);
      expect(listed.json.items.find((x: Dto) => x.id === tagged.id).tags).toEqual([
        "0-9",
        "api",
        "eu",
      ]);
      expect(listed.json.items.find((x: Dto) => x.id === bare.id).tags).toEqual([]);
    }
  });

  test("a patch of tags alone replaces them: no new version, the value and description stay", async () => {
    const v = await make(base.project(), { value: "same", description: "words", tags: ["old"] });
    const path = `${base.project()}/${v.id}`;
    const res = await call("alice", "PATCH", path, { tags: ["b", "a"] });
    expect([
      res.status,
      res.json.tags,
      res.json.version,
      res.json.value,
      res.json.description,
    ]).toEqual([200, ["a", "b"], 1, "same", "words"]);
    expect(await tagsOf(base.project(), v.id)).toEqual(["a", "b"]);
    // a patch without tags leaves them; an empty list clears them
    await call("alice", "PATCH", path, { description: "changed" });
    expect(await tagsOf(base.project(), v.id)).toEqual(["a", "b"]);
    const cleared = await call("alice", "PATCH", path, { tags: [] });
    expect([cleared.status, cleared.json.tags]).toEqual([200, []]);
    const both = await call("alice", "PATCH", path, {
      description: "d",
      tags: ["x"],
      value: "new",
    });
    expect([both.json.tags, both.json.version, both.json.description]).toEqual([["x"], 2, "d"]);
    // a reason belongs to a new value, as before
    expect((await call("alice", "PATCH", path, { tags: ["y"], reason: "why" })).status).toBe(422);
  });

  test("a tag that is not a tag, or a ninth, is a 422 on create and on patch, and nothing changes", async () => {
    const v = await make(base.project(), { tags: ["keep"] });
    const path = `${base.project()}/${v.id}`;
    const bad: unknown[] = [
      ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
      ["x".repeat(25)],
      ["Api"],
      [""],
      ["a b"],
      ["a,b"],
      ["under_score"],
      "api",
      [1],
      null,
    ];
    for (const tags of bad) {
      const label = JSON.stringify(tags);
      const made = await call("alice", "POST", base.project(), {
        key: "TAGGED_BAD",
        kind: "plain",
        value: "v",
        tags,
      });
      expect([label, made.status, made.json.code]).toEqual([label, 422, "validation_failed"]);
      const patched = await call("alice", "PATCH", path, { tags });
      expect([label, patched.status]).toEqual([label, 422]);
    }
    expect(await tagsOf(base.project(), v.id)).toEqual(["keep"]);
    const stored = await t.db
      .select({ total: count() })
      .from(variables)
      .where(eq(variables.key, "TAGGED_BAD"));
    expect(stored).toEqual([{ total: 0 }]);
    // eight, each as long as one may be, is fine
    const full = await call("alice", "PATCH", path, {
      tags: ["a", "b", "c", "d", "e", "f", "g", "x".repeat(24)],
    });
    expect([full.status, full.json.tags.length]).toEqual([200, 8]);
  });

  test("the resolved set carries the tags of the variable that wins, and of a secret, which has no value", async () => {
    const secret = sekrit("tagged");
    await make(base.project(), { key: "T_BASE", value: "p", tags: ["from-project"] });
    const winner = await make(base.environment(), {
      key: "T_BASE",
      value: "e",
      tags: ["from-env", "api"],
    });
    await make(base.project(), { key: "T_PLAIN", value: "v" });
    await make(base.organization(), {
      key: "T_SECRET",
      kind: "secret",
      value: secret,
      tags: ["billing"],
    });
    const res = await call("carol", "GET", resolvedPath());
    expect(res.status).toBe(200);
    const mine = res.json.variables.filter((v: { key: string }) => v.key.startsWith("T_"));
    expect(mine).toEqual([
      expect.objectContaining({ key: "T_BASE", id: winner.id, tags: ["api", "from-env"] }),
      expect.objectContaining({ key: "T_PLAIN", tags: [] }),
      expect.objectContaining({ key: "T_SECRET", value: null, tags: ["billing"] }),
    ]);
    expect(res.text).not.toContain(secret);
  });

  test("an update names `tags` among the fields it changed, and the audit row holds no tag text or value", async () => {
    const value = sekrit("tagaudit");
    const v = await make(base.project(), { kind: "secret", value });
    await call("alice", "PATCH", `${base.project()}/${v.id}`, { tags: ["audit-me-not"] });
    await call("alice", "PATCH", `${base.project()}/${v.id}`, { tags: [], description: "d" });
    const rows = (await events("variable.update")).filter((e) => e.resourceId === v.id);
    const meta = { level: "project", key: v.key, kind: "secret", version: 1 };
    expect(rows.map((r) => r.metadata)).toEqual(
      expect.arrayContaining([
        { ...meta, fields: ["tags"] },
        { ...meta, fields: ["description", "tags"] },
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain(value);
    expect(JSON.stringify(rows)).not.toContain("audit-me-not");
  });

  test("who may change them: a maintainer, not a reporter; and only under the variable's own project", async () => {
    const v = await make(base.project(), { tags: ["mine"] });
    const path = `${base.project()}/${v.id}`;
    expect((await call("carol", "PATCH", path, { tags: ["hijack"] })).status).toBe(403);
    expect(
      (
        await call("carol", "POST", base.project(), {
          key: "CT",
          kind: "plain",
          value: "v",
          tags: ["x"],
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("alice", "PATCH", `${base.project(ids.p2)}/${v.id}`, { tags: ["hijack"] }))
        .status,
    ).toBe(404);
    expect((await call("erin", "PATCH", path, { tags: ["hijack"] })).status).toBe(404);
    expect(await tagsOf(base.project(), v.id)).toEqual(["mine"]);
    expect((await call("bob", "PATCH", path, { tags: ["bob"] })).json.tags).toEqual(["bob"]);
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
        "folder",
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

describe("variables in folders", () => {
  // Project p2 and its environment: few variables of their own, so a list is one page.
  const P = () => base.project(ids.p2);
  const E = () => base.environment(ids.other, ids.p2);
  const folderPath = () => `/organizations/${ids.o1}/projects/${ids.p2}/folders`;
  const resolvedHere = (folder?: string) =>
    `${resolvedPath(ids.other, ids.p2)}${folder ? inFolder(folder) : ""}`;
  const exportHere = (folder?: string) =>
    `${resolvedHere()}/values${folder ? inFolder(folder) : ""}`;
  const inFolder = (path: string) => `?folder=${encodeURIComponent(path)}`;
  const idsOf = (res: { json: { items: { id: string }[] } }) => res.json.items.map((v) => v.id);
  const keysOf = (rows: { key: string }[]) => rows.map((v) => v.key).sort();
  type Row = { key: string; value: string; folder: string };
  type Issue = { code: string; key: string; folder?: string; ref?: string };
  const mine = <T extends { key: string }>(rows: T[]) => rows.filter((v) => v.key.startsWith("F_"));
  const folder = async (name: string, parent?: string) => {
    const res = await call("alice", "POST", folderPath(), parent ? { parent, name } : { name });
    expect(res.status).toBe(201);
    return res.json as { id: string; path: string };
  };
  beforeAll(async () => {
    await folder("pay");
    await folder("search");
  });

  test("a key is held once in each folder, each is read alone, and the root holds none of a folder's", async () => {
    const root = await make(P(), { key: "F_DB", value: "root" });
    const pay = await make(P(), { key: "F_DB", value: "pay", folder: "/pay" });
    const search = await make(P(), { key: "F_DB", value: "search", folder: "/search" });
    expect([root.folder, pay.folder, search.folder]).toEqual(["/", "/pay", "/search"]);
    expect([pay.value, search.value]).toEqual(["pay", "search"]);

    const twice = await call("alice", "POST", P(), {
      key: "F_DB",
      kind: "plain",
      value: "x",
      folder: "/pay",
    });
    expect([twice.status, twice.json.code]).toEqual([409, "key_taken"]);

    expect(idsOf(await call("alice", "GET", `${P()}${inFolder("/pay")}`))).toEqual([pay.id]);
    expect(idsOf(await call("alice", "GET", `${P()}${inFolder("/search")}`))).toEqual([search.id]);
    const atRoot = idsOf(await call("alice", "GET", P()));
    expect(atRoot).toContain(root.id);
    expect(atRoot).not.toContain(pay.id);
    expect(atRoot).not.toContain(search.id);
    expect(idsOf(await call("alice", "GET", `${P()}${inFolder("/")}`))).toEqual(atRoot);

    // by id, whichever folder; a new value keeps the folder
    expect((await call("alice", "GET", `${P()}/${pay.id}`)).json.folder).toBe("/pay");
    const patched = await call("alice", "PATCH", `${P()}/${pay.id}`, { value: "pay2" });
    expect([patched.json.folder, patched.json.value, patched.json.version]).toEqual([
      "/pay",
      "pay2",
      2,
    ]);

    // an environment holds the same address too, apart from the project's
    const env = await make(E(), { key: "F_DB", value: "env-pay", folder: "/pay" });
    const envRoot = await make(E(), { key: "F_DB", value: "env-root" });
    expect(idsOf(await call("alice", "GET", `${E()}${inFolder("/pay")}`))).toEqual([env.id]);
    expect(idsOf(await call("alice", "GET", E()))).toEqual([envRoot.id]);
  });

  test("a folder that is not there is a 404 and nothing is made; a path that is not one is a 422", async () => {
    const before = idsOf(await call("alice", "GET", P()));
    const other = await call(
      "alice",
      "POST",
      `/organizations/${ids.o1}/projects/${ids.p1}/folders`,
      {
        name: "elsewhere",
      },
    );
    const gone = await folder("gone");
    expect((await call("alice", "DELETE", `${folderPath()}/${gone.id}`)).status).toBe(204);
    for (const path of ["/nope", "/pay/deeper", "/elsewhere", "/gone"]) {
      for (const [where, body] of [
        [P(), { key: "F_NO", kind: "plain", value: "v", folder: path }],
        [E(), { key: "F_NO", kind: "plain", value: "v", folder: path }],
        [base.organization(), { key: "F_NO", kind: "plain", value: "v", folder: path }],
      ] as const) {
        const res = await call("alice", "POST", where, body);
        expect([path, where, res.status, res.json.code]).toEqual([path, where, 404, "not_found"]);
      }
      for (const where of [P(), E(), base.organization()]) {
        const res = await call("alice", "GET", `${where}${inFolder(path)}`);
        expect([path, where, res.status]).toEqual([path, where, 404]);
      }
    }
    expect(other.status).toBe(201); // the other project's folder is real, only not this project's
    for (const path of ["pay", "/Pay", "/pay/", "//", "/a/b/c/d/e/f", ""]) {
      const made = await call("alice", "POST", P(), {
        key: "F_NO",
        kind: "plain",
        value: "v",
        folder: path,
      });
      expect([path, made.status]).toEqual([path, 422]);
      expect([path, (await call("alice", "GET", `${P()}${inFolder(path)}`)).status]).toEqual([
        path,
        422,
      ]);
    }
    expect(idsOf(await call("alice", "GET", P()))).toEqual(before);
    // the root, named, is fine at the organization level: it is where an organization's variables are
    const org = await call("alice", "POST", base.organization(), {
      key: "F_ORG",
      kind: "plain",
      value: "v",
      folder: "/",
    });
    expect([org.status, org.json.folder]).toEqual([201, "/"]);
  });

  test("a body that names a folder where none is read is refused, never put at the root", async () => {
    const v = await make(P(), { key: "F_STAY", value: "v" });
    const before = await call("alice", "GET", P());
    for (const [method, path, body] of [
      ["PATCH", `${P()}/${v.id}`, { value: "w", folder: "/pay" }], // a move is a patch of the folder alone
      ["POST", `${P()}/restore`, { at: "2020-01-01T00:00:00Z", folder: "/pay" }],
      ["POST", `/organizations/${ids.o1}/variable-search`, { key: "F_", folder: "pay" }],
    ] as const) {
      const res = await call("alice", method, path, body);
      expect([method, path, res.status]).toEqual([method, path, 422]);
    }
    expect((await call("alice", "GET", P())).text).toBe(before.text);
  });

  test("the resolved set resolves every folder and returns the one asked for, references between folders included", async () => {
    await make(P(), { key: "F_HOST", value: "pay.example", folder: "/pay" });
    await make(P(), { key: "F_HOST", value: "search.example", folder: "/search" });
    await make(P(), { key: "F_URL", value: "https://${F_HOST}/x", folder: "/pay" });
    await make(P(), { key: "F_URL", value: "https://${F_HOST}/x", folder: "/search" });
    await make(P(), { key: "F_FROM_PAY", value: "${/pay/F_HOST}" });
    await make(P(), { key: "F_ROOT_GAP", value: "${/pay/F_ABSENT}" });
    await make(P(), { key: "F_GAP", value: "${F_ABSENT}", folder: "/pay" });
    // the environment overrides an address, so a reference from another folder sees the override
    await make(E(), { key: "F_HOST", value: "pay-dev.example", folder: "/pay" });

    const answer = async (folder?: string) => {
      const res = await call("alice", "GET", resolvedHere(folder));
      expect(res.status).toBe(200);
      return { variables: mine<Row>(res.json.variables), issues: mine<Issue>(res.json.issues) };
    };
    const pay = await answer("/pay");
    expect(
      pay.variables.map((v: { key: string; value: string; folder: string }) => [
        v.key,
        v.value,
        v.folder,
      ]),
    ).toEqual([
      ["F_DB", "env-pay", "/pay"],
      ["F_HOST", "pay-dev.example", "/pay"],
      ["F_URL", "https://pay-dev.example/x", "/pay"],
    ]);
    expect(pay.issues).toEqual([
      { code: "missing", key: "F_GAP", folder: "/pay", ref: "F_ABSENT" },
    ]);

    const search = await answer("/search");
    expect(search.variables.map((v: { key: string; value: string }) => [v.key, v.value])).toEqual([
      ["F_DB", "search"],
      ["F_HOST", "search.example"],
      ["F_URL", "https://search.example/x"],
    ]);
    expect(search.issues).toEqual([]);

    const root = await answer();
    expect(
      root.variables.map((v: { key: string; value: string; folder: string }) => [
        v.key,
        v.value,
        v.folder,
      ]),
    ).toEqual([
      ["F_DB", "env-root", "/"],
      ["F_FROM_PAY", "pay-dev.example", "/"],
      ["F_ORG", "v", "/"], // the organization's, which has no folders: it is at the root
      ["F_STAY", "v", "/"],
    ]);
    // a reference from the root to a key that is not in the folder it names is the root's issue
    expect(root.issues).toEqual([{ code: "missing", key: "F_ROOT_GAP", ref: "/pay/F_ABSENT" }]);
    expect(await answer("/")).toEqual(root);

    expect((await call("alice", "GET", resolvedHere("/nope"))).status).toBe(404);
    expect((await call("alice", "GET", resolvedHere("pay"))).status).toBe(422);
  });

  test("the values of one folder are exported, and only that folder's secrets are revealed and on record", async () => {
    const [pay, search] = [sekrit("fpay"), sekrit("fsearch")];
    await make(P(), { key: "F_KEY", kind: "secret", value: pay, folder: "/pay" });
    await make(P(), { key: "F_KEY", kind: "secret", value: search, folder: "/search" });
    const marks = async () => ({
      reveals: (await events("variable.reveal")).filter(
        (e) => (e.metadata as { via?: string }).via === "export",
      ).length,
      exports: (await events("variable.export")).length,
    });
    const before = await marks();

    const res = await call("alice", "GET", exportHere("/pay"));
    expect(res.status).toBe(200);
    const values = Object.fromEntries(
      mine<Row>(res.json.variables).map((v: { key: string; value: string }) => [v.key, v.value]),
    );
    expect(values.F_KEY).toBe(pay);
    expect(values.F_HOST).toBe("pay-dev.example");
    expect(res.text).not.toContain(search);

    const after = await marks();
    expect(after.reveals - before.reveals).toBe(1); // F_KEY of /pay; /search's secret was not asked for
    expect(after.exports - before.exports).toBe(1);
    const reveal = (await events("variable.reveal")).filter(
      (e) => (e.metadata as { key?: string; folder?: string }).key === "F_KEY",
    );
    expect(reveal.map((e) => (e.metadata as { folder?: string }).folder)).toEqual(["/pay"]);
    const exports = async () => (await events("variable.export")).map((e) => e.metadata as object);
    expect(await exports()).toContainEqual(
      expect.objectContaining({ folder: "/pay", count: 4, revealedCount: 1, issueCount: 1 }),
    );
    expect(JSON.stringify(await t.db.select().from(auditEvents))).not.toContain(search);

    // the root, by default, says nothing of a folder in the log
    const unnamedBefore = (await exports()).filter((m) => !("folder" in m)).length;
    expect((await call("alice", "GET", exportHere())).status).toBe(200);
    const unnamed = (rows: object[]) => rows.filter((m) => !("folder" in m)).length;
    expect(unnamed(await exports())).toBe(unnamedBefore + 1);

    const missing = await marks();
    expect((await call("alice", "GET", exportHere("/nope"))).status).toBe(404);
    expect((await call("alice", "GET", exportHere("nope"))).status).toBe(422);
    expect(await marks()).toEqual(missing);
  });

  test("the audit row of a variable made in a folder names it, and one at the root does not", async () => {
    const inside = await make(P(), { key: "F_AUDIT", value: "v", folder: "/search" });
    const outside = await make(P(), { key: "F_AUDIT", value: "v" });
    const row = async (id: string, action = "variable.create") =>
      (await events(action)).find((e) => e.resourceId === id);
    expect((await row(inside.id))?.metadata).toMatchObject({ key: "F_AUDIT", folder: "/search" });
    expect((await row(outside.id))?.metadata).not.toHaveProperty("folder");
    await call("alice", "PATCH", `${P()}/${inside.id}`, { description: "d" });
    expect((await row(inside.id, "variable.update"))?.metadata).toMatchObject({
      folder: "/search",
    });
    await call("alice", "DELETE", `${P()}/${inside.id}`);
    expect((await row(inside.id, "variable.delete"))?.metadata).toMatchObject({
      folder: "/search",
    });
  });

  test("the changes feed and a search say which folder each variable is in", async () => {
    const feed = await call(
      "alice",
      "GET",
      `/organizations/${ids.o1}/projects/${ids.p2}/variable-changes`,
    );
    expect(feed.status).toBe(200);
    const hosts = feed.json.items.filter((c: { key: string }) => c.key === "F_HOST");
    expect(hosts.map((c: { folder: string }) => c.folder).sort()).toEqual([
      "/pay",
      "/pay",
      "/search",
    ]);
    expect(feed.json.items.find((c: { key: string }) => c.key === "F_FROM_PAY").folder).toBe("/");

    const search = (body: object) =>
      call("alice", "POST", `/organizations/${ids.o1}/variable-search`, body);
    const all = await search({ key: "F_HOST" });
    expect(keysOf(all.json.items)).toEqual(["F_HOST", "F_HOST", "F_HOST"]);
    expect(all.json.items.map((v: { folder: string }) => v.folder).sort()).toEqual([
      "/pay",
      "/pay",
      "/search",
    ]);
    const inPay = await search({ key: "F_HOST", folder: "/pay" });
    expect(inPay.json.items.map((v: { folder: string }) => v.folder)).toEqual(["/pay", "/pay"]);
    expect((await search({ key: "F_HOST", folder: "/" })).json.items).toEqual([]);
    expect((await search({ key: "F_HOST", folder: "/nope" })).json.items).toEqual([]);
    expect((await search({ key: "F_HOST", folder: "pay" })).status).toBe(422);
  });
});

type Fx = Awaited<ReturnType<typeof fresh>>;
const foldersOf = (f: Fx) => f.project.replace(/\/variables$/, "/folders");
const mkdir = async (f: Fx, name: string) => {
  const res = await call("alice", "POST", foldersOf(f), { name });
  expect(res.status).toBe(201);
  return res.json as { id: string; path: string };
};
const rmdir = async (f: Fx, id: string) =>
  expect((await call("alice", "DELETE", `${foldersOf(f)}/${id}`)).status).toBe(204);
const heldIn = async (path: string, folder: string) =>
  byKey(
    (await call("alice", "GET", `${path}?limit=100&folder=${encodeURIComponent(folder)}`)).json
      .items,
  );
const revealed = async (path: string, id: string) =>
  (await call("alice", "GET", `${path}/${id}/value`)).json.value as string;
type Meta = {
  folder?: string;
  key?: string;
  source?: string;
  restoredTo?: string;
  fields?: string[];
  previousFolder?: string;
  forced?: boolean;
  breakCount?: number;
};
const metaOf = async (action: string) =>
  (await events(action)).map((e) => e.metadata as unknown as Meta);

describe("import, restore and bulk by address", () => {
  const imp = (path: string, body: object) => call("alice", "POST", `${path}/import`, body);
  const bulk = (path: string, ops: object[], dryRun?: boolean) =>
    call("alice", "POST", `${path}/bulk`, dryRun === undefined ? { ops } : { ops, dryRun });
  const planAt = (path: string, at: string) =>
    call("alice", "GET", `${path}/restore-plan?at=${at}`).then((r) => r.json.changes);

  test("an import goes into the folder it names: the preview says so, and the root and the other folders are left alone", async () => {
    const f = await fresh();
    const path = f.project;
    await mkdir(f, "pay");
    const root = await make(path, { key: "I_KEEP", value: "root" });
    const secret = sekrit("import-folder");
    const body = {
      source: "dotenv",
      kind: "plain",
      content: "I_KEEP=pay\nI_NEW=1",
      folder: "/pay",
    };
    const preview = await imp(path, body);
    expect(preview.status).toBe(200);
    expect(preview.json.changes).toEqual([
      { change: "create", key: "I_KEEP", folder: "/pay", kind: "plain", applied: false },
      { change: "create", key: "I_NEW", folder: "/pay", kind: "plain", applied: false },
    ]);
    expect(Object.keys(await heldIn(path, "/pay"))).toEqual([]);

    const done = await imp(path, { ...body, dryRun: false });
    expect(
      done.json.changes.map((c: { key: string; folder: string; applied: boolean }) => [
        c.key,
        c.folder,
        c.applied,
      ]),
    ).toEqual([
      ["I_KEEP", "/pay", true],
      ["I_NEW", "/pay", true],
    ]);
    const inPay = await heldIn(path, "/pay");
    expect(Object.keys(inPay)).toEqual(["I_KEEP", "I_NEW"]);
    expect([inPay.I_KEEP.value, inPay.I_KEEP.folder]).toEqual(["pay", "/pay"]);
    // the root holds its own and nothing else, untouched
    const atRoot = await list(path);
    expect(Object.keys(atRoot)).toEqual(["I_KEEP"]);
    expect([atRoot.I_KEEP.id, atRoot.I_KEEP.value, atRoot.I_KEEP.version]).toEqual([
      root.id,
      "root",
      1,
    ]);

    // the same import again: nothing to do. Another value needs overwrite, and only the folder's changes.
    const again = await imp(path, { ...body, dryRun: false });
    expect(again.json.changes.map((c: { change: string }) => c.change)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    const changed = { ...body, content: "I_KEEP=pay2" };
    expect((await imp(path, changed)).json.changes[0]).toMatchObject({
      change: "conflict",
      folder: "/pay",
    });
    const over = await imp(path, { ...changed, overwrite: true, dryRun: false });
    expect(over.json.changes[0]).toMatchObject({ change: "update", folder: "/pay", applied: true });
    expect((await heldIn(path, "/pay")).I_KEEP).toMatchObject({ value: "pay2", version: 2 });
    expect((await list(path)).I_KEEP).toMatchObject({ value: "root", version: 1 });

    // a secret goes in the same way, and is in no answer
    const hidden = await imp(path, {
      source: "dotenv",
      content: `I_SECRET=${secret}`,
      folder: "/pay",
      dryRun: false,
    });
    expect(hidden.json.changes).toEqual([
      { change: "create", key: "I_SECRET", folder: "/pay", kind: "secret", applied: true },
    ]);
    expect(hidden.text).not.toContain(secret);
    expect(await revealed(path, (await heldIn(path, "/pay")).I_SECRET.id)).toBe(secret);
    expect(Object.keys(await list(path))).toEqual(["I_KEEP"]);

    // no folder named is the root, and its answer says nothing of a folder
    const rootImport = await imp(path, {
      source: "dotenv",
      kind: "plain",
      content: "I_KEEP=root",
      dryRun: false,
    });
    expect(rootImport.json.changes).toEqual([
      { change: "unchanged", key: "I_KEEP", kind: "plain", applied: false },
    ]);
    const named = await imp(path, {
      source: "dotenv",
      kind: "plain",
      content: "I_KEEP=root",
      folder: "/",
    });
    expect(named.json.changes).toEqual(rootImport.json.changes);

    // the trail names the folder: on each variable it made, and on the import itself, a dry run too
    const made = (await metaOf("variable.create")).filter(
      (m) => m.source === "dotenv" && m.key === "I_NEW",
    );
    expect(made.map((m) => m.folder)).toEqual(["/pay"]);
    const summaries = await metaOf("variable.import");
    expect(summaries.filter((m) => m.folder === "/pay").length).toBeGreaterThanOrEqual(5);
    expect(summaries.some((m) => !("folder" in m))).toBe(true);
  });

  test("an import into a folder that is not there is refused, preview and apply, and nothing is made", async () => {
    const f = await fresh();
    const gone = await mkdir(f, "gone");
    await rmdir(f, gone.id);
    const before = await counts();
    for (const folder of ["/nope", "/gone", "/pay/deeper"]) {
      for (const dryRun of [true, false]) {
        for (const path of [f.project, f.environment, f.organization]) {
          const res = await imp(path, { source: "dotenv", content: "I_X=1", folder, dryRun });
          expect([folder, dryRun, path, res.status]).toEqual([folder, dryRun, path, 404]);
        }
      }
    }
    for (const folder of ["pay", "/Pay", "/pay/", ""]) {
      const res = await imp(f.project, { source: "dotenv", content: "I_X=1", folder });
      expect([folder, res.status]).toEqual([folder, 422]);
    }
    expect(await counts()).toEqual(before);
    // an organization's variables are at the root, which it may name
    const org = await imp(f.organization, { source: "dotenv", content: "I_X=1", folder: "/" });
    expect(org.status).toBe(200);
  });

  test("a restore of a level that holds two folders puts each key back in its own, and the plan names the folder", async () => {
    const f = await fresh();
    const path = f.project;
    await mkdir(f, "pay");
    await mkdir(f, "search");
    const [p1, p2] = [sekrit("rs-pay1"), sekrit("rs-pay2")];
    await make(path, { key: "R", value: "r1" });
    const payA = await make(path, { key: "A", kind: "secret", value: p1, folder: "/pay" });
    const searchA = await make(path, { key: "A", value: "s1", folder: "/search" });
    const gone = await make(path, { key: "G", value: "g1", folder: "/search" });
    await wait();
    const T = gone.createdAt as string;
    await wait();
    await call("alice", "PATCH", `${path}/${payA.id}`, { value: p2 });
    await call("alice", "PATCH", `${path}/${searchA.id}`, { value: "s2" });
    await call("alice", "DELETE", `${path}/${gone.id}`);
    const added = await make(path, { key: "N", value: "n1", folder: "/pay" });

    const snap = await call("alice", "GET", `${path}/snapshot?at=${T}`);
    expect(
      snap.json.variables.map((v: { folder: string; key: string }) => [v.folder, v.key]).sort(),
    ).toEqual([
      ["/", "R"],
      ["/pay", "A"],
      ["/search", "A"],
      ["/search", "G"],
    ]);
    expect(snap.text).not.toContain(p1);
    expect(await planAt(path, T)).toEqual([
      { change: "update", key: "A", folder: "/pay", kind: "secret" },
      { change: "remove", key: "N", folder: "/pay", kind: "plain" },
      { change: "update", key: "A", folder: "/search", kind: "plain" },
      { change: "create", key: "G", folder: "/search", kind: "plain" },
    ]);

    const done = await call("alice", "POST", `${path}/restore`, { at: T });
    expect(done.json.changes).toEqual([
      { change: "update", key: "A", folder: "/pay", kind: "secret", applied: true },
      { change: "remove", key: "N", folder: "/pay", kind: "plain", applied: false },
      { change: "update", key: "A", folder: "/search", kind: "plain", applied: true },
      { change: "create", key: "G", folder: "/search", kind: "plain", applied: true },
    ]);
    expect(await revealed(path, payA.id)).toBe(p1);
    const inSearch = await heldIn(path, "/search");
    expect([inSearch.A.value, inSearch.G.value, inSearch.G.folder]).toEqual([
      "s1",
      "g1",
      "/search",
    ]);
    // nothing was put at the root, and its own variable was not touched
    expect(Object.keys(await list(path))).toEqual(["R"]);
    expect((await list(path)).R.version).toBe(1);

    // once done only what was added since is left, and prune removes it
    const left = [{ change: "remove", key: "N", folder: "/pay", kind: "plain" }];
    expect(await planAt(path, T)).toEqual(left);
    const pruned = await call("alice", "POST", `${path}/restore`, { at: T, prune: true });
    expect(pruned.json.changes).toEqual([{ ...left[0], applied: true }]);
    expect((await call("alice", "GET", `${path}/${added.id}`)).status).toBe(404);
    expect(await planAt(path, T)).toEqual([]);

    // the trail says where each change was
    const mine = (await events("variable.update"))
      .concat(await events("variable.create"), await events("variable.delete"))
      .map((e) => e.metadata as unknown as Meta)
      .filter((m) => m.restoredTo === T);
    expect(mine.map((m) => [m.key, m.folder]).sort()).toEqual([
      ["A", "/pay"],
      ["A", "/search"],
      ["G", "/search"],
      ["N", "/pay"],
    ]);
  });

  test("a variable made again in another folder is a create where it was and a remove where it is; one whose folder is gone is not put at the root", async () => {
    const f = await fresh();
    const path = f.project;
    await mkdir(f, "old");
    await mkdir(f, "new");
    const doomed = await mkdir(f, "doomed");
    const x = await make(path, { key: "X", value: "x1", folder: "/old" });
    const y = await make(path, { key: "Y", value: "y1", folder: "/doomed" });
    await wait();
    const T = y.createdAt as string;
    await wait();
    // moved the only way there is without a move (which keeps the id): deleted, made again elsewhere
    await call("alice", "DELETE", `${path}/${x.id}`);
    await make(path, { key: "X", value: "x2", folder: "/new" });
    await call("alice", "DELETE", `${path}/${y.id}`);
    await rmdir(f, doomed.id);

    expect(await planAt(path, T)).toEqual([
      { change: "create", key: "Y", folder: "/doomed", kind: "plain" },
      { change: "remove", key: "X", folder: "/new", kind: "plain" },
      { change: "create", key: "X", folder: "/old", kind: "plain" },
    ]);
    const done = await call("alice", "POST", `${path}/restore`, { at: T, prune: true });
    expect(done.status).toBe(200);
    expect(done.json.changes).toEqual([
      { change: "create", key: "Y", folder: "/doomed", kind: "plain", applied: false },
      { change: "remove", key: "X", folder: "/new", kind: "plain", applied: true },
      { change: "create", key: "X", folder: "/old", kind: "plain", applied: true },
    ]);
    expect((await heldIn(path, "/old")).X.value).toBe("x1");
    expect(Object.keys(await heldIn(path, "/new"))).toEqual([]);
    expect(Object.keys(await list(path))).toEqual([]);
  });

  test("a snapshot says where a variable is now, and one moved since keeps its place: versions do not record a folder", async () => {
    const f = await fresh();
    const path = f.project;
    await mkdir(f, "a");
    const b = await mkdir(f, "b");
    const v = await make(path, { key: "M", value: "m1", folder: "/a" });
    await wait();
    const T = v.createdAt as string;
    await wait();
    // a move is not built yet (FLD-8): do what it will do, keep the id and change the folder
    await t.db.update(variables).set({ folderId: b.id }).where(eq(variables.id, v.id));
    const snap = await call("alice", "GET", `${path}/snapshot?at=${T}`);
    expect(snap.json.variables).toMatchObject([{ id: v.id, key: "M", folder: "/b", value: "m1" }]);
    expect(await planAt(path, T)).toEqual([]);
  });

  test("a bulk edit acts in the folder each step names, and the same key in two folders is two addresses", async () => {
    const f = await fresh();
    const path = f.project;
    await mkdir(f, "pay");
    await mkdir(f, "search");
    const root = await make(path, { key: "B_K", value: "root" });
    const pay = await make(path, { key: "B_K", value: "pay", folder: "/pay" });
    const search = await make(path, { key: "B_K", value: "search", folder: "/search" });
    const j = await make(path, { key: "B_J", value: "j", folder: "/pay" });
    const secret = sekrit("bulk-folder");
    const ops = [
      { op: "set", key: "B_K", value: "pay2", folder: "/pay" },
      { op: "set", key: "B_K", value: "root2" },
      { op: "set", key: "B_NEW", kind: "plain", value: "n", folder: "/search" },
      { op: "set", key: "B_SECRET", kind: "secret", value: secret, folder: "/search" },
      { op: "rename", key: "B_J", to: "B_J2", folder: "/pay" },
      { op: "delete", key: "B_K", folder: "/search" },
    ];
    const preview = await bulk(path, ops);
    expect(preview.status).toBe(200);
    expect(preview.json.changes).toEqual([
      { change: "update", key: "B_K", kind: "plain", applied: false },
      { change: "rename", key: "B_J", folder: "/pay", to: "B_J2", kind: "plain", applied: false },
      { change: "update", key: "B_K", folder: "/pay", kind: "plain", applied: false },
      { change: "delete", key: "B_K", folder: "/search", kind: "plain", applied: false },
      { change: "create", key: "B_NEW", folder: "/search", kind: "plain", applied: false },
      { change: "create", key: "B_SECRET", folder: "/search", kind: "secret", applied: false },
    ]);
    expect(preview.text).not.toContain(secret);
    expect((await list(path)).B_K.value).toBe("root"); // a preview changes nothing

    const done = await bulk(path, ops, false);
    expect(done.json.changes.map((c: { applied: boolean }) => c.applied)).toEqual(
      Array(6).fill(true),
    );
    expect((await list(path)).B_K).toMatchObject({ id: root.id, value: "root2", version: 2 });
    const inPay = await heldIn(path, "/pay");
    expect(Object.keys(inPay).sort()).toEqual(["B_J2", "B_K"]);
    expect(inPay.B_J2.id).toBe(j.id); // a rename keeps the variable
    expect(inPay.B_K).toMatchObject({ id: pay.id, value: "pay2", version: 2 });
    const inSearch = await heldIn(path, "/search");
    expect(Object.keys(inSearch)).toEqual(["B_NEW", "B_SECRET"]);
    expect((await call("alice", "GET", `${path}/${search.id}`)).status).toBe(404);
    expect(await revealed(path, inSearch.B_SECRET.id)).toBe(secret);

    // again: nothing left to do. A rename onto a key the folder holds is a conflict, one held only elsewhere is not.
    const again = await bulk(path, ops, false);
    expect(again.json.changes.map((c: { applied: boolean }) => c.applied)).toEqual(
      Array(6).fill(false),
    );
    const clash = await bulk(
      path,
      [{ op: "rename", key: "B_J2", to: "B_K", folder: "/pay" }],
      false,
    );
    expect(clash.json.changes).toEqual([
      { change: "conflict", key: "B_J2", folder: "/pay", to: "B_K", kind: "plain", applied: false },
    ]);
    const free = await bulk(
      path,
      [{ op: "rename", key: "B_NEW", to: "B_K", folder: "/search" }],
      false,
    );
    expect(free.json.changes[0]).toMatchObject({ change: "rename", applied: true });

    // a request that stays at the root says nothing of a folder, named or not
    expect((await bulk(path, [{ op: "set", key: "B_K", value: "root2" }], false)).status).toBe(200);
    const named = await bulk(path, [{ op: "set", key: "B_K", value: "root2", folder: "/" }], false);
    expect(named.json.changes).toEqual([
      { change: "unchanged", key: "B_K", kind: "plain", applied: false },
    ]);

    // the trail names each folder, and the summary the folders it opened
    const created = (await metaOf("variable.create")).filter((m) => m.source === "bulk");
    expect(created.filter((m) => m.key === "B_NEW").map((m) => m.folder)).toEqual(["/search"]);
    const updated = (await metaOf("variable.update")).filter(
      (m) => m.source === "bulk" && m.key === "B_K",
    );
    expect(updated.map((m) => m.folder)).toEqual(expect.arrayContaining(["/pay", undefined]));
    const summaries = (await events("variable.bulk")).map(
      (e) => (e.metadata as { folders?: string[] }).folders,
    );
    expect(summaries).toContainEqual(["/pay", "/search"]);
    expect(summaries).toContainEqual(undefined);
    expect(summaries).not.toContainEqual(["/"]);
  });

  test("an import or a bulk edit in a folder opens only that folder's values", async () => {
    const f = await fresh();
    const path = f.project;
    await mkdir(f, "pay");
    // A secret at the root that cannot be opened (versions are append-only, so it is made so): whatever opens it fails.
    const [, , organizationId, , projectId] = path.split("/") as string[];
    const id = Bun.randomUUIDv7();
    await t.db.insert(variables).values({
      id,
      organizationId: organizationId as string,
      projectId: projectId as string,
      key: "O_ROOT",
      kind: "secret",
    });
    await t.db.insert(variableVersions).values({
      variableId: id,
      version: 1,
      valueEnc: Buffer.alloc(64, 7),
      actorKind: "user",
      actorId: "test",
    });
    const body = { source: "dotenv", kind: "plain", content: "O_NEW=1", folder: "/pay" };
    expect((await imp(path, { ...body, dryRun: false })).status).toBe(200);
    const ops = [{ op: "set", folder: "/pay", key: "O_NEW", kind: "plain", value: "2" }];
    expect((await bulk(path, ops, false)).json.changes).toMatchObject([{ change: "update" }]);
    expect((await heldIn(path, "/pay")).O_NEW.value).toBe("2");
    // at the root the same would open it
    const there = await imp(path, { source: "dotenv", content: "O_NEW=1", dryRun: false });
    expect([there.status, there.json.code]).toEqual([500, "secret_unreadable"]);
  });

  test("a step that names a folder that is not there, or not a path, is refused whole, never put at the root", async () => {
    const f = await fresh();
    const path = f.project;
    await mkdir(f, "pay");
    const gone = await mkdir(f, "gone");
    await rmdir(f, gone.id);
    const before = await counts();
    for (const folder of ["/nope", "/gone", "/pay/deeper"]) {
      for (const dryRun of [true, false]) {
        for (const where of [path, f.environment, f.organization]) {
          const ops = [
            { op: "set", key: "B_OK", value: "v" },
            { op: "set", key: "B_X", value: "v", folder },
          ];
          const res = await bulk(where, ops, dryRun);
          expect([folder, dryRun, where, res.status]).toEqual([folder, dryRun, where, 404]);
        }
      }
      const del = await bulk(path, [{ op: "delete", key: "B_X", folder }]);
      expect([folder, del.status]).toEqual([folder, 404]);
    }
    for (const folder of ["pay", "/Pay", "/pay/", ""]) {
      const res = await bulk(path, [{ op: "set", key: "B_X", value: "v", folder }]);
      expect([folder, res.status]).toEqual([folder, 422]);
    }
    // an address named twice is one too many, however the root is spelled
    for (const second of [{}, { folder: "/" }]) {
      const res = await bulk(path, [
        { op: "set", key: "B_D", value: "1" },
        { op: "set", key: "B_D", value: "2", ...second },
      ]);
      expect([JSON.stringify(second), res.status]).toEqual([JSON.stringify(second), 422]);
    }
    expect(await counts()).toEqual(before);
    expect(Object.keys(await list(path))).toEqual([]);
    // the organization's variables are at the root, which it may name
    const org = await bulk(f.organization, [{ op: "set", key: "B_O", value: "1", folder: "/" }]);
    expect(org.status).toBe(200);
  });
});

describe("moving a variable", () => {
  const move = (path: string, id: string, body: object, who: Who = "alice") =>
    call(who, "PATCH", `${path}/${id}`, body);
  const orgOf = (f: Fx) => f.project.split("/")[2] as string;
  const resolvedOf = (f: Fx) => f.environment.replace(/variables$/, "resolved-variables");

  test("a move changes the address and makes no version: the same variable, value and history, and a secret still opens", async () => {
    const f = await fresh();
    const path = f.project;
    await mkdir(f, "pay");
    const secret = sekrit("move");
    const v = await make(path, { key: "M_SECRET", kind: "secret", value: secret });
    const stay = await make(path, { key: "M_STAY", value: "p" });
    const feed = `${path.replace(/variables$/, "variable-changes")}?limit=100`;
    const rowsOf = async () =>
      (await call("alice", "GET", feed)).json.items.filter(
        (c: { key: string }) => c.key === "M_SECRET",
      ).length;
    const before = await counts();

    const res = await move(path, v.id, { folder: "/pay" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id: v.id, key: "M_SECRET", folder: "/pay", version: 1 });
    expect(res.json.value).toBeNull();
    expect(Object.keys(await heldIn(path, "/"))).toEqual(["M_STAY"]);
    expect(Object.keys(await heldIn(path, "/pay"))).toEqual(["M_SECRET"]);
    expect(await revealed(path, v.id)).toBe(secret);
    expect(((await heldIn(path, "/")).M_STAY as { id: string }).id).toBe(stay.id);
    const versions = await call("alice", "GET", `${path}/${v.id}/versions`);
    expect(versions.json.items).toHaveLength(1);
    expect(await rowsOf()).toBe(1); // the changes feed is of versions: a move writes none
    const after = await counts();
    expect([after.variables, after.versions]).toEqual([before.variables, before.versions]);
    expect(Number(after.audits) - Number(before.audits)).toBe(2); // the move, and the reveal above

    // the trail names where it went, and says only the folder changed
    const moves = (await metaOf("variable.update")).filter((m) => m.key === "M_SECRET");
    expect(moves).toEqual([expect.objectContaining({ fields: ["folder"], folder: "/pay" })]);
    expect(moves[0]?.previousFolder).toBeUndefined(); // it came from the root

    // back to the root, then to where it already is: no new version either way
    expect((await move(path, v.id, { folder: "/" })).json).toMatchObject({
      folder: "/",
      version: 1,
    });
    expect((await move(path, v.id, { folder: "/" })).status).toBe(200);
    expect((await move(path, v.id, { folder: "/pay" })).status).toBe(200);
    expect((await move(path, v.id, { folder: "/pay" })).status).toBe(200); // already there
    const trail = (await metaOf("variable.update")).filter((m) => m.key === "M_SECRET");
    // an audit read has no order, so the rows are compared as a set
    const rows = (list: unknown[][]) => list.map((r) => JSON.stringify(r)).sort();
    expect(rows(trail.map((m) => [m.fields, m.folder, m.previousFolder ?? null]))).toEqual(
      rows([
        [["folder"], "/pay", null],
        [["folder"], undefined, "/pay"],
        [[], undefined, null],
        [["folder"], "/pay", null],
        [[], "/pay", null],
      ]),
    );
    expect((await call("alice", "GET", `${path}/${v.id}/versions`)).json.items).toHaveLength(1);
  });

  test("a move onto a key the folder holds at that level is a 409 and changes nothing; the same key at another level is no clash", async () => {
    const f = await fresh();
    const path = f.project;
    await mkdir(f, "pay");
    const root = await make(path, { key: "M_X", value: "root" });
    const pay = await make(path, { key: "M_X", value: "pay", folder: "/pay" });
    const clash = await move(path, root.id, { folder: "/pay" });
    expect([clash.status, clash.json.code]).toEqual([409, "key_taken"]);
    expect(((await heldIn(path, "/")).M_X as { id: string }).id).toBe(root.id);
    expect(((await heldIn(path, "/pay")).M_X as { id: string }).id).toBe(pay.id);
    expect((await metaOf("variable.update")).filter((m) => m.key === "M_X")).toEqual([]); // no row for a move not made

    // the environment's own M_Y in /pay is another level's: the project's M_Y may join it
    const y = await make(path, { key: "M_Y", value: "p" });
    await make(f.environment, { key: "M_Y", value: "e", folder: "/pay" });
    expect((await move(path, y.id, { folder: "/pay" })).status).toBe(200);
  });

  test("the readers a move would stop resolving are named: refused without force, done with it, and the trail says so", async () => {
    const f = await fresh();
    const path = f.project;
    await mkdir(f, "db");
    await mkdir(f, "pay");
    const secret = sekrit("move-reads");
    await make(path, { key: "M_DOMAIN", value: "example.org" });
    const host = await make(path, {
      key: "M_HOST",
      kind: "secret",
      value: `${secret}.\${M_DOMAIN}`,
    });
    await make(path, { key: "M_URL", value: "https://${M_HOST}:5432" }); // beside it
    await make(path, { key: "M_ABS", value: "${/M_HOST}", folder: "/pay" }); // by its address
    await make(f.environment, { key: "M_ENV", value: "${M_HOST}" }); // an environment's, which sees it
    await make(path, { key: "M_FINE", value: "no references" });
    const before = await counts();

    const refused = await move(path, host.id, { folder: "/db" });
    expect([refused.status, refused.json.code]).toEqual([409, "move_breaks_readers"]);
    expect(refused.json.breaks).toEqual(["/M_ENV", "/M_URL", "/db/M_HOST", "/pay/M_ABS"]);
    expect(refused.text).not.toContain(secret);
    expect(Object.keys(await heldIn(path, "/")).sort()).toEqual([
      "M_DOMAIN",
      "M_FINE",
      "M_HOST",
      "M_URL",
    ]);
    expect(await counts()).toEqual(before); // nothing moved, no row

    const forced = await move(path, host.id, { folder: "/db", force: true });
    expect([forced.status, forced.json.folder]).toEqual([200, "/db"]);
    const forcedRows = (await metaOf("variable.update")).filter((m) => m.key === "M_HOST");
    expect(forcedRows).toEqual([
      expect.objectContaining({ fields: ["folder"], folder: "/db", forced: true, breakCount: 4 }),
    ]);
    const issues = (await call("alice", "GET", resolvedOf(f))).json.issues as { key: string }[];
    expect(issues.map((i) => i.key)).toEqual(expect.arrayContaining(["M_URL", "M_ENV"]));

    // back home, which heals them: nothing it breaks, so no force
    expect((await move(path, host.id, { folder: "/" })).status).toBe(200);
    const healed = (await call("alice", "GET", resolvedOf(f))).json.issues as { key: string }[];
    expect(healed.filter((i) => i.key.startsWith("M_"))).toEqual([]);
  });

  test("an environment's variable is judged by its own environment's readers", async () => {
    const f = await fresh();
    await mkdir(f, "pay");
    const a = await make(f.environment, { key: "M_EA", value: "x", folder: "/pay" });
    await make(f.environment, { key: "M_EB", value: "${M_EA}", folder: "/pay" });
    const refused = await move(f.environment, a.id, { folder: "/" });
    expect([refused.status, refused.json.code, refused.json.breaks]).toEqual([
      409,
      "move_breaks_readers",
      ["/pay/M_EB"],
    ]);
    expect(Object.keys(await heldIn(f.environment, "/pay")).sort()).toEqual(["M_EA", "M_EB"]);
  });

  test("a folder that is not there, a path that is not one, and a body that mixes a move with an edit are refused, and nothing changes", async () => {
    const f = await fresh();
    const path = f.project;
    const gone = await mkdir(f, "gone");
    await rmdir(f, gone.id);
    const v = await make(path, { key: "M_V", value: "v" });
    const before = await counts();
    const refused = async (body: object, status: number) =>
      expect([JSON.stringify(body), (await move(path, v.id, body)).status]).toEqual([
        JSON.stringify(body),
        status,
      ]);
    await refused({ folder: "/nope" }, 404);
    await refused({ folder: "/gone" }, 404); // deleted
    await refused({ folder: "pay" }, 422);
    await refused({ folder: "/pay/" }, 422);
    await refused({ folder: "/", value: "x" }, 422);
    await refused({ folder: "/", description: "d" }, 422);
    await refused({ folder: "/", tags: ["a"] }, 422);
    await refused({ folder: "/", reason: "why" }, 422);
    await refused({ value: "x", force: true }, 422);
    await refused({ force: true }, 422);
    expect((await move(path, "00000000-0000-4000-8000-000000000000", { folder: "/" })).status).toBe(
      404,
    );
    expect(await counts()).toEqual(before);
    expect(((await heldIn(path, "/")).M_V as { id: string }).id).toBe(v.id);

    // an organization's variables are at the root: there is nowhere else to go
    const org = await make(f.organization, { key: "M_ORG", value: "o" });
    expect((await move(f.organization, org.id, { folder: "/pay" })).status).toBe(404);
    expect((await move(f.organization, org.id, { folder: "/" })).json.folder).toBe("/");
  });

  test("rotation follows the id, and an environment's variable moves in the project's folders", async () => {
    const f = await fresh();
    await mkdir(f, "pay");
    const v = await make(f.environment, {
      key: "M_ROT",
      kind: "secret",
      value: sekrit("move-rot"),
    });
    const set = await setRotation(t.db, {
      organizationId: orgOf(f),
      variableId: v.id,
      provider: "fake",
      config: { name: "a" },
      intervalDays: 30,
      graceDays: 0,
    });
    if ("error" in set) throw new Error(set.error);
    const moved = await move(f.environment, v.id, { folder: "/pay" });
    expect([moved.status, moved.json.folder, moved.json.level]).toEqual([
      200,
      "/pay",
      "environment",
    ]);
    expect(Object.keys(await heldIn(f.environment, "/pay"))).toEqual(["M_ROT"]);
    expect((await getRotation(t.db, orgOf(f), v.id))?.id).toBe(set.row.id);
    // the project's list is the project's: the environment's variable is not in it
    expect(Object.keys(await heldIn(f.project, "/pay"))).toEqual([]);

    // a protected environment takes its changes as change requests, a move included
    const env = `${f.environment.replace(/\/variables$/, "")}/protection`;
    expect((await call("alice", "PUT", env, { protected: true })).status).toBe(200);
    const held = await move(f.environment, v.id, { folder: "/" });
    expect([held.status, held.json.code]).toEqual([409, "change_request_required"]);
    expect(Object.keys(await heldIn(f.environment, "/pay"))).toEqual(["M_ROT"]);
  });

  test("who may move: a maintainer, not a reporter; a stranger sees nothing", async () => {
    const v = await make(base.project(), { key: "M_WHO", value: "w" });
    expect((await move(base.project(), v.id, { folder: "/" }, "carol")).status).toBe(403);
    expect((await move(base.project(), v.id, { folder: "/" }, "erin")).status).toBe(404);
    expect((await move(base.project(), v.id, { folder: "/" }, "bob")).status).toBe(200);
    const anonymous = await call(undefined, "PATCH", `${base.project()}/${v.id}`, { folder: "/" });
    expect(anonymous.status).toBe(401);
    expect(await metaOf("variable.update")).toContainEqual(
      expect.objectContaining({ key: "M_WHO", fields: [] }),
    );
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
