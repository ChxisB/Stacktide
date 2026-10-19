import { describe, expect, test } from "bun:test";
import { type CostLimit, type CostResult, costVerdict, limitFor, planVerdict } from "./cost";
import type { PolicyReport, PolicyVerdict } from "./policy";

const limit = (tag: string | null, maxMonthlyDelta: number, over: Partial<CostLimit> = {}) => ({
  tag,
  maxMonthlyDelta,
  warnAt: null,
  currency: "USD",
  ...over,
});

describe("the limit that applies to a stack", () => {
  test("none when the organization has none", () => {
    expect(limitFor([], ["prod"])).toBeUndefined();
    expect(limitFor([], [])).toBeUndefined();
  });

  test("the organization's own limit reaches every stack, tagged or not", () => {
    const all = limit(null, 500);
    expect(limitFor([all], [])).toBe(all);
    expect(limitFor([all], ["prod", "eu"])).toBe(all);
  });

  test("a limit for a tag the stack carries is more specific than the organization's, even when it is the looser one", () => {
    const all = limit(null, 100);
    const prod = limit("prod", 5000);
    expect(limitFor([all, prod], ["prod"])).toBe(prod);
    expect(limitFor([prod, all], ["eu", "prod"])).toBe(prod);
  });

  test("a limit for a tag the stack does not carry does not apply, and with no organization limit nothing does", () => {
    const all = limit(null, 100);
    const prod = limit("prod", 5000);
    expect(limitFor([all, prod], ["dev"])).toBe(all);
    expect(limitFor([all, prod], [])).toBe(all);
    expect(limitFor([prod], ["dev"])).toBeUndefined();
    expect(limitFor([prod], [])).toBeUndefined();
  });

  test("ties are broken by code unit, not by the locale of whoever runs it", () => {
    // ICU collation puts "_" before "-"; by code unit "-" (0x2d) is first, on every host
    const [dash, under] = [limit("a-b", 300), limit("a_b", 300)];
    expect(limitFor([under, dash], ["a_b", "a-b"])).toBe(dash);
    expect(limitFor([dash, under], ["a-b", "a_b"])).toBe(dash);
  });

  test("when several of the stack's tags have limits the strictest wins, then the tag that sorts first", () => {
    const [eu, prod, pci] = [limit("eu", 900), limit("prod", 300), limit("pci", 300)];
    expect(limitFor([eu, prod], ["eu", "prod"])).toBe(prod);
    expect(limitFor([prod, eu], ["prod", "eu"])).toBe(prod);
    expect(limitFor([prod, pci], ["prod", "pci"])).toBe(pci);
    expect(limitFor([pci, prod], ["prod", "pci"])).toBe(pci);
  });

  test("a stack that repeats a tag is not counted twice, and the arguments are left as they were", () => {
    const prod = limit("prod", 1);
    const limits = [limit(null, 2), prod];
    const tags = ["prod", "prod"];
    expect(limitFor(limits, tags)).toBe(prod);
    expect(tags).toEqual(["prod", "prod"]);
    expect(limits).toHaveLength(2);
  });
});

const est = (monthlyDelta: number, over: Partial<CostResult> = {}): CostResult => ({
  monthlyDelta,
  monthlyTotal: 1000,
  currency: "USD",
  tool: "infracost",
  ...over,
});

describe("what a limit says of an estimate", () => {
  // delta 500 is "may add up to 500": at the maximum is allowed, above it is not; at the warning is warned
  const cells: [string, CostLimit | undefined, CostResult | null, string[], string[]][] = [
    ["no limit, no estimate: nothing to judge", undefined, null, [], []],
    ["no limit, any estimate: informational only", undefined, est(1e9), [], []],
    ["a limit and no estimate: unavailable", limit(null, 500), null, ["cost-unavailable"], []],
    ["well under", limit(null, 500, { warnAt: 300 }), est(10), [], []],
    ["savings", limit(null, 0), est(-250), [], []],
    ["under with no warning set", limit(null, 500), est(499.99), [], []],
    ["just under the warning", limit(null, 500, { warnAt: 300 }), est(299.99), [], []],
    ["at the warning", limit(null, 500, { warnAt: 300 }), est(300), [], ["cost-near-limit"]],
    [
      "between the warning and the maximum",
      limit(null, 500, { warnAt: 300 }),
      est(450),
      [],
      ["cost-near-limit"],
    ],
    [
      "at the maximum: allowed, and warned when a warning is set",
      limit(null, 500, { warnAt: 300 }),
      est(500),
      [],
      ["cost-near-limit"],
    ],
    ["at the maximum with no warning set", limit(null, 500), est(500), [], []],
    ["over the maximum", limit(null, 500, { warnAt: 300 }), est(500.01), ["cost-over-limit"], []],
    ["a limit of zero allows no increase", limit(null, 0), est(0.01), ["cost-over-limit"], []],
    [
      "another currency is denied and never converted",
      limit(null, 500),
      est(1, { currency: "EUR" }),
      ["cost-currency-mismatch"],
      [],
    ],
    [
      "another currency over the number is still one rule",
      limit(null, 500),
      est(9999, { currency: "EUR" }),
      ["cost-currency-mismatch"],
      [],
    ],
    [
      "an estimate that is not a number is unavailable",
      limit(null, 500),
      est(Number.NaN),
      ["cost-unavailable"],
      [],
    ],
    [
      "an infinite estimate is unavailable",
      limit(null, 500),
      est(Number.POSITIVE_INFINITY),
      ["cost-unavailable"],
      [],
    ],
  ];
  for (const [what, l, cost, denied, warned] of cells) {
    test(what, () => {
      expect(costVerdict(l, cost)).toEqual({ evaluated: true, denied, warned });
    });
  }
});

