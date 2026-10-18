# 13 Deploy and Operate - Tasks

### OPS-1 - Container image  `[x]` M - deps: API-3, API-6, FND-6
Do: multi-stage Dockerfile (pinned Bun), non-root user, `HEALTHCHECK`, commands `api` / `worker` / `migrate`; CI builds it (no push yet).
Done when: the image starts, `/health` is green and `migrate` is idempotent; image runs as non-root (tested).
Done 2026-10-18: `Dockerfile` (pinned `oven/bun:1.4.2`, multi-stage, non-root `bun`, `HEALTHCHECK`, commands `api|worker|migrate|web`) and `deploy/image-test.sh` (builds, checks non-root, migrate twice, `/health` healthy, `/ready`). Built and tested on a GitHub Actions runner (`image` job: `image-test: ok`) because the local Docker VM has no room to build; the GitLab `image` job has not run on a real GitLab (FND-6).

### OPS-2 - Self-host compose and docs  `[!]` M - deps: OPS-1
Do: `deploy/compose.yml` (api, worker, postgres, migrate), env reference table, first-run guide (GitLab OAuth app, master key generation).
Done when: following the doc on a clean machine yields a working login (smoke script included).
Blocked on the last step only: `deploy/compose.yml`, the settings table and first-run guide (`docs/self-host.md`, linking the OPS-4 runbook) and `deploy/smoke.sh` are written, and the smoke passes on GitHub Actions (migrate, `/health`, the page, `/auth/login` redirecting to the configured GitLab, no master keys in the web container). "A working login" needs a real GitLab OAuth application (a write to a real GitLab, a human gate) and a clean-machine run; neither has happened.

### OPS-3 - Metrics  `[x]` M - deps: API-3, API-6
Do: `/metrics` (auth-protected or internal-only) with the metrics in the SPEC; labels never contain ids of secrets or values.
Done when: tests assert metric names/labels and a label-cardinality guard.

### OPS-4 - Backup, restore, key rotation runbook  `[x]` M - deps: VAR-1, OPS-2
Do: backup script (pg_dump + key handling guidance), restore script, `rotate-master-key` command using `rewrap`, runbook doc.
Done when: an automated test restores into a fresh DB and decrypts a known secret; rotation leaves all values readable. **`/security-review`.**

### OPS-5 - Hardening  `[x]` M - deps: AUTH-3
Do: rate limiting (login, token create, reveal, webhooks), CORS allowlist, security headers, body limits, cookie flag assertions, `bun audit` job in CI.
Done when: tests hit each limit and header; CI fails on a seeded vulnerable dependency. **Release gate for non-local exposure. `/security-review`.**

### OPS-6 - Release pipeline  `[!]` M - deps: OPS-1, CLI-7
Do: tag-triggered pipeline: versioned image to the GitLab registry, CLI binaries, changelog from commit messages.
Done when: a dry-run tag pipeline produces all artifacts. **Publishing is a human gate.**
Blocked: needs OPS-1's image and a real pipeline (FND-6) to run a dry-run tag; publishing to the registry is a human gate. `.gitlab-ci.yml` already has the CLI `release` job from CLI-7. Remaining: the image job, the changelog-from-commits step (a script with a test is the part that needs no pipeline), and a dry-run tag that publishes nothing.

### OPS-7 - Dogfood  `[!]` M - deps: PIPE-6, SYNC-6, OPS-6
Do: import this repo into the platform, manage its pipeline and CI variables through it, document gaps found as new tasks.
Done when: the repo's `.gitlab-ci.yml` is produced by PIPE and its CI variables by SYNC with an empty drift report.
Blocked: needs OPS-6, a running instance and this repository on a real GitLab; the first PIPE apply (a merge request) and the first SYNC apply are the same not-done human gates as PIPE-6/PIPE-7/SYNC-6. Remaining: run it against a sandbox group, then write the gaps found as new tasks.
