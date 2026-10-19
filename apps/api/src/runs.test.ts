import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  auditEvents,
  createOrganization,
  createProject,
  createRun,
  createSession,
  moveRunStack,
  type NewStack,
  runs,
  setCostLimit,
  storePlanSummary,
  syncStacks,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, count, eq } from "drizzle-orm";
import { createApp } from "./app";
import { sessionPrincipal } from "./session";
import { hashToken, randomToken } from "./tokens";

let t: TestDb;
let app: ReturnType<typeof makeApp>;
const ids = {} as Record<"o1" | "o2" | "p1" | "p2" | "q1", string>;
const people = {} as Record<
  "alice" | "bob" | "carol" | "dave" | "erin" | "frank" | "gina",
  { id: string; token: string; gitlabId: number }
>;
type Who = keyof typeof people | "nobody";
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();

const makeApp = () =>
  createApp({
    logger: createLogger({ write: () => {} }),
    db: t.db,
    principal: sessionPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
  });

const stack = (name: string): NewStack => ({
  name,
  path: name,
  tool: "tofu",
  version: "1.9.8",
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command",
  backend: "http",
});

const SHA = "c".repeat(40);

beforeAll(async () => {
  t = await createTestDb();
  ids.o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  ids.o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  ids.p1 = (await createProject(t.db, { organizationId: ids.o1, name: "p1" })).id;
  ids.p2 = (await createProject(t.db, { organizationId: ids.o1, name: "p2" })).id;
  ids.q1 = (await createProject(t.db, { organizationId: ids.o2, name: "q1" })).id;
  const seed = (org: string, project: string, names: string[]) =>
    syncStacks(t.db, org, project, names.map(stack), { prune: false });
  await seed(ids.o1, ids.p1, ["net", "app", "db"]);
  await seed(ids.o1, ids.p2, ["only-p2"]);
  await seed(ids.o2, ids.q1, ["net", "only-q1"]);

  let gitlabId = 500;
  for (const name of ["alice", "bob", "carol", "dave", "erin", "frank", "gina"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const token = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(token), ttlMs: 60_000 });
    people[name] = { id: user.id, token, gitlabId };
  }
  const roles = (orgRoles: Subject["orgRoles"], projectRoles: Subject["projectRoles"] = {}) => ({
    orgRoles,
    projectRoles,
  });
  roleTable.set(people.alice.gitlabId, roles({ [ids.o1]: "owner" }));
  roleTable.set(people.bob.gitlabId, roles({ [ids.o1]: "viewer" })); // reporter on every project
  roleTable.set(people.carol.gitlabId, roles({ [ids.o1]: "member" })); // developer on every project
  roleTable.set(people.dave.gitlabId, roles({ [ids.o2]: "owner" }));
  // no organization role: a role on one project only
  roleTable.set(people.frank.gitlabId, roles({}, { [ids.p1]: "developer" }));
  roleTable.set(people.gina.gitlabId, roles({}, { [ids.p1]: "reporter" }));
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

async function call(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who !== "nobody") headers.cookie = `orch_session=${people[who].token}`;
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
  return { status: res.status, json: (text ? JSON.parse(text) : undefined) as any };
}

const runsPath = (org = ids.o1, project = ids.p1) =>
  `/organizations/${org}/projects/${project}/runs`;
const valid = (extra: Record<string, unknown> = {}) => ({
  ref: "feature/net",
  sha: SHA,
  stacks: ["net", "app"],
  ...extra,
});
const counts = async () => [
  (await t.db.select({ n: count() }).from(runs))[0]?.n,
  (
    await t.db.select({ n: count() }).from(auditEvents).where(eq(auditEvents.action, "run.create"))
  )[0]?.n,
];

