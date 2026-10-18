import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  auditEvents,
  createOrganization,
  createSession,
  listPolicySets,
  MAX_POLICY_SETS,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

let t: TestDb;
let o1: string;
let o2: string;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"owner" | "admin" | "member" | "viewer" | "outsider" | "boss", string>;

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
  });

beforeAll(async () => {
  t = await createTestDb();
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  let gitlabId = 700;
  for (const [name, org, role] of [
    ["owner", o1, "owner"],
    ["admin", o1, "admin"],
    ["member", o1, "member"],
    ["viewer", o1, "viewer"],
    ["outsider", o2, "admin"],
  ] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = `orch_session=${session}`;
    roleTable.set(gitlabId, { orgRoles: { [org]: role }, projectRoles: {} });
  }
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

async function call(
  who: keyof typeof people | undefined,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who];
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const sets = (org = o1) => `/organizations/${org}/policy-sets`;
let n = 0;
const body = (over: object = {}) => ({
  name: `set${++n}`,
  source: "platform/policies",
  ref: "v1",
  path: "terraform",
  tag: "prod",
  ...over,
});
const make = async (over: object = {}) => {
  const res = await call("admin", "POST", sets(), body(over));
  expect(res.status).toBe(201);
  return res.json as { id: string; name: string };
};
const auditsOf = async (action: string) =>
  await t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, o1)));

describe("making a policy set", () => {
  test("an org admin makes one; the answer, the list and the audit event hold what was said", async () => {
    const res = await call(
      "admin",
      "POST",
      sets(),
      body({ name: "  prod-rules  ", path: undefined }),
    );
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: o1,
      name: "prod-rules",
      source: "platform/policies",
      ref: "v1",
      path: ".",
      tag: "prod",
    });
    const list = await call("viewer", "GET", sets());
    expect(list.status).toBe(200);
    expect(list.json.items.map((s: { id: string }) => s.id)).toContain(res.json.id);
    const events = (await auditsOf("policy.set.create")).filter(
      (e) => e.resourceId === res.json.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorKind: "user",
      resourceType: "policy_set",
      metadata: {
        name: "prod-rules",
        source: "platform/policies",
        ref: "v1",
        path: ".",
        tag: "prod",
      },
    });
  });

  test("the name is taken once per organization, and another organization may reuse it", async () => {
    await make({ name: "shared" });
    const again = await call("admin", "POST", sets(), body({ name: "shared" }));
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: "name_taken" });
    expect((await call("outsider", "POST", sets(o2), body({ name: "shared" }))).status).toBe(201);
  });

  test("refuses a set the generated job could not use, naming what is wrong and not echoing it", async () => {
    const hostile: [string, object][] = [
      ["a source with a shell", { source: "a/b; rm -rf /" }],
      ["a source with a query", { source: "a/b?x=1" }],
      ["a source that is one word", { source: "policies" }],
      ["a source with a dot-dot", { source: "a/../b" }],
      ["a ref with a space", { ref: "v1 --output /etc/x" }],
      ["a ref that climbs", { ref: "a/../b" }],
      ["a ref with a dollar", { ref: "$(id)" }],
      ["a path that climbs", { path: "../x" }],
      ["an absolute path", { path: "/etc" }],
      ["a path with a quote", { path: 'a"b' }],
      ["a tag with capitals", { tag: "Prod" }],
      ["a tag with a space", { tag: "a b" }],
      ["a name with a quote", { name: 'x"y' }],
      ["an empty name", { name: "" }],
      ["an extra field", { image: "evil" }],
      ["no tag", { tag: undefined }],
    ];
    for (const [what, over] of hostile) {
      const res = await call("admin", "POST", sets(), body(over));
      expect([what, res.status]).toEqual([what, 422]);
      expect(res.text).not.toContain("rm -rf");
      expect(res.text).not.toContain("$(id)");
    }
    expect(await call("admin", "POST", sets(), body({ ref: "a1b2c3d4e5f6" }))).toMatchObject({
      status: 201,
    });
  });

  test("an organization has at most so many, and the next is a 409", async () => {
    const org = (await createOrganization(t.db, { slug: "full", name: "Full" })).id;
    const user = await upsertUser(t.db, { gitlabId: 799, username: "boss", name: "Boss" });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    roleTable.set(799, { orgRoles: { [org]: "admin" }, projectRoles: {} });
    people.boss = `orch_session=${session}`;
    const post = (name: string) => call("boss", "POST", sets(org), body({ name }));
    // filled directly: fifty requests are not what this tests
    const { policySets } = await import("@orch/db");
    await t.db.insert(policySets).values(
      Array.from({ length: MAX_POLICY_SETS }, (_, i) => ({
        organizationId: org,
        name: `n${i}`,
        source: "a/b",
        ref: "v1",
        path: ".",
        tag: "prod",
      })),
    );
    const res = await post("one-more");
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "too_many_policy_sets" });
    expect(await listPolicySets(t.db, org, { limit: 1000 })).toHaveLength(MAX_POLICY_SETS);
    // deleting one makes room
    const first = (await listPolicySets(t.db, org, { limit: 1 }))[0];
    expect((await call("boss", "DELETE", `${sets(org)}/${first?.id}`)).status).toBe(204);
    expect((await post("now-there-is-room")).status).toBe(201);
  });
});

