import { type CostLimit, type CostResult, costVerdict, judge, limitFor } from "@orch/core";
import { planCostOf, type RunStack } from "@orch/db";

/** The part of a run's stack that the cost depends on. */
export type CostStack = Pick<
  RunStack,
  "tags" | "summarizedAt" | "costMonthlyDelta" | "costMonthlyTotal" | "costCurrency" | "costTool"
>;

export interface CostView {
  /** What the estimator said; null when it said nothing usable. An estimate, not a bill. */
  estimate: CostResult | null;
  /** The limit that judges the stack (see `limitFor`); null when none reaches it. */
  limit: CostLimit | null;
  verdict: "pass" | "warn" | "deny";
  /** Names of the rules that denied or warned, as the policy's are. */
  rules: string[];
}

/**
 * How a stack's plan stands against the cost limits now (COST-5), judged as the apply judges it
 * (`costVerdict`). Nothing to show, null, for a stack whose plan has not been summarized (its
 * estimator may still run) and for one with neither an estimate nor a limit.
 * shortcut: every stack is judged by the limits as they are now, an applied one too, so a lowered limit
 * makes an old run read "deny"; upgrade by showing no verdict for a stack that cannot be applied again.
 */
export function costViewOf(s: CostStack, limits: readonly CostLimit[]): CostView | null {
  if (s.summarizedAt === null) return null;
  const estimate = planCostOf(s);
  const limit = limitFor(limits, s.tags);
  if (!(estimate || limit)) return null;
  const { verdict, denied, warned } = judge(costVerdict(limit, estimate));
  return {
    estimate,
    // the four fields only: a limit read from the database has an id and an organization too
    limit: limit
      ? {
          tag: limit.tag,
          maxMonthlyDelta: limit.maxMonthlyDelta,
          warnAt: limit.warnAt,
          currency: limit.currency,
        }
      : null,
    verdict,
    rules: [...denied, ...warned],
  };
}
