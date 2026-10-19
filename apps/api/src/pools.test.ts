import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, MAX_POOLS, type Subject } from "@orch/core";
import {
  allPools,
  auditEvents,
  createOrganization,
  createSession,
  upsertUser,
  workerPools,
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
  let gitlabId = 900;
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

const pools = (org = o1) => `/organizations/${org}/pools`;
let n = 0;
const make = (over: object = {}, who: keyof typeof people = "admin", org = o1) =>
  call(who, "POST", pools(org), { name: `pool-${++n}`, tags: ["runners"], ...over });
const auditsOf = async (action: string, org = o1) =>
  await t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, org)));
const listed = async (who: keyof typeof people = "viewer", org = o1) =>
  (await call(who, "GET", pools(org))).json.items as {
    id: string;
    name: string;
    isDefault: boolean;
  }[];
/** A fresh organization with its own admin, for tests that need an empty one. */
async function lonely(slug: string, gitlabId: number) {
  const org = (await createOrganization(t.db, { slug, name: slug })).id;
  const user = await upsertUser(t.db, { gitlabId, username: slug, name: slug });
  const session = randomToken();
  await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
  roleTable.set(gitlabId, { orgRoles: { [org]: "admin" }, projectRoles: {} });
  people.boss = `orch_session=${session}`;
  return org;
}

describe("creating a pool", () => {
  test("an org admin makes one: enabled, not the default; the answer, the list and the audit event hold it", async () => {
    const res = await make({
      name: "prod-runners",
      tags: ["prod", "docker"],
      image: "registry.example.com/iac:1.2",
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: o1,
      name: "prod-runners",
      tags: ["prod", "docker"],
      image: "registry.example.com/iac:1.2",
      enabled: true,
      isDefault: false,
    });
    expect((await listed()).map((p) => p.id)).toContain(res.json.id);
    expect((await call("viewer", "GET", `${pools()}/${res.json.id}`)).json.name).toBe(
      "prod-runners",
    );
    const events = (await auditsOf("pool.create")).filter((e) => e.resourceId === res.json.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorKind: "user",
      resourceType: "worker_pool",
      metadata: {
        name: "prod-runners",
        tags: ["prod", "docker"],
        image: "registry.example.com/iac:1.2",
        enabled: true,
        isDefault: false,
      },
    });
  });

  test("a name is one per organization (409), and another organization may use it", async () => {
    await make({ name: "same" });
    const again = await make({ name: "same" });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: "pool_name_taken" });
    expect((await make({ name: "same" }, "outsider", o2)).status).toBe(201);
  });

  test("refuses what could do harm in a pipeline, with nothing stored and none of the value echoed", async () => {
    const before = (await listed()).length;
    const bad: [string, object][] = [
      ["no name", { name: undefined }],
      ["an upper-case name", { name: "Prod" }],
      ["a name with two dashes", { name: "a--b" }],
      ["a name of 64 characters", { name: "a".repeat(64) }],
      ["no tags", { tags: undefined }],
      ["an empty tag list", { tags: [] }],
      ["11 tags", { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
      ["a repeated tag", { tags: ["a", "a"] }],
      ["a tag with a space", { tags: ["evil tag"] }],
      ["a tag with a comma", { tags: ["a,b"] }],
      ["a variable as a tag", { tags: ["$SECRET"] }],
      ["a tag with a newline", { tags: ["a\nb"] }],
      ["an empty tag", { tags: [""] }],
      ["a numeric tag", { tags: [5] }],
      ["an image with credentials", { image: "user:hunter2@registry.example.com/img" }],
      ["an image with a space", { image: "evil image" }],
      ["a variable as an image", { image: "$IMAGE" }],
      ["an empty image", { image: "" }],
      ["a short digest", { image: "img@sha256:abc" }],
      // well formed, but not one a generated pipeline would use: refused here, not on every plan of the stacks
      ["an image the generator refuses", { image: "Registry/IaC:1" }],
      ["a string enabled", { enabled: "yes" }],
      ["an extra field", { extra: 1 }],
    ];
    for (const [what, over] of bad) {
      const res = await make(over);
      expect([what, res.status]).toEqual([what, 422]);
      expect(res.text).not.toContain("evil");
      expect(res.text).not.toContain("hunter2");
    }
    expect(await listed()).toHaveLength(before);
  });

  test("an organization has at most so many: the next is a 409 and leaves nothing behind", async () => {
    const org = await lonely("full", 990);
    await t.db.insert(workerPools).values(
      Array.from({ length: MAX_POOLS }, (_, i) => ({
        organizationId: org,
        name: `p${i}`,
        tags: ["x"],
      })),
    );
    const over = await make({ name: "one-more" }, "boss", org);
    expect(over.status).toBe(409);
    expect(over.json).toMatchObject({ code: "too_many_pools" });
    expect(await allPools(t.db, org)).toHaveLength(MAX_POOLS);
    expect(
      (await call("boss", "DELETE", `${pools(org)}/${(await allPools(t.db, org))[0]?.id}`)).status,
    ).toBe(204);
    expect((await make({ name: "room-now" }, "boss", org)).status).toBe(201);
  });
});