describe("the verdict of a plan: the policy report and the cost together", () => {
  const ok: PolicyReport = { evaluated: true, denied: [], warned: [] };
  const warn: PolicyReport = { evaluated: true, denied: [], warned: ["data.main.warn_tags"] };
  const deny: PolicyReport = { evaluated: true, denied: ["data.main.deny_public"], warned: [] };
  const crashed: PolicyReport = { evaluated: false, denied: [], warned: [] };
  const lim = limit(null, 500, { warnAt: 300 });
  // limit x estimate x policy report: [policy, limit, estimate] -> [verdict, denied, warned]
  const table: [
    string,
    PolicyReport | null,
    CostLimit | undefined,
    CostResult | null,
    PolicyVerdict,
    string[],
    string[],
  ][] = [
    ["no policy, no limit", null, undefined, null, "pass", [], []],
    ["policy passes, no limit", ok, undefined, est(1e9), "pass", [], []],
    ["policy passes, cost passes", ok, lim, est(10), "pass", [], []],
    ["policy passes, cost warns", ok, lim, est(400), "warn", [], ["cost-near-limit"]],
    ["policy passes, cost denies", ok, lim, est(900), "deny", ["cost-over-limit"], []],
    ["policy passes, estimate missing", ok, lim, null, "deny", ["cost-unavailable"], []],
    ["policy warns, cost passes", warn, lim, est(10), "warn", [], ["data.main.warn_tags"]],
    [
      "both warn: both are named",
      warn,
      lim,
      est(400),
      "warn",
      [],
      ["data.main.warn_tags", "cost-near-limit"],
    ],
    [
      "policy warns, cost denies",
      warn,
      lim,
      est(900),
      "deny",
      ["cost-over-limit"],
      ["data.main.warn_tags"],
    ],
    ["policy denies, cost passes", deny, lim, est(10), "deny", ["data.main.deny_public"], []],
    [
      "both deny: both are named",
      deny,
      lim,
      est(900),
      "deny",
      ["data.main.deny_public", "cost-over-limit"],
      [],
    ],
    ["policy denies, no limit", deny, undefined, null, "deny", ["data.main.deny_public"], []],
    [
      "a policy evaluator that crashed denies, and cost still speaks",
      crashed,
      lim,
      est(900),
      "deny",
      ["evaluator-failed", "cost-over-limit"],
      [],
    ],
    [
      "a crashed evaluator with nothing else",
      crashed,
      undefined,
      null,
      "deny",
      ["evaluator-failed"],
      [],
    ],
    [
      "no policy applies, the estimator crashed under a limit",
      null,
      lim,
      null,
      "deny",
      ["cost-unavailable"],
      [],
    ],
    [
      "a currency mismatch beside a policy warning",
      warn,
      lim,
      est(1, { currency: "EUR" }),
      "deny",
      ["cost-currency-mismatch"],
      ["data.main.warn_tags"],
    ],
  ];
  for (const [what, policy, l, cost, verdict, denied, warned] of table) {
    test(what, () => {
      expect(planVerdict(policy, l, cost)).toEqual({ verdict, denied, warned });
    });
  }

  test("a rule both name is said once", () => {
    const twice: PolicyReport = { evaluated: true, denied: ["cost-over-limit"], warned: [] };
    expect(planVerdict(twice, lim, est(900)).denied).toEqual(["cost-over-limit"]);
  });
});