describe("who may do what with policy sets", () => {
  test("anyone in the organization reads; only an org admin or owner makes or removes", async () => {
    const one = await make();
    for (const who of ["owner", "admin", "member", "viewer"] as const) {
      expect([who, (await call(who, "GET", sets())).status]).toEqual([who, 200]);
    }
    for (const who of ["member", "viewer"] as const) {
      const made = await call(who, "POST", sets(), body());
      expect([who, made.status]).toEqual([who, 403]);
      const del = await call(who, "DELETE", `${sets()}/${one.id}`);
      expect([who, del.status]).toEqual([who, 403]);
    }
    expect((await call("owner", "POST", sets(), body())).status).toBe(201);
    expect((await call("owner", "DELETE", `${sets()}/${one.id}`)).status).toBe(204);
  });

  test("a caller with no credentials is 401, and another organization's admin finds nothing: 404", async () => {
    expect((await call(undefined, "GET", sets())).status).toBe(401);
    expect((await call(undefined, "POST", sets(), body())).status).toBe(401);
    for (const [method, path, b] of [
      ["GET", sets(), undefined],
      ["POST", sets(), body()],
    ] as const) {
      const res = await call("outsider", method, path, b);
      expect([method, res.status]).toEqual([method, 404]);
    }
  });

  test("a set of one organization cannot be removed through another", async () => {
    const mine = await make();
    const res = await call("outsider", "DELETE", `${sets(o2)}/${mine.id}`);
    expect(res.status).toBe(404);
    expect(
      ((await call("admin", "GET", sets())).json.items as { id: string }[]).map((s) => s.id),
    ).toContain(mine.id);
    // and it is not found by a stranger's path either
    expect((await call("outsider", "DELETE", `${sets()}/${mine.id}`)).status).toBe(404);
  });
});

describe("removing a policy set", () => {
  test("removes it, audits it, and a second removal is a 404", async () => {
    const one = await make({ name: "going" });
    expect((await call("admin", "DELETE", `${sets()}/${one.id}`)).status).toBe(204);
    expect((await call("admin", "DELETE", `${sets()}/${one.id}`)).status).toBe(404);
    const events = (await auditsOf("policy.set.delete")).filter((e) => e.resourceId === one.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ metadata: { name: "going" } });
    expect(
      ((await call("viewer", "GET", sets())).json.items as { id: string }[]).map((s) => s.id),
    ).not.toContain(one.id);
  });

  test("lists in pages", async () => {
    const org = o2;
    for (let i = 0; i < 3; i++)
      await call("outsider", "POST", sets(org), body({ name: `page${i}` }));
    const first = await call("outsider", "GET", `${sets(org)}?limit=2`);
    expect(first.json.items.length).toBe(2);
    expect(first.json.nextCursor).toBeTruthy();
    const rest = await call(
      "outsider",
      "GET",
      `${sets(org)}?limit=2&cursor=${first.json.nextCursor}`,
    );
    expect(rest.status).toBe(200);
    expect(rest.json.items.length).toBeGreaterThanOrEqual(1);
    const seen = [...first.json.items, ...rest.json.items].map((s: { id: string }) => s.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
