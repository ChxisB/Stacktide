# 05 Sync Engine - Spec
Prefix: SYNC · Milestone: M1 · Status: building

## Goal
Safely push the resolved variables for an environment to external targets with Terraform-style plan/apply, and detect when targets drift.

## Scope
Adapter contract + conformance suite; diff/plan engine; GitLab CI variables adapter; target config API; plan/apply jobs; auto-sync on change; drift detection.

## Non-goals
Other targets (EXT), approvals on protected environments (GOV-4), rotation.

## Design
- Contract (`packages/sync`, SYNC-1): `SyncAdapter<Config> { type; capabilities { canReadValues, supportsMasking, supportsScopes, supportsFiles }; check(item): void; validate(config): Config; connect(config): Remote }`, `Remote { read(): RemoteItem[]; create(item); update(item); delete(ref) }`. An item is `{ key, scope, value, secret, file }` (`value` is `null` when the target hides it; scope `*` when it has none). Errors are `SyncError` with a kind (`not_found`, `exists`, `invalid`, `unsupported`, `unmaskable`, ...) and never carry a value. `check(item)` throws what a write of the item would throw because the target can never hold it (`invalid`, `unsupported`, `unmaskable`) without touching the target: whoever builds a plan calls it for every wanted item before `plan()`, so an unmaskable secret fails the plan, not the apply. Every adapter must pass `runAdapterConformance`.
- Plan (`plan(desired, actual, { unmanaged, lastApplied })`, SYNC-2) = list of `{ key, scope, action: create|update|delete|noop|adopt, changed: ["value"|"secret"] }` ordered by key then scope. **Plans never contain values.** Value comparison happens in memory; when a target hides a value (hidden variables) compare against the stored last-applied HMAC, and update when there is none.
- Unmanaged remote items (nothing wanted in that key and scope): policy `ignore` (default, left out of the plan) | `adopt` (listed as `adopt` so they can be imported; the target is not changed) | `prune` (listed as `delete`). `prune` is explicit per target and a human gate in UI/CLI.
- GitLab mapping: variables with no environment override -> `*` scope; environment-specific overrides -> that environment's `environment_scope` (GitLab falls back to `*`). A value that cannot satisfy GitLab's masking rules while marked secret **fails the plan** with a clear error - it is never silently unmasked.
- `apply` applies a stored plan id only. It is rejected as stale if desired state changed since the plan (re-plan). One run per target at a time (per-target mutex).
- Partial failure: record per-item results, retry with backoff, re-apply is idempotent. Status shows last successful sync.

## Acceptance
Plan shows the exact create/update/delete set against a project's GitLab variables (mock), apply converges it, a second plan is empty, a manual change in GitLab shows up as drift, and no value appears in plans, runs, logs or audit.

## Risks / human gates
First apply to a real GitLab project; any `prune` semantics change.