describe("creating a run", () => {
  test("records the run with every stack queued, and the audit event says what and by whom", async () => {
    const res = await call("carol", "POST", runsPath(), valid({ mergeRequestIid: 7 }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: ids.o1,
      projectId: ids.p1,
      ref: "feature/net",
      sha: SHA,
      mergeRequestIid: 7,
      kind: "plan",
    });
    expect(
      res.json.stacks.map((s: { name: string; status: string; error: unknown }) => [
        s.name,
        s.status,
        s.error,
      ]),
    ).toEqual([
      ["app", "queued", null],
      ["net", "queued", null],
    ]);

    const [event] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "run.create"), eq(auditEvents.resourceId, res.json.id)));
    expect(event).toMatchObject({
      actorKind: "user",
      actorId: people.carol.id,
      organizationId: ids.o1,
      projectId: ids.p1,
      resourceType: "run",
      metadata: { ref: "feature/net", sha: SHA, mergeRequestIid: 7, stacks: ["net", "app"] },
    });
  });

  test("a run of a hundred stacks with the longest names is made, and its audit event lists the first few", async () => {
    // an audit event holds 4096 bytes of metadata; a hundred 63-character names are more than that
    const project = (await createProject(t.db, { organizationId: ids.o1, name: "wide" })).id;
    const names = Array.from(
      { length: 100 },
      (_, i) => `${"s".repeat(60)}${String(i).padStart(3, "0")}`,
    );
    await syncStacks(t.db, ids.o1, project, names.map(stack), { prune: false });
    const res = await call("alice", "POST", runsPath(ids.o1, project), valid({ stacks: names }));
    expect(res.status).toBe(201);
    expect(res.json.stacks).toHaveLength(100);
    const [event] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "run.create"), eq(auditEvents.resourceId, res.json.id)));
    expect(event?.metadata).toMatchObject({ stackCount: 100, stacks: names.slice(0, 20) });
  });

  test("a merge request is optional", async () => {
    const res = await call("alice", "POST", runsPath(), valid());
    expect(res.status).toBe(201);
    expect(res.json.mergeRequestIid).toBeNull();
  });

  test("a developer may, a reporter and a viewer may not, and someone with no role cannot tell it exists", async () => {
    const before = await counts();
    expect((await call("frank", "POST", runsPath(), valid())).status).toBe(201); // a project role is enough
    for (const who of ["bob", "gina"] as const) {
      const res = await call(who, "POST", runsPath(), valid());
      expect([who, res.status, res.json.code]).toEqual([who, 403, "forbidden"]);
    }
    for (const who of ["erin", "dave"] as const) {
      expect([who, (await call(who, "POST", runsPath(), valid())).status]).toEqual([who, 404]);
    }
    expect(await counts()).toEqual([(before[0] ?? 0) + 1, (before[1] ?? 0) + 1]);
  });

  test("a role on one project is no role on another, and ids must belong together", async () => {
    const before = await counts();
    expect(
      (await call("frank", "POST", runsPath(ids.o1, ids.p2), valid({ stacks: ["only-p2"] })))
        .status,
    ).toBe(404);
    // dave owns o2 but names o1's project, and the other way round
    expect((await call("dave", "POST", runsPath(ids.o2, ids.p1), valid())).status).toBe(404);
    expect((await call("alice", "POST", runsPath(ids.o1, ids.q1), valid())).status).toBe(404);
    expect((await call("alice", "POST", runsPath(ids.o2, ids.p1), valid())).status).toBe(404);
    expect(await counts()).toEqual(before);
  });

  test("a project that does not exist has no runs to start or list", async () => {
    const gone = "00000000-0000-4000-8000-000000000002";
    expect((await call("alice", "POST", runsPath(ids.o1, gone), valid())).status).toBe(404);
    expect((await call("alice", "GET", runsPath(ids.o1, gone))).status).toBe(404);
  });

  test("a stack the project does not have is refused, also one only another project has", async () => {
    const before = await counts();
    for (const stacks of [
      ["nope"],
      ["net", "only-p2"],
      ["only-q1"],
      ["net", "x1", "x2", "x3", "x4", "x5", "x6"],
    ]) {
      const res = await call("alice", "POST", runsPath(), valid({ stacks }));
      expect([stacks, res.status, res.json.code]).toEqual([stacks, 422, "unknown_stack"]);
    }
    // the answer names a few of them, not all
    const many = await call(
      "alice",
      "POST",
      runsPath(),
      valid({ stacks: ["a", "b", "c", "d", "e", "f", "g"] }),
    );
    expect(many.json.detail).toBe(
      'This project has no stack named "a", "b", "c", "d", "e" or others',
    );
    expect(await counts()).toEqual(before);
  });

  test("input that is not a run is refused with nothing written", async () => {
    const before = await counts();
    const bad: [string, Record<string, unknown>][] = [
      ["no stacks", { stacks: [] }],
      ["a stack twice", { stacks: ["net", "net"] }],
      ["an empty name", { stacks: [""] }],
      ["a long name", { stacks: ["n".repeat(64)] }],
      ["101 stacks", { stacks: Array.from({ length: 101 }, (_, i) => `s${i}`) }],
      ["a name that is not text", { stacks: [1] }],
      ["no sha", { sha: undefined }],
      ["a short sha", { sha: "abc123" }],
      ["a sha in capitals", { sha: "C".repeat(40) }],
      ["no ref", { ref: undefined }],
      ["a ref with a space", { ref: "a b" }],
      ["a ref that climbs", { ref: "a/../b" }],
      ["a ref ending in /", { ref: "a/" }],
      ["a ref ending in .lock", { ref: "a.lock" }],
      ["a ref ending in a dot", { ref: "a." }],
      ["a ref with an empty part", { ref: "a//b" }],
      ["a ref with a part starting with a dot", { ref: "a/.b" }],
      ["a ref with a part ending in .lock", { ref: "a/b.lock/c" }],
      ["a ref with two dots", { ref: "a..b" }],
      ["a long ref", { ref: "r".repeat(256) }],
      ["merge request 0", { mergeRequestIid: 0 }],
      ["a merge request past 32 bits", { mergeRequestIid: 2 ** 31 }],
      ["a fractional merge request", { mergeRequestIid: 1.5 }],
      ["a state of its own", { status: "applied" }],
      ["an organization of its own", { organizationId: ids.o2 }],
      ["a project of its own", { projectId: ids.p2 }],
    ];
    for (const [what, extra] of bad) {
      const res = await call("alice", "POST", runsPath(), valid(extra));
      // refused for what it is, not because its stacks are not there
      expect([what, res.status, res.json.code === "unknown_stack"]).toEqual([what, 422, false]);
    }
    expect((await call("alice", "POST", runsPath(), "not json")).status).toBe(422);
    expect(await counts()).toEqual(before);
    // refs git accepts, and the longest ref and a full-length sha, are fine
    for (const ref of ["release/1.2.3", "v1.0", "a.b/c-d_e", "x.lockfile", "a@b"]) {
      const res = await call("alice", "POST", runsPath(), valid({ ref }));
      expect([ref, res.status]).toEqual([ref, ref === "a@b" ? 422 : 201]);
    }
    expect(
      (
        await call(
          "alice",
          "POST",
          runsPath(),
          valid({ ref: `r${"e".repeat(254)}`, sha: "d".repeat(64) }),
        )
      ).status,
    ).toBe(201);
  });
});

