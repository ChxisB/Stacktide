# 16 Cost Gates - Spec
Prefix: COST · Milestone: M5 · Status: todo (planned 2026-10-19, awaiting approval)

## Goal
A plan whose estimated monthly cost change exceeds an organization's limit warns or blocks apply, the same way a policy `deny` does.

## Scope
A cost field in the plan summary; per-organization and per-tag limits; a cost verdict joined to the policy verdict; an estimator step in the generated plan job; MR comment and run page.

## Non-goals
Estimating cost in the control plane, holding pricing-API keys, budgets over time, per-team showback, cloud billing import.

## Design
- **Reference** (Stategraph row: "CODEOWNERS approvals, policy and cost gates"; Spacelift: policy at plan time). Follows the shape POL-3 already established: the evaluation happens **in the runner**, the control plane ingests a small result and decides.
- **Contract first, tool second.** The plan summary (IAC-6, `POST /runs/:id/plan-summary`) gains an optional `cost { monthlyDelta, monthlyTotal, currency }`. Any estimator can fill it; the documented producer is Infracost run on the plan JSON in the runner (its API key is a runner-side CI variable, so invariant 3 holds). I have not read Infracost's docs yet: COST-4 verifies the CLI flags and output shape before the job step is written.
- **Limits:** `maxMonthlyDelta` and `warnAt`, set per organization with an override per stack tag (the same tag attachment POL-3 uses).
- **Verdict:** a pure `costVerdict(limit, cost)` returning `pass|warn|deny`, combined with the policy report through `judge()`. `deny` is an apply precondition (IAC-8) with no new gate.
- **Fail closed, but only when asked:** a limit is set and no estimate arrived -> `deny` with rule `cost-unavailable`. No limit set -> cost is informational and never blocks.
- Money handling: amounts are finite numbers validated on ingest (sign allowed for savings), currency is a 3-letter code; no cross-currency maths.

## Acceptance
Fixture plans with a small, a warn-level, a deny-level and a missing estimate give pass, warn, deny and (with a limit) `cost-unavailable`; deny blocks apply; the MR comment shows delta and limit; with no limit nothing changes for existing stacks.

## Risks / human gates
First real estimate and the first real blocked apply are human gates. Estimates are approximate and usage-based resources are underestimated: the UI must say "estimate" and show the tool name.

## Open questions
1. Infracost as the documented producer - acceptable, or do you prefer another estimator?
2. Should a missing estimate under a set limit deny (plan) or only warn?
