# 10 drift-and-policy: 4 of 4 built, nothing has run against a real GitLab, pipeline or policy engine (2026-10-18)

Written for: the maintainer who will review the REVIEW-tagged design decisions and run the first real drift check, policy evaluation and notification.

POL-1..4 `[x]`. Gate: `bun run check` green, 3283 pass + 1 skip (the opt-in real-GitLab run) + 0 fail (root), 240 pass + 0 fail (web). One local commit per task, nothing pushed. The feature is `done` in the ROADMAP for the code.

| Task | Commit | What |
|---|---|---|
| POL-1 | ed2bcd8 | Scheduled drift runs: `drift_every` in `stack.yml`, a worker tick, a plan-only `kind=drift` run on the default branch, a finding per stack (`stack_drift`, an episode as two audit events) |
| POL-2 | 4ede64d | Notification sinks: webhook (signed) and Slack, addresses sealed, per-project subscriptions, delivery by queue with retries; `stack.drift` is the first event |
| POL-3 | 1e5f923 | Policy sets: conftest in the plan's summary job, rule names only come back, `deny`/`pending` stop apply |
| POL-4 | 3d4a0a4 | Built-in guardrails: production secrets and variables need a protected target; plan errors with the rule id, in sync plans and in the pipeline check |

Migrations `0026` (stack drift, run kind), `0027` (notification sinks), `0028` (policy sets, verdict columns): all additive. New routes: sinks (3), subscriptions (3), policy sets (3), policy verdict (1); route guard 104, OpenAPI operations 102. New dependencies: none.

Details, mutation results (security-critical behaviour mutated; survivors listed per task) and review outcomes are in `10-drift-and-policy/LOG.md`.

## Not done: human gates

- **No part of this feature ran against a real GitLab, a real pipeline, a real conftest, Slack or a webhook receiver.** Everything was tested against the mock, fakes and recorded fixtures. Run one drift check, one policy evaluation (with a real conftest image) and one notification delivery in a sandbox before relying on any of it.
- The evaluator image (`ORCH_POLICY_IMAGE`: `orch`, `curl`, `jq`, `tar`, `conftest`) is not built or published here.
- **The key-rewrap job (master key rotation) is still unbuilt** for connections, variable keys and notification sinks.

## Decisions to review (REVIEW-tagged in the LOG; the complete lists are there)

- **Drift (POL-1, 15 items):** the connection is found by trial (two GitLab instances in one organization with the same numeric project id can land on the wrong one); stale state is never cleared when a stack leaves the schedule; a commit between scan and pipeline is recorded under the older sha; an orphan pipeline is possible; the default branch needs the parent snippet; drift is a normal plan, not `-refresh-only`; **the `stacks` table is not filled in production** (`syncStacks` has no caller outside tests), so `POST /runs` answers 422 `unknown_stack` for a real project (MR planning is unaffected; also added to the feature 09 doc).
- **Sinks (POL-2, 9 items):** DNS rebinding is still open; the host is visible to project reporters; deliveries are unordered; no test-send, rotation, delivery log, UI or sink cap; the key-rewrap job.
- **Policy (POL-3, 11 items):** the tag opt-out (a merge request can drop the tag from its own `stack.yml`); sets are read at apply time, not recorded at plan time; org admins only, no separation of duty, and the verdict reuses the `run.summary` scope; **policies are code with access to the plan and the job's environment** (`http.send` and `opa.runtime()` are not disabled); the policy project must allow the job token; the conftest JSON shape was never run against a real conftest; drift runs are not judged; no `ORCH_POLICY_IMAGE` means tagged stacks are not planned.
- **Guardrails (POL-4, 10 items):** instance-wide env settings (no per-organization config, UI or audit); a violating target's drift check logs and keeps its last status; "production" is a name (`production`, `prod`); **existing unprotected production targets now fail plan, auto-sync and drift until `protected: true`**; **a bare `*` scope is not production, so a secret there on an unprotected target is not refused**; a stored plan is not re-checked at apply; `protected` is only settable through the API; one target type; the pipeline rule cannot tell a secret from a variable and refuses; the entry-point wiring (`worker-main.ts`, `index.ts`) is not tested.

## Findings that matter beyond this feature

- **`toMatchObject` ignores `Date` values in Bun 1.4.2** (`{a: new Date(1)}` matches `{a: new Date(2)}`). Earlier tests that put a `Date` in a `toMatchObject` compare nothing for that field; worth a grep.
- **Review found a ReDoS in POL-4's first matcher** (a GitLab scope turned into a RegExp: a pattern of many stars backtracks for ever). It is data a project writer sets. Replaced by a linear matcher with a test; other places that turn user patterns into regexes (`watch` globs in the scanner) were not re-audited here.
- Default-on guardrails changed seven existing test fixtures (they synced to `production` from unprotected targets): the targets now say `protected: true`, one digest test flips it to `false`. Nothing was weakened, skipped or deleted.
- A web test file (`projects.test.tsx`) had its 15 s limits raised to remove a flake unrelated to this feature (earlier in the run).

## Remaining risks and open follow-ups

- Mutation survivors left on purpose: the two entry-point wirings above.
- No UI for drift status, sinks, policy sets or the guardrail settings; no route reads drift status yet (POL-1 REVIEW 7).
- GOV-4 (feature 11) is expected to reuse the notification sink.