describe("what a run's plans cost", () => {
  const summary = (monthlyDelta: number | null) => ({
    add: 1,
    change: 0,
    destroy: 0,
    resources: [],
    ...(monthlyDelta === null
      ? {}
      : { cost: { monthlyDelta, monthlyTotal: 900, currency: "USD", tool: "infracost" } }),
  });
  const limit = (org: string, tag: string | null, maxMonthlyDelta: number) =>
    setCostLimit(t.db, {
      organizationId: org,
      tag,
      maxMonthlyDelta,
      warnAt: null,
      currency: "USD",
    });

  test("each stack says what it is estimated to cost and what the limit that reaches it makes of that, as the apply would judge it now", async () => {
    const run = await createRun(t.db, {
      organizationId: ids.o1,
      projectId: ids.p1,
      ref: "feature/cost",
      sha: SHA,
      stacks: ["net", "app", "db"],
      tags: { net: ["prod"] },
    });
    const store = (name: string, delta: number | null) =>
      storePlanSummary(t.db, ids.o1, ids.p1, run.id, name, summary(delta));
    await store("net", 42);
    await store("app", 42);
    await limit(ids.o1, null, 100);
    await limit(ids.o1, "prod", 30);
    // a limit of another organization reaches nothing here
    await limit(ids.o2, null, 1);

    const read = (await call("bob", "GET", `${runsPath()}/${run.id}`)).json;
    const cost = (name: string) => read.stacks.find((s: { name: string }) => s.name === name).cost;
    const estimate = { monthlyDelta: 42, monthlyTotal: 900, currency: "USD", tool: "infracost" };
    // the stack's own tag has the stricter limit; the others have the organization's
    expect(cost("net")).toEqual({
      estimate,
      limit: { tag: "prod", maxMonthlyDelta: 30, warnAt: null, currency: "USD" },
      verdict: "deny",
      rules: ["cost-over-limit"],
    });
    expect(cost("app")).toEqual({
      estimate,
      limit: { tag: null, maxMonthlyDelta: 100, warnAt: null, currency: "USD" },
      verdict: "pass",
      rules: [],
    });
    // nothing has summarized this plan: its estimator may still run, so nothing is said yet
    expect(cost("db")).toBeNull();
    const listed = (await call("bob", "GET", `${runsPath()}?limit=100`)).json.items;
    expect(listed.find((r: { id: string }) => r.id === run.id)).toEqual(read);

    // the limits as they are now: raised, the same plan passes
    await limit(ids.o1, "prod", 50);
    const later = (await call("bob", "GET", `${runsPath()}/${run.id}`)).json;
    expect(later.stacks.find((s: { name: string }) => s.name === "net").cost).toMatchObject({
      verdict: "pass",
      rules: [],
    });
  });

  test("a run made through the API keeps the tags the project's stacks have, so its limit is the one an apply would use", async () => {
    const p4 = (await createProject(t.db, { organizationId: ids.o1, name: "p4" })).id;
    await syncStacks(t.db, ids.o1, p4, [{ ...stack("gold-net"), tags: ["gold"] }, stack("plain")], {
      prune: false,
    });
    await limit(ids.o1, "gold", 10);
    const made = (
      await call("carol", "POST", runsPath(ids.o1, p4), valid({ stacks: ["gold-net", "plain"] }))
    ).json;
    for (const name of ["gold-net", "plain"]) {
      await storePlanSummary(t.db, ids.o1, p4, made.id, name, summary(42));
    }
    const read = (await call("bob", "GET", `${runsPath(ids.o1, p4)}/${made.id}`)).json;
    const cost = (name: string) => read.stacks.find((s: { name: string }) => s.name === name).cost;
    expect(cost("gold-net")).toMatchObject({ limit: { tag: "gold" }, verdict: "deny" });
    expect(cost("plain")).toMatchObject({ limit: { tag: null } });
  });

  test("an estimate with no limit is shown and judged by nothing; a limit with no estimate denies; neither says nothing", async () => {
    const run = await createRun(t.db, {
      organizationId: ids.o2,
      projectId: ids.q1,
      ref: "feature/cost",
      sha: SHA,
      stacks: ["net", "only-q1"],
      tags: { net: ["lonely"] },
    });
    await storePlanSummary(t.db, ids.o2, ids.q1, run.id, "net", summary(5));
    await storePlanSummary(t.db, ids.o2, ids.q1, run.id, "only-q1", summary(null));
    const read = (await call("dave", "GET", `${runsPath(ids.o2, ids.q1)}/${run.id}`)).json;
    const cost = (name: string) => read.stacks.find((s: { name: string }) => s.name === name).cost;
    // o2's limit is the organization's own: 1 a month, so a plan with no estimate is denied
    expect(cost("only-q1")).toMatchObject({
      estimate: null,
      verdict: "deny",
      rules: ["cost-unavailable"],
    });
    expect(cost("net")).toMatchObject({ verdict: "deny", rules: ["cost-over-limit"] });

    // no limit at all (another organization's are not this one's): the estimate stands alone
    const o3 = (await createOrganization(t.db, { slug: "three", name: "Three" })).id;
    const p3 = (await createProject(t.db, { organizationId: o3, name: "p3" })).id;
    await syncStacks(t.db, o3, p3, [stack("solo")], { prune: false });
    roleTable.set(people.erin.gitlabId, { orgRoles: { [o3]: "viewer" }, projectRoles: {} });
    const bare = await createRun(t.db, {
      organizationId: o3,
      projectId: p3,
      ref: "feature/cost",
      sha: SHA,
      stacks: ["solo"],
    });
    await storePlanSummary(t.db, o3, p3, bare.id, "solo", summary(5));
    const seen = (await call("erin", "GET", `${runsPath(o3, p3)}/${bare.id}`)).json;
    expect(seen.stacks[0].cost).toMatchObject({ limit: null, verdict: "pass" });
    // a stack no limit reaches and nothing estimated says nothing at all
    await storePlanSummary(t.db, o3, p3, bare.id, "solo", summary(null));
    const none = (await call("erin", "GET", `${runsPath(o3, p3)}/${bare.id}`)).json;
    expect(none.stacks[0].cost).toBeNull();
  });
});

