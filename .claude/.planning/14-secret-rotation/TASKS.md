# 14 Secret Rotation and Short-lived Secrets - Tasks

### ROT-1 - Rotator contract, fake and `random` provider  `[x]` M - deps: FND-4
Do: `Rotator` interface (`validate`, `rotate`), a fake that records mint/revoke calls, `runRotatorConformance`, and the `random` provider (length and alphabet settings, bytes from `crypto.getRandomValues`).
Done when: the conformance suite passes for the fake and `random`; value length/alphabet tests; no error message contains a generated value.

### ROT-2 - Rotation schema and repository  `[x]` M - deps: ROT-1, VAR-2
Do: additive migration `variable_rotations` (one per variable; provider, non-secret config, `interval_days` 1-365, `grace_days`, `next_at`, `last_status`, `last_error` code, `attempts`); composite FK keeps it in the variable's organization; `claimDue(now, limit)` with `FOR UPDATE SKIP LOCKED` and a compare-and-swap on `next_at`.
Done when: db tests - two concurrent claims never return the same row; a rotation cannot point at another organization's variable; deleting the variable deletes the rotation.

### ROT-3 - Rotation writes a new variable version  `[x]` M - deps: ROT-2, VAR-5, GOV-2
Do: `rotateVariable()`: provider mints -> write a new version through the variables repo -> audit `variable.rotate` (ids only) -> revoke the old credential after `grace_days`. Protected environment: open a change request instead; old value stays live. If the write fails, revoke the new credential. **`/security-review`.**
Done when: unprotected -> new version live and history shows the rotation; protected -> change request opened, live value unchanged; a failing write revokes the minted credential (fake records it); canary test: the value is absent from audit rows, logs and errors.

### ROT-4 - Scheduler and worker handler  `[x]` M - deps: ROT-3, POL-2, API-7
Do: a schedule tick enqueues due rotations; the handler rotates; on failure keep the old value, back off (exponential, capped), after N failures mark `failing` and notify the sinks (no values in the message). Auto-sync fires from the new version.
Done when: with a fake clock - one rotation with two workers; failure keeps the old value, backs off and notifies after N; a rotated value reaches a fake sync target via SYNC-7.

### ROT-5 - Rotation API, authz, audit, OpenAPI  `[x]` M - deps: ROT-3
Do: `PUT|GET|DELETE /projects/:p/variables/:id/rotation`, `POST .../rotate` (now); project-maintainer guard; every mutation audited; rate-limited; `docs/rotation.md`; OpenAPI regenerated.
Done when: guard-coverage test passes; leak canary (provider config and generated values never in responses, list, audit or logs); `spec.test.ts` green.

### ROT-6 - GitLab access-token provider  `[x]` M - deps: ROT-1, GL-5
Do: first verify in GitLab's docs whether rotating a project access token keeps the old one valid (record the answer in LOG); add `rotateProjectAccessToken` to `packages/gitlab` with mock + contract coverage; provider config holds token id and expiry only. **`/security-review`.**
Done when: contract suite passes against the mock; the new token exists only as a variable version; the provider's grace behaviour matches the verified answer.

### ROT-7 - CLI `orch rotation`  `[x]` S - deps: ROT-5, CLI-6
Do: `set|show|run|rm` subcommands over the api-client.
Done when: command tests for each subcommand and output formats; no value printed by `run`.

### ROT-8 - Rotation panel in the variables UI  `[x]` M - deps: ROT-5, UI-3
Do: per-variable rotation status (provider, next run, last result), enable/disable, "rotate now" with a confirmation.
Done when: component tests for each state (never rotated, ok, failing, protected-pending); the journey test still passes.

### ROT-9 - ADR: holding credentials to mint secrets  `[x]` S - deps: ROT-1
Do: write `docs/adr/0014-dynamic-secrets.md`: which dynamic providers (Postgres role, AWS IAM key) are allowed, the invariant-3 exception, the runner-side alternative, lease TTL limits. **Human gate.**
Done when: you accept or amend the ADR; ROT-10/ROT-11 scope follows it.

### ROT-10 - Leases: issue, revoke, expire  `[x]` M - deps: ROT-6, ROT-9
Do: additive migration `secret_leases` (principal, provider, `expires_at`, `revoked_at`, sealed revoke handle; max TTL cap); issue returns the value once; sweeper job revokes expired leases; provider-native expiry where it exists. **`/security-review`.**
Done when: lease against the GitLab mock is revoked at expiry and on request; value never stored or returned twice; sweeper is idempotent and survives a provider error.

### ROT-11 - Lease API, CI exchange, CLI  `[x]` M - deps: ROT-10, AUTH-6, CLI-5
Do: `POST|DELETE|GET` lease routes (list shows no values); CI principals need a `lease.issue` scope; `orch lease` prints the value to stdout only; docs.
Done when: authz and rate-limit tests; leak canary; a CI principal for another project is 403.
