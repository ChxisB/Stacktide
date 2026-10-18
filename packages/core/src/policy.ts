/** What the policy sets that apply to a stack's plan said of it (POL-3). */
export const POLICY_VERDICTS = ["pass", "warn", "deny"] as const;
export type PolicyVerdict = (typeof POLICY_VERDICTS)[number];

/** A rule is named by what the evaluator calls it (`data.main.deny_public_bucket`), never by what it said. */
export const POLICY_RULE = /^[A-Za-z0-9_.:-]{1,200}$/;
/** The rule a `deny` names when the evaluator itself failed: it never ran, or its answer was unreadable. */
export const EVALUATOR_FAILED = "evaluator-failed";

export interface PolicyReport {
  /** False when the evaluator did not produce a result. */
  evaluated: boolean;
  denied: readonly string[];
  warned: readonly string[];
}

/**
 * The verdict of a report. Fails closed: an evaluation that did not happen is a `deny`, so a crash
 * of the evaluator, a policy that does not load or an answer that cannot be read never lets a plan through.
 */
export function judge(report: PolicyReport): {
  verdict: PolicyVerdict;
  denied: string[];
  warned: string[];
} {
  if (!report.evaluated) return { verdict: "deny", denied: [EVALUATOR_FAILED], warned: [] };
  const denied = [...new Set(report.denied)];
  const warned = [...new Set(report.warned)];
  return {
    verdict: denied.length > 0 ? "deny" : warned.length > 0 ? "warn" : "pass",
    denied,
    warned,
  };
}
