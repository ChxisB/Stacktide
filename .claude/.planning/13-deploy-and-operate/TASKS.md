# 13 Deploy and Operate - Tasks

### OPS-1 - Container image  `[ ]` M - deps: API-3, API-6, FND-6
Do: multi-stage Dockerfile (pinned Bun), non-root user, `HEALTHCHECK`, commands `api` / `worker` / `migrate`; CI builds it (no push yet).
Done when: the image starts, `/health` is green and `migrate` is idempotent; image runs as non-root (tested).

### OPS-2 - Self-host compose and docs  `[ ]` M - deps: OPS-1
Do: `deploy/compose.yml` (api, worker, postgres, migrate), env reference table, first-run guide (GitLab OAuth app, master key generation).
Done when: following the doc on a clean machine yields a working login (smoke script included).

### OPS-3 - Metrics  `[x]` M - deps: API-3, API-6
Do: `/metrics` (auth-protected or internal-only) with the metrics in the SPEC; labels never contain ids of secrets or values.
Done when: tests assert metric names/labels and a label-cardinality guard.

### OPS-4 - Backup, restore, key rotation runbook  `[ ]` M - deps: VAR-1, OPS-2
Do: backup script (pg_dump + key handling guidance), restore script, `rotate-master-key` command using `rewrap`, runbook doc.
Done when: an automated test restores into a fresh DB and decrypts a known secret; rotation leaves all values readable. **`/security-review`.**

### OPS-5 - Hardening  `[ ]` M - deps: AUTH-3
Do: rate limiting (login, token create, reveal, webhooks), CORS allowlist, security headers, body limits, cookie flag assertions, `bun audit` job in CI.
Done when: tests hit each limit and header; CI fails on a seeded vulnerable dependency. **Release gate for non-local exposure. `/security-review`.**

### OPS-6 - Release pipeline  `[ ]` M - deps: OPS-1, CLI-7
Do: tag-triggered pipeline: versioned image to the GitLab registry, CLI binaries, changelog from commit messages.
Done when: a dry-run tag pipeline produces all artifacts. **Publishing is a human gate.**

### OPS-7 - Dogfood  `[ ]` M - deps: PIPE-6, SYNC-6, OPS-6
Do: import this repo into the platform, manage its pipeline and CI variables through it, document gaps found as new tasks.
Done when: the repo's `.gitlab-ci.yml` is produced by PIPE and its CI variables by SYNC with an empty drift report.
