import type { PolicyReport } from "./policy";

/** What an organization does about open secret findings on a project's default branch (SCAN-6). */
export const SECRET_GATES = ["off", "warn", "deny"] as const;
export type SecretGate = (typeof SECRET_GATES)[number];

export const SECRET_FINDINGS_RULE = "secret-findings-open";

/**
 * The gate's part of a verdict. `off` says nothing whatever the count, `warn` names the rule and `deny` makes
 * it a denial, both only when a finding is open. Dismissed and resolved findings are not counted by the caller.
 */
export function secretGateVerdict(gate: SecretGate, open: number): PolicyReport {
  const hit = open > 0 ? [SECRET_FINDINGS_RULE] : [];
  return {
    evaluated: true,
    denied: gate === "deny" ? hit : [],
    warned: gate === "warn" ? hit : [],
  };
}
