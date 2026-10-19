import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  allCostLimits,
  auditEvents,
  costLimits,
  createOrganization,
  createSession,
  MAX_COST_LIMITS,
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

const limits = (org = o1) => `/organizations/${org}/cost-limits`;
const limit = (over: object = {}) => ({
  tag: null,
  maxMonthlyDelta: 500,
  warnAt: 300,
  currency: "USD",
  ...over,
});
const set = async (over: object = {}, who: keyof typeof people = "admin", org = o1) =>
  call(who, "PUT", limits(org), limit(over));
const auditsOf = async (action: string) =>
  await t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, o1)));
const listed = async (who: keyof typeof people = "viewer", org = o1) =>
  (await call(who, "GET", limits(org))).json.items as {
    id: string;
    tag: string | null;
    maxMonthlyDelta: number;
    warnAt: number | null;
    currency: string;
  }[];

describe("setting a cost limit", () => {
  test("an org admin sets the organization's own limit; the answer, the list and the audit event hold it", async () => {
    const res = await set({ tag: undefined });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: o1,
      tag: null,
      maxMonthlyDelta: 500,
      warnAt: 300,
      currency: "USD",
    });
    expect((await listed()).map((l) => l.id)).toContain(res.json.id);
    const events = (await auditsOf("cost.limit.set")).filter((e) => e.resourceId === res.json.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorKind: "user",
      resourceType: "cost_limit",
      metadata: { tag: null, maxMonthlyDelta: 500, warnAt: 300, currency: "USD", previous: null },
    });
  });

  test("setting the same scope again replaces it (200, the same id) and the audit event says what it replaced", async () => {
    const first = await set({ tag: "prod", maxMonthlyDelta: 100, warnAt: null });
    expect(first.status).toBe(201);
    const again = await set({ tag: "prod", maxMonthlyDelta: 250, warnAt: 200, currency: "EUR" });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({
      id: first.json.id,
      tag: "prod",
      maxMonthlyDelta: 250,
      warnAt: 200,
      currency: "EUR",
    });
    expect((await listed()).filter((l) => l.tag === "prod")).toHaveLength(1);
    const events = (await auditsOf("cost.limit.set")).filter((e) => e.resourceId === first.json.id);
    expect(events).toHaveLength(2);
    expect(events.at(-1)?.metadata).toMatchObject({
      maxMonthlyDelta: 250,
      previous: { maxMonthlyDelta: 100, warnAt: null, currency: "USD" },
    });
    // the same numbers again is still a change somebody made: it is written down
    expect(
      (await set({ tag: "prod", maxMonthlyDelta: 250, warnAt: 200, currency: "EUR" })).status,
    ).toBe(200);
    expect(
      (await auditsOf("cost.limit.set")).filter((e) => e.resourceId === first.json.id),
    ).toHaveLength(3);
  });

  test("a tag, a null tag and no tag are the scopes, a warning is optional, and savings are not a limit", async () => {
    const own = await set({ tag: null });
    const omitted = await set({ tag: undefined, maxMonthlyDelta: 600 });
    expect(omitted.status).toBe(200);
    expect(omitted.json.id).toBe(own.json.id);
    const bare = await call("admin", "PUT", limits(), {
      maxMonthlyDelta: 0,
      currency: "GBP",
      tag: "bare",
    });
    expect(bare.status).toBe(201);
    expect(bare.json).toMatchObject({
      tag: "bare",
      maxMonthlyDelta: 0,
      warnAt: null,
      currency: "GBP",
    });
    expect((await set({ tag: "edge", maxMonthlyDelta: 10, warnAt: 10 })).status).toBe(201);
  });

  test("refuses what is not a limit, with nothing stored and none of the submitted value in the answer", async () => {
    const before = (await listed()).length;
    const bad: [string, object][] = [
      ["a negative maximum", limit({ maxMonthlyDelta: -1 })],
      ["a maximum above a trillion", limit({ maxMonthlyDelta: 2e12 })],
      ["a string maximum", limit({ maxMonthlyDelta: "500" })],
      ["a null maximum", limit({ maxMonthlyDelta: null })],
      ["no maximum", { currency: "USD" }],
      ["a warning above the maximum", limit({ maxMonthlyDelta: 10, warnAt: 11 })],
      ["a negative warning", limit({ warnAt: -1 })],
      ["a lower-case currency", limit({ currency: "usd" })],
      ["a two-letter currency", limit({ currency: "US" })],
      ["a four-letter currency", limit({ currency: "USDD" })],
      ["a numeric currency", limit({ currency: 840 })],
      ["no currency", { maxMonthlyDelta: 1 }],
      ["a tag with a capital", limit({ tag: "Prod" })],
      ["a tag with a space", limit({ tag: "evil tag" })],
      ["an empty tag", limit({ tag: "" })],
      ["a tag of 33 characters", limit({ tag: "a".repeat(33) })],
      ["a numeric tag", limit({ tag: 5 })],
      ["an extra field", limit({ extra: 1 })],
    ];
    for (const [what, b] of bad) {
      const res = await call("admin", "PUT", limits(), b);
      expect([what, res.status]).toEqual([what, 422]);
      expect(res.text).not.toContain("evil tag");
    }
    expect(await listed()).toHaveLength(before);
  });

  test("an organization has at most so many scopes: a new one is a 409, a change to one it has is not", async () => {
    const org = (await createOrganization(t.db, { slug: "full", name: "Full" })).id;
    const user = await upsertUser(t.db, { gitlabId: 799, username: "boss", name: "Boss" });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    roleTable.set(799, { orgRoles: { [org]: "admin" }, projectRoles: {} });
    people.boss = `orch_session=${session}`;
    // filled directly: a hundred requests are not what this tests
    await t.db.insert(costLimits).values(
      Array.from({ length: MAX_COST_LIMITS }, (_, i) => ({
        organizationId: org,
        tag: `t${i}`,
        maxMonthlyDelta: 1,
        warnAt: null,
        currency: "USD",
      })),
    );
    const over = await set({ tag: "one-more" }, "boss", org);
    expect(over.status).toBe(409);
    expect(over.json).toMatchObject({ code: "too_many_cost_limits" });
    expect(await allCostLimits(t.db, org)).toHaveLength(MAX_COST_LIMITS);
    expect((await set({ tag: "t3", maxMonthlyDelta: 9, warnAt: null }, "boss", org)).status).toBe(
      200,
    );
    const first = (await allCostLimits(t.db, org))[0];
    expect((await call("boss", "DELETE", `${limits(org)}/${first?.id}`)).status).toBe(204);
    expect((await set({ tag: "now-there-is-room" }, "boss", org)).status).toBe(201);
  });
});

