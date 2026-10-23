import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createApiToken,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  createVariable,
  deleteVariable,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, newApiToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol" | "erin", { id: string; cookie: string }>;
const ids = {} as Record<"o1" | "o2" | "o3" | "p1" | "p2" | "p3", string>;
const tokens = {} as Record<"read" | "write" | "none", string>;
let app: ReturnType<typeof makeApp>;

const makeApp = () =>
  createApp({
    logger: createLogger({ level: "error", write: () => {} }),
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
  const org = async (slug: string) => (await createOrganization(t.db, { slug, name: slug })).id;
  ids.o1 = await org("one");
  ids.o2 = await org("two");
  ids.o3 = await org("three");
  const project = async (organizationId: string, name: string) =>
    (await createProject(t.db, { organizationId, name })).id;
  ids.p1 = await project(ids.o1, "p1");
  ids.p2 = await project(ids.o1, "p2");
  ids.p3 = await project(ids.o3, "p3");
  await createEnvironment(t.db, {
    organizationId: ids.o1,
    projectId: ids.p1,
    name: "dev",
    slug: "dev",
  });
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
  for (const [name, scopes] of [
    ["read", ["project.read", "variable.read"]],
    ["write", ["project.read", "variable.read", "variable.create"]],
    ["none", ["project.read"]],
  ] as const) {
    const fresh = newApiToken();
    await createApiToken(t.db, {
      userId: people.alice.id,
      name,
      prefix: fresh.prefix,
      tokenHash: fresh.tokenHash,
      scopes,
      ttlMs: 60_000,
    });
    tokens[name] = fresh.token;
  }
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

type Who = keyof typeof people | `token:${keyof typeof tokens}`;
async function call(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who.startsWith("token:"))
    headers.authorization = `Bearer ${tokens[who.slice(6) as keyof typeof tokens]}`;
  else headers.cookie = people[who as keyof typeof people].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const at = (p = ids.p1, org = ids.o1) => `/organizations/${org}/projects/${p}/folders`;
const make = async (name: string, parent?: string, who: Who = "bob") => {
  const res = await call(who, "POST", at(), parent === undefined ? { name } : { parent, name });
  expect(res.status).toBe(201);
  return res.json as { id: string; path: string };
};
const paths = async () =>
  ((await call("bob", "GET", at())).json.items as { path: string }[]).map((f) => f.path);
const events = (action: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, action));

describe("the folders of a project", () => {
  test("a maintainer makes, lists, renames and deletes them, and every change is on record", async () => {
    const db = await make("db");
    const primary = await make("primary", "/db");
    expect(primary.path).toBe("/db/primary");
    const listed = await call("bob", "GET", at());
    expect(listed.status).toBe(200);
    expect(listed.json.nextCursor).toBeNull();
    expect(Object.keys(listed.json.items[0]).sort()).toEqual([
      "createdAt",
      "id",
      "organizationId",
      "path",
      "projectId",
      "updatedAt",
      "variableCount",
    ]);
    expect(await paths()).toEqual(["/db", "/db/primary"]);

    const renamed = await call("bob", "PATCH", `${at()}/${db.id}`, { name: "data" });
    expect([renamed.status, renamed.json.path]).toEqual([200, "/data"]);
    expect(await paths()).toEqual(["/data", "/data/primary"]);

    expect((await call("bob", "DELETE", `${at()}/${primary.id}`)).status).toBe(204);
    expect((await call("alice", "DELETE", `${at()}/${db.id}`)).status).toBe(204);
    expect(await paths()).toEqual([]);

    const row = (e: { metadata: unknown; resourceId: string | null; projectId: string | null }) => [
      e.resourceId,
      e.projectId,
      e.metadata,
    ];
    expect((await events("variable_folder.create")).map(row)).toEqual([
      [db.id, ids.p1, { path: "/db" }],
      [primary.id, ids.p1, { path: "/db/primary" }],
    ]);
    expect((await events("variable_folder.rename")).map(row)).toEqual([
      [db.id, ids.p1, { path: "/data", previousPath: "/db" }],
    ]);
    expect((await events("variable_folder.delete")).map(row)).toEqual([
      [primary.id, ids.p1, { path: "/data/primary" }], // the rename took its parent along
      [db.id, ids.p1, { path: "/data" }],
    ]);
  });

  test("the list says how many variables each folder holds, a reporter included; a make and a rename do not", async () => {
    const f = await make("counted");
    await make("below", "/counted");
    const put = (key: string, folder: string) =>
      createVariable(t.db, keys, {
        organizationId: ids.o1,
        projectId: ids.p1,
        key,
        kind: "plain",
        value: "v",
        folder,
        actor: { kind: "user", id: people.bob.id },
      });
    const held = [] as { id: string }[];
    const counts = async (who: Who) =>
      Object.fromEntries(
        ((await call(who, "GET", at())).json.items as { path: string; variableCount: number }[])
          .filter((i) => i.path.startsWith("/counted"))
          .map((i) => [i.path, i.variableCount]),
      );
    expect(await counts("bob")).toEqual({ "/counted": 0, "/counted/below": 0 });
    held.push(
      await put("ONE", "/counted"),
      await put("TWO", "/counted"),
      await put("DEEP", "/counted/below"),
    );
    expect(await counts("carol")).toEqual({ "/counted": 2, "/counted/below": 1 });
    const renamed = await call("bob", "PATCH", `${at()}/${f.id}`, { name: "counted" });
    expect(Object.keys(renamed.json)).not.toContain("variableCount");
    const made = await make("again", "/counted");
    expect(Object.keys(made)).not.toContain("variableCount");
    for (const v of held)
      await deleteVariable(t.db, { organizationId: ids.o1, projectId: ids.p1 }, v.id);
    const items = (await call("bob", "GET", at())).json.items as { id: string }[];
    for (const item of items.reverse()) await call("bob", "DELETE", `${at()}/${item.id}`);
  });

  test("a deleted folder is gone for rename and delete, and its path is free again", async () => {
    const gone = await make("gone");
    expect((await call("bob", "DELETE", `${at()}/${gone.id}`)).status).toBe(204);
    for (const [method, body] of [
      ["PATCH", { name: "x" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await call("bob", method, `${at()}/${gone.id}`, body);
      expect([method, res.status, res.json.code]).toEqual([method, 404, "not_found"]);
    }
    expect((await make("gone")).id).not.toBe(gone.id);
    expect(await paths()).toEqual(["/gone"]);
    await call("bob", "DELETE", `${at()}/${(await call("bob", "GET", at())).json.items[0].id}`);
  });

  test("a reporter reads, and cannot write", async () => {
    const f = await make("reporter");
    expect((await call("carol", "GET", at())).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", at(), { name: "x" }],
      ["PATCH", `${at()}/${f.id}`, { name: "x" }],
      ["DELETE", `${at()}/${f.id}`, undefined],
    ] as const) {
      const res = await call("carol", method, path, body);
      expect([method, res.status, res.json.code]).toEqual([method, 403, "forbidden"]);
    }
    expect(await paths()).toEqual(["/reporter"]);
    await call("bob", "DELETE", `${at()}/${f.id}`);
  });

  test("a stranger, another project, and a project of another organization are 404", async () => {
    const f = await make("mine");
    // a folder of the other organization's project, addressed through this organization's path
    const foreign = (await call("alice", "POST", at(ids.p3, ids.o3), { name: "theirs" })).json;
    for (const [who, base, id] of [
      ["erin", at(), f.id], // an admin of an organization that is not this one
      ["alice", at(ids.p3), foreign.id], // the project is another organization's
    ] as const) {
      for (const [method, path, body] of [
        ["GET", base, undefined],
        ["POST", base, { name: "x" }],
        ["PATCH", `${base}/${id}`, { name: "x" }],
        ["DELETE", `${base}/${id}`, undefined],
      ] as const) {
        const res = await call(who, method, path, body);
        expect([who, base, method, res.status]).toEqual([who, base, method, 404]);
      }
    }
    expect((await call("alice", "GET", at(ids.p3, ids.o3))).json.items).toMatchObject([
      { path: "/theirs" },
    ]);
    // a folder of this project, addressed through another project of the same organization
    for (const [method, body] of [
      ["PATCH", { name: "x" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await call("alice", method, `${at(ids.p2)}/${f.id}`, body);
      expect([method, res.status, res.json.code]).toEqual([method, 404, "not_found"]);
    }
    expect(await paths()).toEqual(["/mine"]);
    // and the other project holds none of it
    expect((await call("alice", "GET", at(ids.p2))).json.items).toEqual([]);
    await call("bob", "DELETE", `${at()}/${f.id}`);
  });

  test("a clash is a 409, for a make and for a rename; a delete of a folder with anything in it is a 409", async () => {
    const deletes = (await events("variable_folder.delete")).length;
    const a = await make("a");
    await make("b");
    await make("sub", "/a");
    const twice = await call("bob", "POST", at(), { name: "a" });
    expect([twice.status, twice.json.code]).toEqual([409, "folder_taken"]);
    const onto = await call("bob", "PATCH", `${at()}/${a.id}`, { name: "b" });
    expect([onto.status, onto.json.code]).toEqual([409, "folder_taken"]);
    // the same name in another parent is no clash
    expect((await make("a", "/b")).path).toBe("/b/a");

    const full = await call("bob", "DELETE", `${at()}/${a.id}`);
    expect([full.status, full.json.code]).toEqual([409, "folder_not_empty"]);
    await createVariable(t.db, keys, {
      organizationId: ids.o1,
      projectId: ids.p1,
      key: "HELD",
      kind: "plain",
      value: "v",
      folder: "/b/a",
      actor: { kind: "user", id: people.bob.id },
    });
    const held = (await call("bob", "GET", at())).json.items.find(
      (f: { path: string }) => f.path === "/b/a",
    );
    const withVariable = await call("bob", "DELETE", `${at()}/${held.id}`);
    expect([withVariable.status, withVariable.json.code]).toEqual([409, "folder_not_empty"]);
    expect(await paths()).toEqual(["/a", "/a/sub", "/b", "/b/a"]);
    expect(await events("variable_folder.delete")).toHaveLength(deletes); // a refused delete is not on record
  });

  test("a name that is not a folder name, a parent that is not a path, and an extra field are 422; a missing parent is 404; a sixth level is refused", async () => {
    const bad = await call("bob", "POST", at(), { name: "Db" });
    expect(bad.json.errors.map((e: { path: string }) => e.path)).toEqual(["name"]); // the schema, not only the database
    for (const body of [
      { name: "" },
      { name: "Db" },
      { name: "a/b" },
      { name: "a b" },
      { name: "x".repeat(33) },
      { name: ".." },
      { parent: "db", name: "x" },
      { parent: "/", name: "x", note: "no" },
      { parent: "/a//b", name: "x" },
      {},
    ]) {
      const res = await call("bob", "POST", at(), body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    const [a] = (await call("bob", "GET", at())).json.items;
    for (const body of [{}, { name: "A" }, { name: "a/b" }, { name: "x", parent: "/" }]) {
      const res = await call("bob", "PATCH", `${at()}/${a.id}`, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    const missing = await call("bob", "POST", at(), { parent: "/nope", name: "x" });
    expect([missing.status, missing.json.code]).toEqual([404, "not_found"]);

    let parent = "/deep";
    await make("deep");
    for (const name of ["two", "three", "four", "five"]) {
      parent = (await make(name, parent)).path;
    }
    expect(parent).toBe("/deep/two/three/four/five");
    const six = await call("bob", "POST", at(), { parent, name: "six" });
    expect([six.status, six.json.code]).toEqual([422, "folder_too_deep"]);
  });

  test("a token needs the variable scopes, as a person needs the role", async () => {
    expect((await call("token:read", "GET", at())).status).toBe(200);
    expect((await call("token:read", "POST", at(), { name: "tok" })).status).toBe(403);
    expect((await call("token:none", "GET", at())).status).toBe(403);
    expect((await call("token:write", "POST", at(), { name: "tok" })).status).toBe(201);
    const [tok] = (await call("token:read", "GET", at())).json.items.filter(
      (f: { path: string }) => f.path === "/tok",
    );
    for (const [token, method, body] of [
      ["write", "PATCH", { name: "x" }], // may create, may not rename
      ["write", "DELETE", undefined],
      ["read", "DELETE", undefined],
    ] as const) {
      const res = await call(`token:${token}`, method, `${at()}/${tok.id}`, body);
      expect([token, method, res.status]).toEqual([token, method, 403]);
    }
  });

  test("no value is in any answer or audit row of a folder that holds a secret", async () => {
    const marker = `SEKRIT-${Bun.randomUUIDv7()}`;
    const f = await make("vault");
    await createVariable(t.db, keys, {
      organizationId: ids.o1,
      projectId: ids.p1,
      key: "VAULT_KEY",
      kind: "secret",
      value: marker,
      folder: "/vault",
      actor: { kind: "user", id: people.bob.id },
    });
    const answers = [
      await call("bob", "GET", at()),
      await call("bob", "PATCH", `${at()}/${f.id}`, { name: "safe" }),
      await call("bob", "DELETE", `${at()}/${f.id}`),
    ];
    expect(answers.map((a) => a.status)).toEqual([200, 200, 409]);
    const audits = JSON.stringify(await t.db.select().from(auditEvents));
    expect(audits).toContain("variable_folder.rename");
    for (const text of [...answers.map((a) => a.text), audits]) {
      expect(text).not.toContain(marker);
    }
  });
});
