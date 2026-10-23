import { judge, type PolicyReport } from "./policy";

/** What an estimator said of a plan (COST-1): per month, in one currency that is never converted. */
export interface CostResult {
  monthlyDelta: number;
  monthlyTotal: number;
  currency: string;
  tool: string;
}

/**
 * What an organization allows a plan to add to its monthly cost (COST-2). `tag` is null for the
 * organization's own limit and a stack tag for an override. A plan is denied when its estimated delta is
 * above `maxMonthlyDelta` and warned about when it reaches `warnAt`; both are in `currency`, which is
 * never converted.
 */
export interface CostLimit {
  tag: string | null;
  maxMonthlyDelta: number;
  warnAt: number | null;
  currency: string;
}

/**
 * The limit that judges a stack: one for a tag the stack carries beats the organization's own (a tag is
 * the more specific); when several of its tags have one the strictest wins, then the tag that sorts
 * first, so the answer does not depend on the order of the list or of the tags.
 * shortcut: limits in different currencies are compared as bare numbers; a plan estimated in another
 * currency than the winner's is denied anyway (COST-3), so only which of two denials names the rule is arbitrary.
 */
export function limitFor<L extends CostLimit>(
  limits: readonly L[],
  tags: readonly string[],
): L | undefined {
  const own = new Set(tags);
  const byTag = limits
    .filter((l) => l.tag !== null && own.has(l.tag))
    // a code-unit order: the same on every host, unlike a locale's
    .sort(
      (a, b) =>
        a.maxMonthlyDelta - b.maxMonthlyDelta ||
        ((a.tag as string) < (b.tag as string)
          ? -1
          : (a.tag as string) > (b.tag as string)
            ? 1
            : 0),
    );
  return byTag[0] ?? limits.find((l) => l.tag === null);
}

/** A DNS zone's plan is record changes, not resources with a price: nothing there to estimate. */
export const isCosted = (tool: string) => tool !== "dnscontrol";

/**
 * The limit that judges a stack of `tool`: none for a stack with no price, else `limitFor`. A stack the
 * scan does not know is judged as before, by the organization's own limit.
 */
export function limitOf<L extends CostLimit>(
  limits: readonly L[],
  stack: { tool: string; tags: readonly string[] } | undefined,
): L | undefined {
  return stack && !isCosted(stack.tool) ? undefined : limitFor(limits, stack?.tags ?? []);
}

/** The rules a cost verdict names; they travel like a policy rule's name, in the same lists. */
export const COST_RULES = {
  over: "cost-over-limit",
  near: "cost-near-limit",
  unavailable: "cost-unavailable",
  currency: "cost-currency-mismatch",
} as const;

/**
 * What a limit says of a plan's estimate, as a policy report so the two are judged the same way. No
 * limit: informational, nothing is denied, even with no estimate. A limit and no usable estimate (the
 * estimator never ran, crashed, or said something that is not a number) denies: a limit nobody can
 * check is no limit. An estimate in another currency than the limit's denies too, and is never
 * converted. A delta at the maximum is allowed; above it is denied; from `warnAt` on it is warned about.
 */
export function costVerdict(limit: CostLimit | undefined, cost: CostResult | null): PolicyReport {
  const report = (denied: string[], warned: string[] = []) => ({ evaluated: true, denied, warned });
  if (!limit) return report([]);
  if (!cost || !Number.isFinite(cost.monthlyDelta)) return report([COST_RULES.unavailable]);
  if (cost.currency !== limit.currency) return report([COST_RULES.currency]);
  if (cost.monthlyDelta > limit.maxMonthlyDelta) return report([COST_RULES.over]);
  if (limit.warnAt !== null && cost.monthlyDelta >= limit.warnAt) {
    return report([], [COST_RULES.near]);
  }
  return report([]);
}

/**
 * The verdict of a plan: what the policy sets said (`null` when none judges the stack) and what the
 * cost limit says, together. A policy evaluator that did not run is judged as `judge` does (a deny
 * naming `evaluator-failed`) and the cost still speaks beside it, so every reason is in the answer.
 */
export function planVerdict(
  policy: PolicyReport | null,
  limit: CostLimit | undefined,
  cost: CostResult | null,
) {
  const p = policy ? judge(policy) : { denied: [], warned: [] };
  const c = costVerdict(limit, cost);
  return judge({
    evaluated: true,
    denied: [...p.denied, ...c.denied],
    warned: [...p.warned, ...c.warned],
  });
}