describe("who may do what with cost limits", () => {
  test("anyone in the organization reads; only an org admin or owner sets or removes", async () => {
    const one = await set({ tag: "who" });
    for (const who of ["owner", "admin", "member", "viewer"] as const) {
      expect([who, (await call(who, "GET", limits())).status]).toEqual([who, 200]);
    }
    for (const who of ["member", "viewer"] as const) {
      const made = await set({ tag: "who" }, who);
      expect([who, made.status]).toEqual([who, 403]);
      const del = await call(who, "DELETE", `${limits()}/${one.json.id}`);
      expect([who, del.status]).toEqual([who, 403]);
    }
    expect((await set({ tag: "who", maxMonthlyDelta: 1, warnAt: null }, "owner")).status).toBe(200);
    expect((await call("owner", "DELETE", `${limits()}/${one.json.id}`)).status).toBe(204);
  });

  test("a caller with no credentials is 401, and another organization's admin finds nothing: 404", async () => {
    expect((await call(undefined, "GET", limits())).status).toBe(401);
    expect((await call(undefined, "PUT", limits(), limit())).status).toBe(401);
    for (const [method, b] of [
      ["GET", undefined],
      ["PUT", limit()],
    ] as const) {
      const res = await call("outsider", method, limits(), b);
      expect([method, res.status]).toEqual([method, 404]);
    }
  });

  test("a limit of one organization cannot be removed or seen through another", async () => {
    const mine = await set({ tag: "mine" });
    expect((await call("outsider", "DELETE", `${limits(o2)}/${mine.json.id}`)).status).toBe(404);
    expect((await call("outsider", "DELETE", `${limits()}/${mine.json.id}`)).status).toBe(404);
    expect((await listed()).map((l) => l.id)).toContain(mine.json.id);
    expect((await listed("outsider", o2)).map((l) => l.id)).not.toContain(mine.json.id);
    // and the same scope in the other organization is its own limit
    const theirs = await set({ tag: "mine", maxMonthlyDelta: 7, warnAt: null }, "outsider", o2);
    expect(theirs.status).toBe(201);
    expect(theirs.json.id).not.toBe(mine.json.id);
    expect((await listed()).find((l) => l.id === mine.json.id)?.maxMonthlyDelta).toBe(500);
  });
});

describe("removing a cost limit", () => {
  test("removes it, audits it with what it was, and a second removal is a 404", async () => {
    const one = await set({ tag: "going", maxMonthlyDelta: 42, warnAt: 21 });
    expect((await call("admin", "DELETE", `${limits()}/${one.json.id}`)).status).toBe(204);
    expect((await call("admin", "DELETE", `${limits()}/${one.json.id}`)).status).toBe(404);
    const events = (await auditsOf("cost.limit.delete")).filter(
      (e) => e.resourceId === one.json.id,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resourceType: "cost_limit",
      metadata: { tag: "going", maxMonthlyDelta: 42, warnAt: 21, currency: "USD" },
    });
    expect((await listed()).map((l) => l.id)).not.toContain(one.json.id);
  });

  test("lists in pages", async () => {
    for (let i = 0; i < 3; i++) await set({ tag: `page${i}` }, "outsider", o2);
    const first = await call("outsider", "GET", `${limits(o2)}?limit=2`);
    expect(first.json.items.length).toBe(2);
    expect(first.json.nextCursor).toBeTruthy();
    const rest = await call(
      "outsider",
      "GET",
      `${limits(o2)}?limit=2&cursor=${first.json.nextCursor}`,
    );
    expect(rest.status).toBe(200);
    expect(rest.json.items.length).toBeGreaterThanOrEqual(1);
    const seen = [...first.json.items, ...rest.json.items].map((s: { id: string }) => s.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