describe("who may do what with pools", () => {
  test("anyone in the organization reads; only an org admin or owner creates, changes or removes", async () => {
    const one = await make();
    for (const who of ["owner", "admin", "member", "viewer"] as const) {
      expect([who, (await call(who, "GET", pools())).status]).toEqual([who, 200]);
      expect([who, (await call(who, "GET", `${pools()}/${one.json.id}`)).status]).toEqual([
        who,
        200,
      ]);
    }
    for (const who of ["member", "viewer"] as const) {
      expect([who, (await make({}, who)).status]).toEqual([who, 403]);
      const patch = await call(who, "PATCH", `${pools()}/${one.json.id}`, { enabled: false });
      expect([who, patch.status]).toEqual([who, 403]);
      const del = await call(who, "DELETE", `${pools()}/${one.json.id}`);
      expect([who, del.status]).toEqual([who, 403]);
    }
    expect((await make({}, "owner")).status).toBe(201);
    expect(
      (await call("owner", "PATCH", `${pools()}/${one.json.id}`, { tags: ["z"] })).status,
    ).toBe(200);
    expect((await call("owner", "DELETE", `${pools()}/${one.json.id}`)).status).toBe(204);
  });

  test("a caller with no credentials is 401, and another organization's admin finds nothing: 404", async () => {
    const mine = await make();
    expect((await call(undefined, "GET", pools())).status).toBe(401);
    expect((await call(undefined, "POST", pools(), { name: "x", tags: ["x"] })).status).toBe(401);
    for (const [method, path, body] of [
      ["GET", pools(), undefined],
      ["GET", `${pools()}/${mine.json.id}`, undefined],
      ["POST", pools(), { name: "intruder", tags: ["x"] }],
      ["PATCH", `${pools()}/${mine.json.id}`, { enabled: false }],
      ["DELETE", `${pools()}/${mine.json.id}`, undefined],
    ] as const) {
      const res = await call("outsider", method, path, body);
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    // and through their own organization's path the pool is not theirs either
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { enabled: false }],
      ["DELETE", undefined],
    ] as const) {
      const res = await call("outsider", method, `${pools(o2)}/${mine.json.id}`, body);
      expect([method, res.status]).toEqual([method, 404]);
    }
    expect((await call("viewer", "GET", `${pools()}/${mine.json.id}`)).json.enabled).toBe(true);
  });
});

