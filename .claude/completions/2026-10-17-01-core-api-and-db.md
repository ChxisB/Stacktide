# 01 core-api-and-db: done (2026-10-17)

All 8 tasks `[x]`. Gate: `bun run check` green, 322 pass + 1 skip + 0 fail (323 tests, 29 files). One local commit per task, nothing pushed.

| Task | Commit | What |
|---|---|---|
| API-1 | aa07253 | `packages/db`: Drizzle on `Bun.sql`, forward-only migrations, per-run test database helper |
| API-2 | 91d6bf7 | organizations, projects, environments, audit_events; `updated_at` triggers |
| API-3 | 0d88502 | Elysia skeleton: problem+json (RFC 9457), request ids, health/ready, config, logger with redaction |
| API-8 | 79d52a4 | Audit primitive: declared per route, written in the mutation's transaction, append-only trigger, route-coverage test |
| API-4 | 7f8d7aa | Organization / project / environment CRUD, keyset pagination |
| API-5 | 18208b0 | OpenAPI document and typed Eden client (`packages/api-client`) |
| API-6 | 84b0304 | Postgres job queue (`FOR UPDATE SKIP LOCKED`, retry with backoff, dead-letter) and worker |
| API-7 | 8f021bd | Recurring jobs: `schedules`, in-house UTC cron, `fireDue` (one job per tick across workers) |

Details, mutation results and review outcomes per task are in `01-core-api-and-db/LOG.md`.

## Remaining risks and open follow-ups

- **CRUD routes are unscoped until AUTH-3**: any principal can list, change or delete any organization. `/openapi/json` is public until then. Two fail-closed guards in `apps/api/src/index.ts` stop a production start meanwhile.
- **Delete semantics (REVIEW-tagged)**: organization to projects RESTRICT, project to environments CASCADE. Org and environment slugs are immutable by choice.
- **Audit**: the append-only trigger can be bypassed by the table owner, so the production app role must not own the table. The "declared audit but wrote none" check is a tripwire after commit, not a rollback.
- **HTTP**: a global 415 guard refuses every non-JSON body. Eden types `error` as `unknown` (use `problemOf`).
- **Job queue**: no lock heartbeat (a handler must finish within `lockTimeoutMs` or honour `signal`); delivery is at-least-once; a last-attempt job that outlives its lock is dead-lettered; no retention for done/dead rows; no backoff jitter; the lost-wakeup fix has no deterministic test.
- **Scrubber** (`scrubText`) is a best-effort net for free text: a secret with spaces after an unquoted `password=` leaks past the first space.
- **Schedules**: UTC only, no names/`L`/`W`; no overlap prevention (handlers must be idempotent); a poisoned row is retried and logged every poll; never deleted; no HTTP surface; about 4 extra round trips per worker per poll.
- **Operations**: `db:migrate` takes no advisory lock; stale `orch_test_*` databases are not cleaned up; `orch-db-1` is left running and the local `orch` database is migrated.
- `/security-review` could not run (no remote); inline reviews are recorded per task.
