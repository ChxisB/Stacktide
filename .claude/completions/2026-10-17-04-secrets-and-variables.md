# 04 secrets-and-variables: done (2026-10-17)

All 7 tasks `[x]`. Gate: `bun run check` green, 1001 pass + 1 skip (the opt-in real-instance GitLab contract run) + 0 fail, 59 files. One local commit per task, nothing pushed.

| Task | Commit | What |
|---|---|---|
| VAR-1 | 861ac6d | `packages/crypto`: AES-256-GCM envelope encryption, per-owner data keys wrapped by a master key, AAD binding, env key provider with ordered master keys, rewrap |
| VAR-2 | 15d5187 | Schema (`variable_keys`, `variables` at three levels, append-only `variable_versions`) and the encrypted repository |
| VAR-3 | c3ab099 | Resolution engine: org -> project -> environment overlay, `${REF}` interpolation, cycles and missing references reported |
| VAR-4 | a199997 | Variables API at all three levels: CRUD, reveal, history, delete, resolved view; audit on every mutation and reveal |
| VAR-5 | 2b67c3d | Rollback of one variable, snapshots (the level as of a time), level restore with a plan |
| VAR-6 | 4dca96c | Import from `.env`, JSON and a GitLab project or environment; dry run default; strict caps |
| VAR-7 | 758f15d | Search (key, plain values) and bulk set/rename/delete with a dry-run-by-default preview |

Details, mutation results and review outcomes per task are in `04-secrets-and-variables/LOG.md`.

## Decisions to review (REVIEW-tagged in the LOG)

- **Crypto and key handling (VAR-1, VAR-2)**: master keys come from the process environment (`ORCH_MASTER_KEYS`, newest first); no key wiping; per-owner data keys (organization, project, environment) wrapped by the current master key; AAD binds organization, project, variable id and version, not the environment, key name or kind. A rewrap function exists but no job replaces the data keys of `connections` or `variable_keys` after a rotation, so an old master key cannot be retired yet. Losing every master key loses every secret: OPS-4 (backup) must cover it. Deleted variables keep their ciphertext (no purge). `openChain` opens the whole chain, unbounded.
- **Delete semantics (VAR-2)**: removing a project or environment cascades to its variables, versions and keys; removing an organization cascades to its organization-level variables and keys (an org with projects or connections is still RESTRICT).
- **Authz model, new actions**: `variable.read|create|update|delete`, `secret.reveal` (VAR-4), `variable.restore` (VAR-5, also guards the single-variable restore and the restore plan), `variable.import` (VAR-6), `variable.bulk` (VAR-7), each with a `variable.org.*` twin at organization level. Project maintainer / organization admin for the bulk, import and restore families. A GitLab import also needs `connection.read` (org admin). Search needs no new action (`variable.org.read`).
- **Equality oracle**: plans for import, restore and bulk open every secret of the level to compare, so a dry run needs the write right and is audited. There is no rate limit anywhere yet.

## Remaining risks and open follow-ups

- **Search**: decrypts plain values of the organization (those a list shows); a value search is plain-only, case-sensitive, scans at most 2000 rows and then says `truncated`; no cursor; project-only members with no org role cannot search; not audited.
- **Bulk**: all-or-nothing in one transaction; nothing is locked, so a `set` may overwrite a concurrent edit and a race on a key rolls the request back; a rename does not rewrite `${OLD}` references in other values; history and restore use the current key, so a renamed key shows its new name in old snapshots; at most 1000 steps and 1 MiB (UTF-16 units) of values per request.
- **Limits of the API**: value cap 65,536 characters (GitLab's own is 10,000); kind and key cannot change through `PATCH` (a bulk rename changes the key); `reason` is free text only in version rows; the resolved view shows organization plain values to project readers and opens secrets without an audit row; there is no project-wide resolved view without an environment; list endpoints decrypt plain values and answer 503 without keys (versions and delete need none).
- **Restore and snapshots**: the snapshot shows old plain values to readers and is unpaginated; kind conflicts are skipped; descriptions are not versioned; nothing is locked, so a restore overwrites concurrent edits; no retention for versions.
- **Import**: GitLab import is project/environment level only (scope = environment slug); `masked` and `protected` flags are noted, not carried over; hidden, other-scope and bad-key variables are skipped and reported; nothing is ever deleted; dotenv quirks (an unclosed quote swallows following lines, `${X}` stays literal but is a reference to this platform's resolver); caps 1000 entries, 1000 problems, 1 MiB; an unparseable JSON document answers 200 with a `syntax` skip. The GitLab side is proven against the mock only.
- **Equivalent mutants** (documented in the LOG): VAR-3 R27, VAR-4 V1, two in VAR-6 (BOM strip, environment check) and the `hidden`/`null` halves.
- `/security-review` could not run (no remote); inline reviews are recorded per task.
- Migration `0012` needs `bun run db:migrate` on the local dev database (with `0007`-`0011` if not yet applied).
