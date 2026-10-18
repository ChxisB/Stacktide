import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { pgConstraint } from "./pg-error";
import {
  createPolicySet,
  deletePolicySet,
  getPolicySet,
  listPolicySets,
  MAX_POLICY_SETS,
  ruleNames,
  storePolicyVerdict,
} from "./policy";
import { createOrganization, createProject, deleteOrganization } from "./repo";
import { createRun, getRun, moveRunStack } from "./runs";
import { policySets } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

let n = 0;
const org = () => createOrganization(t.db, { slug: `o${++n}`, name: "O" });
const set = (organizationId: string, over: Partial<Parameters<typeof createPolicySet>[1]> = {}) =>
  createPolicySet(t.db, {
    organizationId,
    name: `s${++n}`,
    source: "platform/policies",
    ref: "v1",
    path: ".",
    tag: "prod",
    ...over,
  });
const refusedBy = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return pgConstraint(e) ?? e;
  }
  return undefined;
};

describe("policy sets", () => {
  test("are made, read back, listed in order and deleted, each in its own organization", async () => {
    const [a, b] = [await org(), await org()];
    const one = await set(a.id, { name: "one" });
    const two = await set(a.id, { name: "two", path: "terraform", tag: "pci" });
    if (!one || !two) throw new Error("not made");
    expect(one).toMatchObject({ organizationId: a.id, name: "one", path: ".", tag: "prod" });
    expect((await listPolicySets(t.db, a.id, { limit: 10 })).map((s) => s.name)).toEqual([
      "one",
      "two",
    ]);
    expect(
      (await listPolicySets(t.db, a.id, { limit: 10, after: one.id })).map((s) => s.name),
    ).toEqual(["two"]);
    expect(await listPolicySets(t.db, b.id, { limit: 10 })).toEqual([]);
    // another organization sees none of it, and can delete none of it
    expect(await getPolicySet(t.db, b.id, one.id)).toBeUndefined();
    expect(await deletePolicySet(t.db, b.id, one.id)).toBe(false);
    expect(await deletePolicySet(t.db, a.id, one.id)).toBe(true);
    expect(await deletePolicySet(t.db, a.id, one.id)).toBe(false);
    expect((await listPolicySets(t.db, a.id, { limit: 10 })).map((s) => s.name)).toEqual(["two"]);
  });

  test("a name is taken once per organization", async () => {
    const [a, b] = [await org(), await org()];
    await set(a.id, { name: "rules" });
    expect(await refusedBy(set(a.id, { name: "rules" }))).toBe("policy_sets_org_name_key");
    expect(await set(b.id, { name: "rules" })).toBeDefined();
  });

  test("go with their organization", async () => {
    const a = await org();
    const s = await set(a.id);
    await deleteOrganization(t.db, a.id);
    expect(
      await t.db
        .select()
        .from(policySets)
        .where(eq(policySets.id, s?.id ?? "")),
    ).toEqual([]);
  });

  test("an organization has at most so many, however many are being made at once", async () => {
    const a = await org();
    for (let i = 0; i < MAX_POLICY_SETS - 2; i++) await set(a.id, { name: `s-${i}` });
    // three creators for the last two places: they take the organization in turn, and one is turned away
    const made = await Promise.all(
      ["x", "y", "z"].map((name) =>
        t.db.transaction((tx) =>
          createPolicySet(tx, {
            organizationId: a.id,
            name,
            source: "a/b",
            ref: "v1",
            path: ".",
            tag: "prod",
          }),
        ),
      ),
    );
    expect(made.filter((s) => s !== undefined)).toHaveLength(2);
    expect(await listPolicySets(t.db, a.id, { limit: 1000 })).toHaveLength(MAX_POLICY_SETS);
  });

  test("the table itself refuses an empty or oversized field", async () => {
    const a = await org();
    for (const bad of [
      { name: "" },
      { ref: "" },
      { path: "" },
      { tag: "x".repeat(33) },
      { source: "ab" },
    ]) {
      expect(await refusedBy(set(a.id, bad)), JSON.stringify(bad)).toBe("policy_sets_text_check");
    }
  });
});

