# 01 Core API and DB - Tasks

### API-1 - DB package, migrations, test helper  `[x]` M - deps: FND-4, FND-5
Do: `packages/db` with Drizzle on `Bun.sql`; `db:migrate` / `db:generate` scripts; test helper that gives each test file an isolated database and drops it after.
Done when: a test runs a migration against a fresh DB and two test files run in parallel without interfering.

### API-2 - Base schema  `[x]` S - deps: API-1
Do: `organizations`, `projects` (name, gitlab_project_id nullable, default_branch), `environments` (name, slug, order; unique per project) + repo functions.
Done when: repo tests cover insert, unique violations and cascade rules.

### API-3 - HTTP skeleton  `[x]` M - deps: FND-4
Do: `apps/api` bootstrap; request-id; logger per request; error -> problem+json mapper; `/health`, `/ready` (checks DB); graceful shutdown; `ctx.principal` with a dev stub.
Done when: tests show a thrown domain error maps to the right status/code, and an unknown error returns a generic 500 body with no internals.

### API-4 - Org / project / environment CRUD  `[x]` M - deps: API-2, API-3, API-8
Do: REST endpoints with zod validation and cursor pagination; every mutation writes an audit event.
Done when: endpoint tests cover validation errors, pagination edges, not-found and audit rows.

### API-5 - OpenAPI and typed client  `[x]` S - deps: API-4
Do: Generate OpenAPI from the routes; export a typed client package that CLI and UI share.
Done when: a test calls the API through the typed client; CI fails if the generated spec is stale.

### API-6 - Job queue and worker  `[x]` M - deps: API-1
Do: `jobs` table; `enqueue`, `claim` (`SKIP LOCKED`), `complete`, `fail` with exponential backoff and dead-letter; `apps/api/src/worker.ts` entrypoint with handler registry and graceful stop.
Done when: a concurrency test with 3 workers and 100 jobs runs each job exactly once; a failing job retries then goes `dead`; `last_error` is redacted.

### API-7 - Recurring jobs  `[x]` S - deps: API-6
Do: `schedules(name, cron|interval, queue, payload, next_run_at)`; the worker enqueues due schedules without double-firing across workers.
Done when: a test with a fake clock shows exactly one enqueue per tick with two workers.

### API-8 - Audit event primitive  `[x]` S - deps: API-2
Do: `audit_events` (actor, action, resource_type/id, org, project, metadata jsonb, request_id, ip, at); `audit(tx, ctx, event)`; forbid UPDATE/DELETE via DB trigger; metadata guard rejects keys like `value`, `secret`, `token`.
Done when: tests prove UPDATE/DELETE are rejected, the guard rejects forbidden keys, and an audit row rolls back with a failed mutation. Also add a coverage test over registered routes: every non-GET route must call `audit` or carry an explicit `noAudit: "<reason>"` marker (the test fails otherwise, so later features can't forget).
