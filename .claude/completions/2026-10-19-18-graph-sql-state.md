# 18 graph-sql-state - done 2026-10-19

## What was built
- **STATE-1** ADR-0017: Terraform state is kept by the platform, sealed in Postgres. Changes D9 (accepted on the standing authorization; reverse it in the ADR).
- **STATE-2** `state_versions` (migration 0046, additive): each version sealed with its own DEK, bound to org/project/stack/serial/id; the newest 20 are kept; 16 MiB cap.
- **STATE-3** The Terraform HTTP backend: `GET/POST/DELETE .../state/:stack`, called by CI jobs only, with a separate `state: true` token (≤ 1 h, tied to no environment). Basic credentials are accepted on state paths only, and only for CI tokens.
- **STATE-4** Locks (`state_locks`, migration 0047): `LOCK`/`UNLOCK`, owned by the job and ended with its token; `POST .../force-unlock` for an org admin. A write needs the lock id when a lock is held.
- **STATE-5** `state: orch` in `stack.yml`: the generator exports `TF_HTTP_*` through the shell; the platform wires the token for the job.
- **STATE-6** The resource index (`state_resources`, migration 0048): identity only, of the newest version; `GET .../state/:stack/resources` with exact filters and a cursor.
- **STATE-7** `POST .../state/:stack/import`: a one-time snapshot copy of what GitLab holds (maintainer; never touches GitLab's copy, never switches the stack).
- **STATE-8** Backup and restore: `backup.test.ts` covers state, `docs/runbook-keys-and-backup.md` updated; master-key re-wrap covers state DEKs.
- **STATE-9** `docs/state-resource-locks.md`: the recommendation on a resource-level lock (dropped; the user accepts or reverses it).
- **STATE-10** `GET .../state/:stack/versions`, `orch state import|ls|resources`, the **State** page (typed stack name). Org viewers list versions and resource names, never content.
- Docs: `docs/ci.md` (state section), `docs/runbook-keys-and-backup.md`, `docs/adr/0017-*`, `docs/state-resource-locks.md`.

## Results
Final `bun run check` after the review fix: `EXIT 0` on the first run (root 5094 pass / 0 fail / 2 skipped; web 315 pass / 0 fail). The STATE-10 gate before it had ended `EXIT 1` on the known web load flake (web 314 pass / 1 fail, green on rerun). New dependencies: none. Migrations: 0046, 0047, 0048 (additive).

## Invariants
No plaintext secrets: state content is sealed per version, only CI jobs read or write it, and nothing returned to a person holds it (names, serials, sizes, who). The audit never holds `Who` or content. The control plane still holds no cloud credentials. GitLab traffic (the import) goes through `packages/gitlab`; tests use the mock. Every state route declares a guard or `signedIn`; mutations are audited; migrations are forward-only.

## Auth-model decisions (taken on the standing authorization; say so in the report)
- `state.list`/`state.read` project reporter (org viewer); `state.write` developer, granted to CI tokens by scope, only on a protected ref with a job id; `state.import` maintainer; `state.force_unlock` org admin.
- Only CI jobs read or write state content; a person gets 403 on the content routes.
- The `state: true` token is separate and tied to no environment.
- A lock ends with the job's token (≤ 1 h); a cancelled job keeps the stack locked until then or a force-unlock. `terraform force-unlock` from a job does not work (UNLOCK with no lock info is 422); the admin API is the way.
- Wrong project is 404; wrong stack is 403 `unknown_stack`.
- A project with state cannot be deleted (409 `project_has_state`); a lock alone cascades.

## Deviations
- STATE-10 asked for a stack page tab; there is no stack page, so **State** is a page of its own with a typed stack name.
- The routes are keyed by stack name (`.../state/:stack/...`), not `/stacks/:id/state/...`.
- No Content-MD5, no rate limit on the state routes, no `terraform force-unlock` support (STATE-3/4/7 logs).

## Not verified / human gates
- **Nothing ran against a real GitLab, a real Terraform client or a real runner.** The HTTP backend protocol facts (LOCK/UNLOCK verbs, 423 body, Basic auth) are from the documentation, not a client. The GitLab terraform-state endpoint, the token and the Maintainer requirement for the import are assumed from the mock.
- **Human gates:** the D9 change (ADR-0017), the first real state write and the first real import, and the key handling for sealed state (back up the master key; losing it loses every state).
- No Playwright run of the State page. A restored state is the state of the dump; a plan afterwards may want to recreate resources (reasoning, not tested).
- Tests seen red first, except where each task's LOG says otherwise; mutation tallies are in the task entries (STATE-2 10, STATE-3 23 + 3 equivalent, STATE-4 25, STATE-5 28, STATE-6 13, STATE-7 25, STATE-8 5 + 1, STATE-10 API 6 + 1, CLI 11, web 19 + 1).
- `/code-review` and `/security-review` ran once for the whole feature, not per task (results below).

## Review results (once for the whole feature, not per task)
- **`/security-review`:** no vulnerability at confidence 8 or above. Below the bar: any branch's pipeline job can read the whole state (GitLab Developer-read parity, documented; open decision whether to narrow it to protected refs); a protected-ref lock can be held up to 1 h (force-unlock exists); org viewers see resource names and versions, never content; a `for_each` key can carry a secret.
- **`/code-review`:** fixed a NUL (`\u0000`) in a lineage, a resource name, an index key, lock info or a resource filter that was a 500 from Postgres and is now a 422 (test first, 12 mutations caught). Declined on purpose: the newest-ciphertext select on every write, the stack-name regex in three places, the web resources request when versions are empty, the unpaged versions list, an audit row per state read.
