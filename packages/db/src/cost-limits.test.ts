import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  allCostLimits,
  type CostLimitInput,
  deleteCostLimit,
  getCostLimit,
  listCostLimits,
  MAX_COST_LIMITS,
  setCostLimit,
} from "./cost-limits";
import { pgConstraint } from "./pg-error";
import { createOrganization } from "./repo";
import { costLimits } from "./schema";
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
const input = (organizationId: string, over: Partial<CostLimitInput> = {}): CostLimitInput => ({
  organizationId,
  tag: null,
  maxMonthlyDelta: 500,
  warnAt: null,
  currency: "USD",
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

describe("cost limits", () => {
  test("an organization has one of its own and one per stack tag; setting one again replaces it and keeps its id", async () => {
    const a = await org();
    const own = await setCostLimit(t.db, input(a.id, { warnAt: 300 }));
    const prod = await setCostLimit(t.db, input(a.id, { tag: "prod", maxMonthlyDelta: 50 }));
    expect(own?.previous).toBeUndefined();
    expect(own?.row).toMatchObject({ organizationId: a.id, tag: null, maxMonthlyDelta: 500 });
    expect(prod?.row.id).not.toBe(own?.row.id);

    const again = await setCostLimit(
      t.db,
      input(a.id, { maxMonthlyDelta: 900, warnAt: null, currency: "EUR" }),
    );
    expect(again?.row).toMatchObject({
      id: own?.row.id,
      tag: null,
      maxMonthlyDelta: 900,
      warnAt: null,
      currency: "EUR",
    });
    expect(again?.previous).toMatchObject({ maxMonthlyDelta: 500, warnAt: 300, currency: "USD" });
    expect((await allCostLimits(t.db, a.id)).map((l) => [l.tag, l.maxMonthlyDelta])).toEqual([
      [null, 900],
      ["prod", 50],
    ]);
  });

  test("another organization has its own, whatever tag", async () => {
    const [a, b] = [await org(), await org()];
    await setCostLimit(t.db, input(a.id, { maxMonthlyDelta: 1 }));
    await setCostLimit(t.db, input(b.id, { maxMonthlyDelta: 2 }));
    await setCostLimit(t.db, input(a.id, { tag: "prod", maxMonthlyDelta: 3 }));
    await setCostLimit(t.db, input(b.id, { tag: "prod", maxMonthlyDelta: 4 }));
    expect((await allCostLimits(t.db, a.id)).map((l) => l.maxMonthlyDelta)).toEqual([1, 3]);
    expect((await allCostLimits(t.db, b.id)).map((l) => l.maxMonthlyDelta)).toEqual([2, 4]);
  });

  test("are read back, listed in pages in order and deleted, each in its own organization", async () => {
    const [a, b] = [await org(), await org()];
    const made = [];
    for (const tag of [null, "pci", "prod"])
      made.push((await setCostLimit(t.db, input(a.id, { tag })))?.row);
    const [own, pci, prod] = made;
    if (!own || !pci || !prod) throw new Error("not made");

    expect((await listCostLimits(t.db, a.id, { limit: 10 })).map((l) => l.id)).toEqual([
      own.id,
      pci.id,
      prod.id,
    ]);
    expect(
      (await listCostLimits(t.db, a.id, { limit: 10, after: pci.id })).map((l) => l.id),
    ).toEqual([prod.id]);
    expect(await listCostLimits(t.db, b.id, { limit: 10 })).toEqual([]);

    expect(await getCostLimit(t.db, b.id, own.id)).toBeUndefined();
    expect(await deleteCostLimit(t.db, b.id, own.id)).toBeUndefined();
    expect(await deleteCostLimit(t.db, a.id, own.id)).toMatchObject({ id: own.id, tag: null });
    expect(await deleteCostLimit(t.db, a.id, own.id)).toBeUndefined();
    expect((await allCostLimits(t.db, a.id)).map((l) => l.tag)).toEqual(["pci", "prod"]);
    // the organization's own is free to be set again once it is gone
    expect((await setCostLimit(t.db, input(a.id)))?.previous).toBeUndefined();
  });

  test("an organization has at most so many: a new scope is refused at the cap, a change to an existing one is not", async () => {
    const a = await org();
    await t.db.insert(costLimits).values(
      Array.from({ length: MAX_COST_LIMITS }, (_, i) => ({
        ...input(a.id, { tag: i === 0 ? null : `t${i}` }),
      })),
    );
    expect(await setCostLimit(t.db, input(a.id, { tag: "one-more" }))).toBeUndefined();
    expect(await allCostLimits(t.db, a.id)).toHaveLength(MAX_COST_LIMITS);
    expect(
      (await setCostLimit(t.db, input(a.id, { tag: "t1", maxMonthlyDelta: 7 })))?.row,
    ).toMatchObject({ maxMonthlyDelta: 7 });
    const gone = (await allCostLimits(t.db, a.id))[1];
    await deleteCostLimit(t.db, a.id, gone?.id as string);
    expect(await setCostLimit(t.db, input(a.id, { tag: "one-more" }))).toBeDefined();
  });

  test("the database refuses what is not a limit, whatever the caller checked", async () => {
    const a = await org();
    const bad: [string, Partial<CostLimitInput>][] = [
      ["a negative maximum", { maxMonthlyDelta: -1 }],
      ["a maximum above a trillion", { maxMonthlyDelta: 2e12 }],
      ["NaN", { maxMonthlyDelta: Number.NaN }],
      ["infinity", { maxMonthlyDelta: Number.POSITIVE_INFINITY }],
      ["a warning above the maximum", { maxMonthlyDelta: 10, warnAt: 11 }],
      ["a negative warning", { warnAt: -1 }],
      ["a lower-case currency", { currency: "usd" }],
      ["a currency of two letters", { currency: "US" }],
      ["a tag with a capital", { tag: "Prod" }],
      ["an empty tag", { tag: "" }],
      ["a tag of 33 characters", { tag: "a".repeat(33) }],
    ];
    for (const [what, over] of bad) {
      expect([what, await refusedBy(setCostLimit(t.db, input(a.id, over)))]).toEqual([
        what,
        "cost_limits_check",
      ]);
    }
    expect(await allCostLimits(t.db, a.id)).toEqual([]);
    // a warning at the maximum is allowed: it says the same thing as no room at all
    expect(
      await setCostLimit(t.db, input(a.id, { maxMonthlyDelta: 10, warnAt: 10 })),
    ).toBeDefined();
  });
});