describe("reading runs", () => {
  test("a run is read back as made, by anyone who may read the project", async () => {
    const made = (await call("carol", "POST", runsPath(), valid({ mergeRequestIid: 9 }))).json;
    for (const who of ["alice", "bob", "carol", "frank", "gina"] as const) {
      const res = await call(who, "GET", `${runsPath()}/${made.id}`);
      expect([who, res.status]).toEqual([who, 200]);
      expect(res.json).toEqual(made);
    }
  });

  test("a drift run says so, and a request cannot make one", async () => {
    const drift = await createRun(t.db, {
      organizationId: ids.o1,
      projectId: ids.p1,
      ref: "main",
      sha: SHA,
      kind: "drift",
      stacks: ["net"],
    });
    const read = await call("bob", "GET", `${runsPath()}/${drift.id}`);
    expect(read.json).toMatchObject({ kind: "drift", mergeRequestIid: null, ref: "main" });
    const listed = (await call("bob", "GET", `${runsPath()}?limit=100`)).json.items;
    expect(listed.find((r: { id: string }) => r.id === drift.id)).toEqual(read.json);
    // the body is closed: a client cannot start one
    expect((await call("carol", "POST", runsPath(), valid({ kind: "drift" }))).status).toBe(422);
  });

  test("a run last changed when its newest stack did", async () => {
    const made = (await call("carol", "POST", runsPath(), valid())).json;
    await Bun.sleep(5);
    await moveRunStack(t.db, ids.o1, ids.p1, made.id, "net", "queued", "planning");
    const read = (await call("bob", "GET", `${runsPath()}/${made.id}`)).json;
    const net = read.stacks.find((s: { name: string }) => s.name === "net");
    expect(net.status).toBe("planning");
    expect(read.updatedAt).toBe(net.updatedAt);
    expect(read.updatedAt > made.updatedAt).toBe(true);
    expect(read.createdAt).toBe(made.createdAt);
    // the list says the same
    const listed = (await call("bob", "GET", `${runsPath()}?limit=100`)).json.items;
    expect(listed.find((r: { id: string }) => r.id === made.id)).toEqual(read);
  });

  test("a stranger, another organization and mismatched ids find nothing", async () => {
    const made = (await call("carol", "POST", runsPath(), valid())).json;
    const missing = "00000000-0000-4000-8000-000000000001";
    for (const [who, path] of [
      ["erin", `${runsPath()}/${made.id}`],
      ["dave", `${runsPath()}/${made.id}`],
      ["dave", `${runsPath(ids.o2, ids.p1)}/${made.id}`],
      ["alice", `${runsPath(ids.o1, ids.p2)}/${made.id}`], // a project of the org, but not the run's
      ["alice", `${runsPath(ids.o2, ids.q1)}/${made.id}`],
      ["alice", `${runsPath()}/${missing}`],
    ] as const) {
      expect([who, path, (await call(who, "GET", path)).status]).toEqual([who, path, 404]);
    }
    expect((await call("alice", "GET", `${runsPath()}/not-a-uuid`)).status).toBe(422);
  });

  test("the list is the project's own, newest first, a page at a time", async () => {
    const mine = [];
    for (let i = 0; i < 5; i++) {
      mine.push(
        (
          await call(
            "alice",
            "POST",
            runsPath(ids.o1, ids.p2),
            valid({ stacks: ["only-p2"], ref: `b${i}` }),
          )
        ).json.id,
      );
    }
    await call("alice", "POST", runsPath(), valid());
    const newest = [...mine].reverse();

    const first = await call("bob", "GET", `${runsPath(ids.o1, ids.p2)}?limit=2`);
    expect(first.status).toBe(200);
    expect(first.json.items.map((r: { id: string }) => r.id)).toEqual(newest.slice(0, 2));
    expect(first.json.items[0].stacks[0]).toMatchObject({ name: "only-p2", status: "queued" });
    const second = await call(
      "bob",
      "GET",
      `${runsPath(ids.o1, ids.p2)}?limit=2&cursor=${first.json.nextCursor}`,
    );
    expect(second.json.items.map((r: { id: string }) => r.id)).toEqual(newest.slice(2, 4));
    const last = await call(
      "bob",
      "GET",
      `${runsPath(ids.o1, ids.p2)}?limit=2&cursor=${second.json.nextCursor}`,
    );
    expect(last.json.items.map((r: { id: string }) => r.id)).toEqual(newest.slice(4));
    expect(last.json.nextCursor).toBeNull();
  });

  test("a bad cursor or limit is refused; a stranger sees no list", async () => {
    expect((await call("alice", "GET", `${runsPath()}?cursor=garbage`)).json.code).toBe(
      "invalid_cursor",
    );
    expect((await call("alice", "GET", `${runsPath()}?limit=101`)).status).toBe(422);
    expect((await call("alice", "GET", `${runsPath()}?limit=0`)).status).toBe(422);
    for (const who of ["erin", "dave"] as const) {
      expect([who, (await call(who, "GET", runsPath())).status]).toEqual([who, 404]);
    }
    expect((await call("nobody", "GET", runsPath())).status).toBe(401);
    expect((await call("nobody", "POST", runsPath(), valid())).status).toBe(401);
  });
});
