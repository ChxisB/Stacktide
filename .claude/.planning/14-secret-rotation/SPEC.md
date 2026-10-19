# 14 Secret Rotation and Short-lived Secrets - Spec
Prefix: ROT · Milestone: M5 · Status: todo (planned 2026-10-19, awaiting approval)

## Goal
A variable can rotate itself on a schedule, and a person or CI job can lease a credential that expires on its own - without a new delivery path and without the platform keeping more credentials than a connection already does.

## Scope
Rotator contract + providers; rotation schedule per variable; rotated value written as a normal variable version; failure handling; API/CLI/UI; leases (short-lived credentials) with expiry and early revoke.

## Non-goals
Rotating the platform's own master keys (done: OPS-4 `rewrap`, and it is *not* this: it re-wraps data keys, it does not change any secret). Database or cloud-IAM providers in v1 (gated by ROT-9). Rotating secrets the platform does not store.

## Design
- **Reference** (Infisical docs, read 2026-10-19): rotation runs on an interval; *dual-phase* providers keep the previous credential valid for one more cycle so consumers can switch; *single-phase* replaces in place and the old one dies at once. Database rotation there alternates between two users the operator creates (Infisical never creates or drops DB users). Dynamic secrets are issued on demand per identity and revoked after use. The lease model (TTL, max TTL, renew) is **not** on the pages I read - ROT-9/ROT-10 define ours.
- **Rotation = a new variable version.** `rotateVariable()` asks the provider for a value, then writes it through the existing variables repository (VAR-2/VAR-5). History, rollback, audit, change requests on protected environments (GOV-2) and auto-sync to targets (SYNC-7) all apply unchanged. No new way to deliver a secret.
- **`Rotator` mirrors `SyncAdapter`**: `validate(config)`, `rotate(ctx) -> { value, revoke? }`, a fake and a conformance suite. A provider's config holds ids and settings, never secrets.
- **Order of effects:** provider mints -> variable version written -> old credential revoked later (grace). If the write fails, the new credential is revoked (compensation). If the provider fails, the old value stays live.
- **Schedule:** reuse the `schedules` + job queue (D5). A due rotation is claimed with `FOR UPDATE SKIP LOCKED` + a compare-and-swap on `next_at`, so two workers never rotate twice.
- **Protected environments:** a rotation goes through the change-request path; the pending value is sealed like any change request, and the old value stays live until a human approves. Rotation does not bypass GOV.
- **Providers v1:** `random` (no external system) and `gitlab-token` (project access token rotate via `packages/gitlab`; uses an existing GitLab connection). Anything that needs new long-lived admin credentials (a Postgres role, an AWS IAM user) waits for the ROT-9 ADR (invariant 3).
- **Leases:** a lease is a credential with `expires_at`, issued to a principal, value returned once and never stored (only a sealed revoke handle). Prefer provider-native expiry (a GitLab token's `expires_at`) so a missed sweep leaves nothing valid. A sweeper job revokes and marks expired leases.

## Acceptance
A project variable with a 30-day `random` rotation rotates when due (fake clock) exactly once with two workers running; the new version reaches a fake sync target; a failing provider leaves the old value live, backs off and notifies; a lease for a GitLab token (against the mock) is revoked at expiry and on request; no generated value appears in any response, audit row, log or list.

## Risks / human gates
- ROT-9 is a human gate (holding credentials to mint secrets). `/security-review` on ROT-3, ROT-6, ROT-10, ROT-11.
- First real rotation / lease against a real GitLab is a human gate.
- Dual-phase needs consumers that re-read: rotating a value that a running service has cached breaks it until it restarts. Document per provider.

## Open questions (answer before ROT-4 / ROT-9)
1. Should a rotation on a protected environment wait for a human, or may an org opt in to auto-approve? (Plan assumes it waits.)
2. Is GitLab's access-token rotate endpoint single-phase (old token dies at once)? ROT-6 verifies this first and sets the provider's grace behaviour from the answer.
3. Which dynamic providers do you need first, if any beyond GitLab tokens?
