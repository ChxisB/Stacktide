# 05 Sync Engine - Tasks

### SYNC-1 - Adapter contract, fake, conformance suite  `[x]` M - deps: FND-4
Do: `packages/sync` types, an in-memory fake adapter and a reusable conformance suite (`runAdapterConformance(factory)`).
Done when: the fake passes the suite; the suite covers create/update/delete/idempotency/not-found/scope isolation.

### SYNC-2 - Diff and plan engine  `[x]` M - deps: SYNC-1
Do: pure `plan(desired, actual, policy)` with unmanaged-key policy, deterministic ordering, value comparison via equality or last-applied HMAC when `canReadValues` is false.
Done when: table + property tests cover each action, each policy, hidden-value targets, and that the plan type has no value fields.

### SYNC-3 - GitLab variables adapter  `[ ]` M - deps: SYNC-1, GL-4
Do: Adapter for project and group variables with `environment_scope`, `masked`, `protected`, `raw`, `variable_type`; fail-the-plan on unmaskable secrets.
Done when: passes the conformance suite against the mock; masking-failure and scope-collision cases have tests.

### SYNC-4 - Targets schema and API  `[ ]` M - deps: SYNC-1, VAR-4, GL-6, AUTH-3
Do: `sync_targets(project_id, type, connection_id, config, environment_mapping, unmanaged_policy, auto_sync)`; CRUD endpoints (audited); config validated by the adapter.
Done when: endpoint tests cover validation, authz and audit; credentials are never returned.

### SYNC-5 - Plan endpoint  `[ ]` M - deps: SYNC-2, SYNC-3, SYNC-4
Do: `sync_runs` + `sync_run_items` (keys, scopes, actions, counts only); `POST .../plan` resolves desired state, reads the target, stores a plan with an expiry.
Done when: tests cover empty plan, mixed plan, unmaskable-secret failure and a leak test over stored plan rows.

### SYNC-6 - Apply endpoint and job  `[ ]` M - deps: SYNC-5, API-6
Do: `POST .../apply {planId}` runs as a job with a per-target mutex, stale-plan rejection (desired state changed), per-item results, retry/backoff. **First real apply is a human gate.**
Done when: tests cover stale plan, concurrent apply (second rejects), partial failure then idempotent re-apply, and the second plan after apply is empty.

### SYNC-7 - Auto-sync on change  `[ ]` M - deps: SYNC-6, VAR-4
Do: A variable change enqueues a coalesced (debounced) sync job for targets with `auto_sync`; protected environments stay manual until GOV-3.
Done when: 10 rapid changes produce one run; manual-only targets are untouched.

### SYNC-8 - Drift detection  `[ ]` M - deps: SYNC-6, API-7
Do: Scheduled read-only plan per target; non-empty plan marks the target `drifted` with counts; optional auto-remediate (default off).
Done when: a mutation made directly on the mock is detected on the next tick; no writes happen with auto-remediate off.
