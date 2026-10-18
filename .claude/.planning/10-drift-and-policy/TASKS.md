# 10 Drift and Policy - Tasks

### POL-1 - Drift runs  `[x]` M - deps: IAC-6, API-7
Do: scheduled drift runs per stack (configurable cadence); `kind=drift` plan-only pipeline; mark `drifted`/`clean`; episode tracking so one drift = one notification.
Done when: tests with a fake clock cover schedule, clean->drifted->clean transitions and no apply ever being triggered.

### POL-2 - Notification sinks  `[ ]` M - deps: API-6
Do: sink interface; HMAC-signed webhook sink; Slack formatter; per-project subscriptions; retries through the queue.
Done when: tests cover signature verification, retry/backoff, dead-letter and payload leak test.

### POL-3 - Policy-as-code (runner side)  `[ ]` M - deps: IAC-8, IAC-4
Do: policy set repo reference + tag attachment; generated plan job runs the evaluator on plan JSON and posts pass/deny/warn; `deny` becomes an apply precondition; evaluator failure = deny.
Done when: fixtures with allow, warn and deny plans behave as specified, and a crashed evaluator blocks apply.

### POL-4 - Built-in guardrails  `[ ]` S - deps: SYNC-5, PIPE-5
Do: rule set with config toggles run during sync plan and pipeline validation; violations are plan errors with the rule id.
Done when: each rule has a passing and failing case, and disabled rules do nothing.
