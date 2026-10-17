# 05 Sync Engine - Spec
Prefix: SYNC · Milestone: M1 · Status: todo

## Goal
Safely push the resolved variables for an environment to external targets with Terraform-style plan/apply, and detect when targets drift.

## Scope
Adapter contract + conformance suite; diff/plan engine; GitLab CI variables adapter; target config API; plan/apply jobs; auto-sync on change; drift detection.

## Non-goals
Other targets (EXT), approvals on protected environments (GOV-4), rotation.

## Design
- Contract: `SyncAdapter { type; validate(config); read(scope): RemoteItem[]; create/update/delete(item); capabilities { canReadValues, supportsMasking, supportsScopes } }`. Every adapter must pass the shared conformance suite.
- Plan = list of `{ key, scope, action: create|update|delete|noop, changed: [...] }`. **Plans never contain values.** Value comparison happens in memory; when a target cannot return values (hidden variables) compare against the stored last-applied HMAC.
- Unmanaged remote keys: policy `ignore` (default) | `adopt` | `prune`. `prune` is explicit per target and a human gate in UI/CLI.
- GitLab mapping: variables with no environment override -> `*` scope; environment-specific overrides -> that environment's `environment_scope` (GitLab falls back to `*`). A value that cannot satisfy GitLab's masking rules while marked secret **fails the plan** with a clear error - it is never silently unmasked.
- `apply` applies a stored plan id only. It is rejected as stale if desired state changed since the plan (re-plan). One run per target at a time (per-target mutex).
- Partial failure: record per-item results, retry with backoff, re-apply is idempotent. Status shows last successful sync.

## Acceptance
Plan shows the exact create/update/delete set against a project's GitLab variables (mock), apply converges it, a second plan is empty, a manual change in GitLab shows up as drift, and no value appears in plans, runs, logs or audit.

## Risks / human gates
First apply to a real GitLab project; any `prune` semantics change.
