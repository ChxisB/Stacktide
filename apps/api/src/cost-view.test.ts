import { describe, expect, test } from "bun:test";
import type { CostLimit } from "@orch/core";
import { type CostStack, costViewOf } from "./cost-view";

const NOW = new Date("2026-10-19T00:00:00Z");
const stack = (over: Partial<CostStack> = {}): CostStack => ({
  tags: [],
  costed: true,
  summarizedAt: NOW,
  costMonthlyDelta: null,
  costMonthlyTotal: null,
  costCurrency: null,
  costTool: null,
  ...over,
});
const estimated = (delta: number, currency = "USD", over: Partial<CostStack> = {}) =>
  stack({
    costMonthlyDelta: delta,
    costMonthlyTotal: 500,
    costCurrency: currency,
    costTool: "infracost",
    ...over,
  });
const limit = (over: Partial<CostLimit> = {}): CostLimit => ({
  tag: null,
  maxMonthlyDelta: 100,
  warnAt: 80,
  currency: "USD",
  ...over,
});

describe("what a stack's plan costs, as it is shown", () => {
  test("nothing to show: a stack not planned yet, or planned with no estimate and no limit", () => {
    // a limit and a stack that has no summary yet is not "unavailable": the estimator may still run
    expect(costViewOf(stack({ summarizedAt: null }), [limit()])).toBeNull();
    expect(costViewOf(stack(), [])).toBeNull();
    expect(costViewOf(stack(), [limit({ tag: "prod" })])).toBeNull();
  });

  test("a stack that has no price to estimate (a DNS zone) is judged by no limit: nothing to show", () => {
    const zone = stack({ costed: false });
    expect(costViewOf(zone, [limit(), limit({ tag: "prod" })])).toBeNull();
    expect(costViewOf({ ...zone, tags: ["prod"] }, [limit({ tag: "prod" })])).toBeNull();
  });

  test("an estimate with no limit is shown and judges nothing", () => {
    expect(costViewOf(estimated(250), [])).toEqual({
      estimate: { monthlyDelta: 250, monthlyTotal: 500, currency: "USD", tool: "infracost" },
      limit: null,
      verdict: "pass",
      rules: [],
    });
  });

  test("pass, warn, deny, unavailable and a currency that is not the limit's", () => {
    const cases: [string, CostStack, string, string[]][] = [
      ["under", estimated(10), "pass", []],
      ["at the maximum", estimated(100), "warn", ["cost-near-limit"]],
      ["from warnAt on", estimated(80), "warn", ["cost-near-limit"]],
      ["over", estimated(100.01), "deny", ["cost-over-limit"]],
      ["no estimate", stack(), "deny", ["cost-unavailable"]],
      ["another currency", estimated(1, "EUR"), "deny", ["cost-currency-mismatch"]],
    ];
    for (const [what, s, verdict, rules] of cases) {
      const view = costViewOf(s, [limit()]);
      expect([what, view?.verdict, view?.rules]).toEqual([what, verdict, rules]);
      expect(view?.limit).toEqual(limit());
    }
  });

  test("a limit with more fields than the four (a database row) shows only the four", () => {
    const row = { ...limit(), id: "9f2c", organizationId: "o1", createdAt: NOW } as CostLimit;
    expect(costViewOf(estimated(1), [row])?.limit).toEqual(limit());
  });

  test("the limit shown is the one that judges: the strictest of the stack's tags, else the organization's", () => {
    const limits = [
      limit({ maxMonthlyDelta: 1000, warnAt: null }),
      limit({ tag: "prod", maxMonthlyDelta: 50, warnAt: null }),
      limit({ tag: "core", maxMonthlyDelta: 20, warnAt: null }),
    ];
    expect(costViewOf(estimated(30, "USD", { tags: ["prod", "core"] }), limits)).toMatchObject({
      limit: { tag: "core", maxMonthlyDelta: 20 },
      verdict: "deny",
    });
    expect(costViewOf(estimated(30, "USD", { tags: ["prod"] }), limits)?.limit?.tag).toBe("prod");
    expect(costViewOf(estimated(30, "USD", { tags: ["other"] }), limits)).toMatchObject({
      limit: { tag: null, maxMonthlyDelta: 1000 },
      verdict: "pass",
    });
  });
});
