# 13 deploy and operate: 3 of 7 built (metrics, hardening, backup and key rotation), 4 blocked on disk space, a real pipeline and a real GitLab (2026-10-18)

Written for: the maintainer who will review the REVIEW-tagged decisions (the `/metrics` auth model, the rate-limit numbers, key handling in the rotation command) and who has to unblock the image, the compose file, the release pipeline and the dogfood run.

OPS-3, OPS-4 and OPS-5 `[x]`. OPS-1, OPS-2, OPS-6 and OPS-7 `[!]`. Gate: `bun run check` green, 4113 pass + 2 skip (the opt-in real-GitLab run's host check and the opt-in Vault run) + 0 fail (root), 241 pass + 0 fail (web). One local commit per task, nothing pushed. The feature is `partial` in the ROADMAP: the code that needs no image or real GitLab is done; the rest is not.

| Task | Commit | What |
|---|---|---|
| OPS-3 | dfe3874 | `GET /metrics` (Prometheus text, static bearer token, off unless `ORCH_METRICS_TOKEN` is set): request counts and latency by registered route, queue and run state counts, age of the oldest waiting/running item, GitLab rate-limit headroom per host. Label cardinality is capped and tested |
| OPS-5 | 11decd5 | Rate limits per route class (login, CI exchange, webhook, token create, reveal), security headers, CORS allowlist (off by default), body size cap, trusted-proxy client address, a `bun audit` CI job. `yaml` 2.8.1 -> 2.8.3 for an advisory |
| OPS-4 | aaeb8d4 | `deploy/backup.sh` (no-clobber, 0600), `deploy/restore.sh` (empty database only, one transaction), `bun run keys:rotate` / `rotate-master-key.ts [--status]` (re-wraps every data key under the new master key, verified before it is stored), `docs/runbook-keys-and-backup.md` |
| OPS-1 | - | Blocked: no disk to build or start an image here; the CI build job needs FND-6 |
| OPS-2 | - | Blocked: needs OPS-1 and a real GitLab OAuth application for the login |
| OPS-6 | - | Blocked: needs OPS-1 and a real pipeline; publishing is a human gate |
| OPS-7 | - | Blocked: needs OPS-6 and a real GitLab for the first PIPE and SYNC applies |

No migrations in this feature (the last one is still `0032_audit_forwarding.sql`). New dependencies: none. Docs: `docs/metrics.md`, `docs/hardening.md`, `docs/runbook-keys-and-backup.md`. OpenAPI regenerated (OPS-3 route excluded like `/health`, OPS-5 adds `x-rate-limit`).

Details, mutation results (OPS-3: 30 mutants; OPS-5: 61 + 16; OPS-4: 28 + 15 + 6, survivors listed per task) and review outcomes are in `13-deploy-and-operate/LOG.md`.

## Not done: human gates and blockers

- **OPS-1: no image has been built or started.** The Docker VM has about 275 MB free on a disk shared with other projects (a full disk already put Postgres into recovery once, in EXT-5). I did not prune the shared build cache (about 28 GB, 20.7 GB reclaimable) or old images. Free the space yourself, then OPS-1 is: multi-stage Dockerfile, a test that builds it, starts it and checks `/health`, `migrate` twice and a non-root user, then the CI build job.
- **OPS-2: no compose file, env table or first-run guide.** A working login needs a real GitLab OAuth application (a write to a real GitLab). The OPS-4 runbook is standalone and should be linked from the guide.
- **OPS-6: no release pipeline.** Needs the image and a real pipeline (FND-6 is `[!]`); publishing a versioned image and binaries is a human gate. The CLI `release` job from CLI-7 exists in `.gitlab-ci.yml`.
- **OPS-7: the platform does not manage its own pipeline or variables yet.** Needs OPS-6 and a real GitLab, and it repeats the not-done gates of PIPE-6/PIPE-7/SYNC-6 (first real apply, merge request and fleet upgrade).
- **The CI `audit` job has never run on a real pipeline**, and "CI fails on a seeded vulnerable dependency" is not demonstrated: only the local `bun audit` exit codes were checked. Release gate for non-local exposure: seed a vulnerable version on a throwaway branch.
- **The OPS-4 backup/restore test is skipped where `pg_dump`, `pg_restore`, `psql` (at least version 18) or `bash` are missing.** The CI image (`oven/bun`) has none of them, so CI would skip it until a job installs the client tools.
- **Nothing has run on a real deployment:** the first restore and the first key rotation should be done on a copy.

## Decisions to review (REVIEW-tagged in the LOG; the complete lists are there)

- **Metrics (OPS-3, 7 items):** one static bearer token for the whole instance, no rotation story beyond redeploying; figures are per API process (the worker has no listener, and the GitLab rate limit is only what the API process saw); **run durations are not delivered** because `sync_runs`/`run_stacks`/`jobs` keep no start time (a column and a migration, a follow-up); done-job and finished-run counts are gauges and shrink when rows are deleted; full `group by` scans at scrape time cached for 5 s; the `host` label comes from organization-chosen base URLs (cap 20, silent); a scrape holds up to three pool connections.
- **Hardening (OPS-5, 14 items):** the limiter is in memory per replica (a restart forgets; at 10 000 keys the oldest counter is evicted); the limit values are guesses (login shared by browser and CLI, reveal shared by single reveals and exports; `ORCH_RATE_LIMIT_SCALE` is the knob); `ORCH_TRUSTED_PROXY_HOPS` must be true (unset behind a proxy, all clients share a bucket; set too high, a caller chooses their bucket); IPv6 per address; no global per-IP net; **the SPA HTML has no CSP or security headers** (OPS-2 decides how production serves it); CORS off by default and same-site only; Bun's own body cap answers first with a plain-text 413; the dev principal is exempt; `/metrics` is not rate limited.
- **Backup, restore, rotation (OPS-4, 12 items):** key handling is a human gate (**re-wrap only, not a DEK re-key**: a leaked old master key plus an old dump still opens that dump, so change the secrets at their source); the key provider is still the environment; rotation needs every api and worker on the new list first (re-run until `--status` exits 0, then drop the old key); **the master keys are not in the backup and nothing checks that they are stored anywhere**; a dump holds ciphertext, wrapped keys and the audit log; the database URL is visible in `ps` (a keyword string plus `~/.pgpass` is documented); no scheduled backups, retention, dump encryption, point-in-time recovery or partial restore; the restore emptiness check covers tables, views and sequences only.
- Disclosed edits to existing tests (nothing weakened): `cli-login.test.ts`/`tokens.test.ts` build their app with `rateLimitScale: 100`; `authz.test.ts` gained a structural test and its public-route list gained `/metrics`; `spec.test.ts` excludes `/metrics`; `metrics.test.ts` allows one second of slack on an age band (host and Docker VM clocks differ).

## Findings that matter beyond this feature

- **A race test can pass while testing nothing.** My first "a row another run moved first" test changed the row before its table was read, so the compare-and-swap guards survived every mutation. Only mutating the guard exposed it. Mutate the guard of any concurrency test you write.
- **A Drizzle/Postgres error message includes the SQL parameters.** Never log it where the parameters hold wrapped keys; the rotation command logs the error name and code only.
- **The logger redacts any field whose name matches `pass|token|secret|auth|key|value|…`**, so a list of `{table, count}` reports fine and a field named after a table can disappear.
- **The key-rewrap follow-up from POL-2, GOV-2 and GOV-4 is closed**: the three tables that hold a wrapped data key (`variable_keys`, `connections`, `notification_sinks`) are re-wrapped by one command, and a structural test fails if a fourth appears without being listed.
- Mutation passes found real test gaps in every task; each survivor was killed by a stronger test, simplified away, or recorded as an equivalent mutant (OPS-4: the backup's missing-`DATABASE_URL` check and its early file-exists check; OPS-3: `given !== ""`).

## Remaining risks and open follow-ups

- Unblock order: free Docker disk -> OPS-1 -> OPS-2 (link the runbook, decide how the SPA is served with security headers) -> FND-6 (a real pipeline; also proves the `audit` job) -> OPS-6 dry run -> OPS-7.
- Add `pg_dump`/`pg_restore`/`psql` 18 to a CI job so the backup test runs there.
- Add a start-time column to runs and jobs, then a duration histogram for `/metrics`.
- Move the rate limiter to Postgres before running more than one replica.
- Mutation survivors left on purpose are listed per task in the LOG.