describe("changing a pool", () => {
  test("changes only what is given, null clears the image, and the audit event says what it was", async () => {
    const p = await make({ tags: ["a"], image: "iac:1" });
    const url = `${pools()}/${p.json.id}`;
    const tags = await call("admin", "PATCH", url, { tags: ["b", "c"] });
    expect(tags.status).toBe(200);
    expect(tags.json).toMatchObject({ tags: ["b", "c"], image: "iac:1", enabled: true });
    expect((await call("admin", "PATCH", url, { image: null })).json.image).toBeNull();
    expect((await call("admin", "PATCH", url, { enabled: false })).json.enabled).toBe(false);
    const events = (await auditsOf("pool.update")).filter((e) => e.resourceId === p.json.id);
    expect(events).toHaveLength(3);
    expect(events[0]?.metadata).toMatchObject({
      tags: ["b", "c"],
      previous: { tags: ["a"], image: "iac:1", enabled: true, isDefault: false },
    });
  });

  test("refuses an empty body, a name change and bad values", async () => {
    const p = await make();
    const url = `${pools()}/${p.json.id}`;
    for (const body of [
      {},
      { name: "renamed" },
      { tags: [] },
      { tags: ["$X"] },
      { image: "a b" },
      { image: "Registry/IaC:1" },
      { enabled: null },
    ]) {
      const res = await call("admin", "PATCH", url, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    expect((await call("admin", "GET", url)).json).toEqual(p.json);
  });

  test("an unknown pool is a 404", async () => {
    const res = await call("admin", "PATCH", `${pools()}/0190b2a0-0000-7000-8000-000000000000`, {
      enabled: false,
    });
    expect(res.status).toBe(404);
  });

  test("making a pool the default takes it from the old one in one step, and both are in the audit event", async () => {
    const org = await lonely("swap", 991);
    const a = await make({ name: "first", isDefault: true }, "boss", org);
    const b = await make({ name: "second" }, "boss", org);
    expect(a.json.isDefault).toBe(true);
    const swap = await call("boss", "PATCH", `${pools(org)}/${b.json.id}`, { isDefault: true });
    expect(swap.status).toBe(200);
    expect(swap.json.isDefault).toBe(true);
    expect((await listed("boss", org)).filter((p) => p.isDefault).map((p) => p.name)).toEqual([
      "second",
    ]);
    const events = (await auditsOf("pool.update", org)).filter((e) => e.resourceId === b.json.id);
    expect(events[0]?.metadata).toMatchObject({
      isDefault: true,
      demoted: { id: a.json.id, name: "first" },
    });
    // creating the default displaces the old one the same way
    const c = await make({ name: "third", isDefault: true }, "boss", org);
    expect(c.status).toBe(201);
    expect((await listed("boss", org)).filter((p) => p.isDefault).map((p) => p.name)).toEqual([
      "third",
    ]);
    // and clearing it is its own decision
    expect(
      (await call("boss", "PATCH", `${pools(org)}/${c.json.id}`, { isDefault: false })).json
        .isDefault,
    ).toBe(false);
  });

  test("the default cannot be disabled and a disabled pool cannot be the default: 409, and nothing moves", async () => {
    const org = await lonely("guarded", 992);
    const on = await make({ name: "on", isDefault: true }, "boss", org);
    const off = await make({ name: "off", enabled: false }, "boss", org);
    for (const [id, body] of [
      [on.json.id, { enabled: false }],
      [off.json.id, { isDefault: true }],
    ] as const) {
      const res = await call("boss", "PATCH", `${pools(org)}/${id}`, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 409]);
      expect(res.json).toMatchObject({ code: "pool_default_must_be_enabled" });
    }
    const made = await make({ name: "off-default", isDefault: true, enabled: false }, "boss", org);
    expect(made.status).toBe(409);
    expect((await listed("boss", org)).find((p) => p.isDefault)?.name).toBe("on");
  });
});

describe("removing a pool", () => {
  test("removes it, audits it with what it was, and a second removal is a 404", async () => {
    const p = await make({ name: "going", tags: ["bye"] });
    expect((await call("admin", "DELETE", `${pools()}/${p.json.id}`)).status).toBe(204);
    expect((await call("admin", "DELETE", `${pools()}/${p.json.id}`)).status).toBe(404);
    const events = (await auditsOf("pool.delete")).filter((e) => e.resourceId === p.json.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resourceType: "worker_pool",
      metadata: { name: "going", tags: ["bye"] },
    });
    expect((await listed()).map((x) => x.id)).not.toContain(p.json.id);
  });

  test("the default is not removed (409) until it has been cleared as a decision", async () => {
    const org = await lonely("keep", 993);
    const d = await make({ name: "def", isDefault: true }, "boss", org);
    const res = await call("boss", "DELETE", `${pools(org)}/${d.json.id}`);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "pool_is_default" });
    expect((await listed("boss", org)).map((p) => p.id)).toContain(d.json.id);
    expect(await auditsOf("pool.delete", org)).toHaveLength(0);
    await call("boss", "PATCH", `${pools(org)}/${d.json.id}`, { isDefault: false });
    expect((await call("boss", "DELETE", `${pools(org)}/${d.json.id}`)).status).toBe(204);
  });
});

describe("listing", () => {
  test("is in pages, in creation order", async () => {
    const org = await lonely("paged", 994);
    for (const name of ["l1", "l2", "l3"]) await make({ name }, "boss", org);
    const first = await call("boss", "GET", `${pools(org)}?limit=2`);
    expect(first.json.items.map((p: { name: string }) => p.name)).toEqual(["l1", "l2"]);
    expect(first.json.nextCursor).toBeTruthy();
    const rest = await call("boss", "GET", `${pools(org)}?limit=2&cursor=${first.json.nextCursor}`);
    expect(rest.json.items.map((p: { name: string }) => p.name)).toEqual(["l3"]);
  });
});
