# 14 secret-rotation - done 2026-10-19

## What was built
- **ROT-1..5** The rotator contract with a fake and a `random` provider; `variable_rotations` (migrations 0037, 0038); a rotation writes a new variable version (history, audit, auto-sync as for any edit); the `rotation.tick` worker job (claim, backoff, `failing` after three failures, `rotation.failing` notification); API, authz, audit and OpenAPI.
- **ROT-6** The `gitlab-token` provider: GitLab's own token rotation, which ends the old token in the same call.
- **ROT-7, ROT-8** `orch rotation` and a rotation panel in the variables page. There is no setup form and no `orch rotation list`; setting one up is by CLI or API.
- **ROT-9** [ADR-0014](../../docs/adr/0014-dynamic-secrets.md): the control plane may hold a GitLab connection token to mint secrets; providers are `random` and `gitlab-token` only; no new long-lived admin credential. Taken on standing authorization.
- **ROT-10, ROT-11** Leases: a read-only project token for a person or a protected-ref CI job, returned once, kept nowhere, ended on request or by the `lease.sweep` job (migration 0039). `orch lease issue|list|revoke`.
- **Reviews** `/security-review` and `/code-review` ran once over the whole feature, not per task. Security: 2 findings, fixed. Code review: 12 findings, 10 fixed, 2 accepted (details in LOG.md).

## Results
`bun run check` green after the review fixes: typecheck (root and web), Biome (one old info in `limits.test.ts`), 4538 pass + 2 skip + 0 fail; web 255 pass. New dependencies: none. Migrations 0037-0039 are additive.

## Auth-model changes (taken on standing authorization, reported)
- An external provider's rotation config (a numeric GitLab id can mean any project) needs `connection.read`, an org admin's, not a maintainer's.
- Changing or clearing a project's `gitlabProjectId` needs `project.create`, an org admin's. Relinking does not revoke live leases.
- A protected-ref CI job with no environment and with a job id now carries `lease.issue` and `lease.revoke` and a developer role (the scopes still hold it to leases and its two reads). A job tied to an environment, on an unprotected ref, or without a job id gets none.
- A CI principal of another project gets a 404, not a 403 (as the guard does everywhere).

## Invariants
No value in rows, audit, logs or lists (leak canaries on the rotation, tick, lease and route tests). GitLab only through `packages/gitlab`. The control plane holds a connection token, not a cloud credential (ADR-0014). Every route has a guard and every mutation an audit action. Migrations additive. Tests use the GitLab mock only.

## Limits found (in `docs/rotation.md` and LOG.md)
- A lost answer from `gitlab-token` leaves the old token ended; the new token is now kept and the next attempt rotates it. The mock assumes GitLab answers 400 for a revoked token.
- `pending_approval` lingers until the next cycle; org-level variables have no project to tell, so a failing rotation reaches them by audit and forwarding only; the rotation config is write-only.
- A counted failure can lose its alert (the count and backoff are written first; the alert is a second step and is not sent later).
- A credential that cannot be revoked is retried on every tick until a person removes it.
- "Rotate now" can take over a claim a worker holds (F2) and two claims in one millisecond share a fence value (F11): a real fix is a claim-token column.
- Leases: the cap of 20 counts across organizations; a project's delete cascades away live lease rows (tokens end by their own expiry); a crash between GitLab's answer and the handle leaves a token nothing can revoke, ending at its native expiry, a day after the lease at most; `409 lease_unrevocable` for a row without a handle; exactly one GitLab connection per organization (`connection_ambiguous`, `no_gitlab_connection`); any developer can end any lease of the project, a CI job only its own; CI jobs cannot list leases; `listConnections` looks at the first 100 (shortcut, commented). The handle is kept in the open (a token id, not a credential), a deviation from "sealed" noted in LOG.md.
- The mock GitLab treats `expires_at` as valid through the whole date, a day longer than real GitLab.

## Not verified / human gates
- **No real GitLab.** `gitlab-token` rotation and leases were never run against a real instance: the access-token endpoints and their expiry-date and revoked-token behaviour follow GitLab's documentation and the mock. The first real rotation and the first real lease are human gates.
- No web form to set up a rotation or take a lease.