describe("the verdict on a stack's plan", () => {
  const base = async () => {
    const a = await org();
    const p = await createProject(t.db, { organizationId: a.id, name: `p${++n}` });
    const run = await createRun(t.db, {
      organizationId: a.id,
      projectId: p.id,
      ref: "feature",
      sha: "a".repeat(40),
      mergeRequestIid: 1,
      kind: "plan",
      stacks: ["db", "net"],
    });
    return { a, p, run, at: [a.id, p.id, run.id] as const };
  };
  const stackOf = async (r: Awaited<ReturnType<typeof base>>, name: string) =>
    (await getRun(t.db, r.a.id, r.p.id, r.run.id))?.stacks.find((s) => s.stack === name);

  test("a stack has none until the policy has spoken", async () => {
    const r = await base();
    expect(await stackOf(r, "db")).toMatchObject({
      policyVerdict: null,
      policyDenied: null,
      policyWarned: null,
      policyAt: null,
    });
  });

  test("is worked out from the report: pass, warn, deny, and a failed evaluation is a deny", async () => {
    const r = await base();
    const post = (stack: string, report: Parameters<typeof storePolicyVerdict>[5]) =>
      storePolicyVerdict(t.db, ...r.at, stack, report);
    expect(await post("db", { evaluated: true, denied: [], warned: [] })).toMatchObject({
      policyVerdict: "pass",
    });
    expect(
      await post("db", { evaluated: true, denied: [], warned: ["data.main.warn_tags"] }),
    ).toMatchObject({ policyVerdict: "warn" });
    const denied = await post("db", {
      evaluated: true,
      denied: ["data.main.deny_public"],
      warned: ["data.main.warn_tags"],
    });
    expect(denied).toMatchObject({ policyVerdict: "deny" });
    const stored = await stackOf(r, "db");
    expect(stored?.policyVerdict).toBe("deny");
    expect(ruleNames(stored?.policyDenied)).toEqual(["data.main.deny_public"]);
    expect(ruleNames(stored?.policyWarned)).toEqual(["data.main.warn_tags"]);
    expect(stored?.policyAt).toBeInstanceOf(Date);
    // the other stack of the run is as it was
    expect((await stackOf(r, "net"))?.policyVerdict).toBeNull();
    expect(await post("net", { evaluated: false, denied: [], warned: [] })).toMatchObject({
      policyVerdict: "deny",
    });
    expect(ruleNames((await stackOf(r, "net"))?.policyDenied)).toEqual(["evaluator-failed"]);
  });

  test("a later report replaces an earlier one (the job may post twice)", async () => {
    const r = await base();
    await storePolicyVerdict(t.db, ...r.at, "db", {
      evaluated: true,
      denied: ["data.main.deny_x"],
      warned: [],
    });
    await storePolicyVerdict(t.db, ...r.at, "db", { evaluated: true, denied: [], warned: [] });
    expect(await stackOf(r, "db")).toMatchObject({ policyVerdict: "pass" });
    expect(ruleNames((await stackOf(r, "db"))?.policyDenied)).toEqual([]);
  });

  test("is taken only while the plan is open, and only for the run's own stack", async () => {
    const r = await base();
    const report = { evaluated: true, denied: [], warned: [] };
    expect(await storePolicyVerdict(t.db, ...r.at, "nope", report)).toBeUndefined();
    // another project's or organization's ids reach nothing
    const other = await base();
    expect(
      await storePolicyVerdict(t.db, other.a.id, other.p.id, r.run.id, "db", report),
    ).toBeUndefined();
    expect(
      await storePolicyVerdict(t.db, r.a.id, other.p.id, r.run.id, "db", report),
    ).toBeUndefined();
    for (const [from, to] of [
      ["queued", "planning"],
      ["planning", "planned"],
      ["planned", "applying"],
      ["applying", "applied"],
    ] as const) {
      await moveRunStack(t.db, ...r.at, "db", from, to);
    }
    // an applied stack is history: a late verdict cannot rewrite what it was applied under
    expect(await storePolicyVerdict(t.db, ...r.at, "db", report)).toBeUndefined();
    expect((await stackOf(r, "db"))?.policyVerdict).toBeNull();
  });

  test("the table refuses a half-set verdict, one that is not one, and one that is huge", async () => {
    const r = await base();
    const run = (set: ReturnType<typeof sql>) =>
      refusedBy(
        t.db.execute(sql`UPDATE run_stacks SET ${set} WHERE run_id = ${r.run.id} AND stack = 'db'`),
      );
    expect(await run(sql`policy_verdict = 'pass'`)).toBe("run_stacks_policy_check");
    expect(
      await run(
        sql`policy_verdict = 'allow', policy_at = now(), policy_denied = '[]'::jsonb, policy_warned = '[]'::jsonb`,
      ),
    ).toBe("run_stacks_policy_check");
    expect(
      await run(
        sql`policy_verdict = 'deny', policy_at = now(), policy_denied = to_jsonb(repeat('x', 100001)), policy_warned = '[]'::jsonb`,
      ),
    ).toBe("run_stacks_policy_check");
  });
});

test("rule names are read from what the column holds, and from nothing else", () => {
  expect(ruleNames(["a", "b"])).toEqual(["a", "b"]);
  expect(ruleNames(null)).toEqual([]);
  expect(ruleNames("a")).toEqual([]);
  expect(ruleNames([1, "a", null])).toEqual(["a"]);
});
