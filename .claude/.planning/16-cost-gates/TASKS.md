# 16 Cost Gates - Tasks

### COST-1 - Cost field in the plan summary  `[x]` M - deps: IAC-6
Do: optional `cost {monthlyDelta, monthlyTotal, currency, tool}` on `POST /runs/:id/plan-summary`; additive migration stores it per run stack; validation (finite numbers, 3-letter currency, tool name charset); size cap unchanged.
Done when: tests for valid, NaN/Infinity, bad currency, missing (still accepted), and the 403 for a mismatched ci principal; OpenAPI regenerated.

### COST-2 - Cost limits model and API  `[x]` M - deps: COST-1, POL-3
Do: additive migration `cost_limits` (organization, optional stack tag, `max_monthly_delta`, `warn_at`, currency); org-admin routes, audit on every change; most specific tag wins.
Done when: authz coverage; tests for tag precedence (strictest limit of a stack's tags wins; `limitFor` in core). The currency-different-from-the-estimate deny (`cost-currency-mismatch`, never converted) moved to COST-3: it needs the verdict, which COST-2 does not build.

### COST-3 - Cost verdict joined to policy  `[x]` M - deps: COST-2
Do: pure `costVerdict(limit, cost)`; combine with the policy report through `judge()`; `deny` is an IAC-8 apply precondition; no limit -> informational only; limit and no estimate -> `cost-unavailable` deny.
Done when: table-driven tests for every cell (limit x estimate x policy report); apply refused on deny with the rule names in the answer; a crashed estimator blocks apply.

### COST-4 - Estimator step in the generated plan job  `[x]` M - deps: COST-1, IAC-4
Do: first read Infracost's docs and record the CLI invocation and JSON fields in LOG; when the org has a limit, the plan job runs the estimator on the plan JSON and posts the cost; the image comes from `tool-images`; the key is a runner-side CI variable the platform never reads.
Done when: pipeline-gen snapshot with and without a limit; a job that cannot estimate posts no cost (so COST-3 denies) and does not fail the plan itself.

### COST-5 - MR comment and run page  `[x]` S - deps: COST-3, IAC-7
Do: the MR note and the run page show estimated delta, total, limit and the tool, labelled "estimate".
Done when: note snapshot tests (pass, warn, deny, unavailable); component test for the run page.
Narrowed (2026-10-19): the web app has no IaC run page, so "run page" is the run API response: each stack of `GET /runs` and `GET /runs/:id` carries a `cost` view. The component test is replaced by route tests. A web page for runs is not in this feature.

### COST-6 - Docs and fixtures  `[x]` S - deps: COST-4
Do: `docs/cost-gates.md` (setup, the runner-side key, limits of estimates) and four fixture plans.
Done when: the fixtures run in the COST-3 tests; the doc's commands are the ones the snapshot emits.
