# 01 Core API and DB - Spec
Prefix: API · Milestone: M1 · Status: todo

## Goal
An API server skeleton, a migration-managed Postgres model, a job queue and an audit primitive that every other feature plugs into.

## Scope
DB package + migrations + test helper; `organizations`, `projects`, `environments`; HTTP skeleton; CRUD for those three; OpenAPI + typed client; job queue + worker entrypoint; recurring jobs; audit event primitive.

## Non-goals
Auth (02), variables (04), anything GitLab-specific (03). Each feature owns its own tables.

## Design
- IDs: `Bun.randomUUIDv7()` (time-ordered). Every table has `created_at`/`updated_at`; every tenant row carries `organization_id` (single org in practice, but retrofitting is expensive).
- Errors: RFC 9457 `application/problem+json` with a stable `code`. No stack traces or values in responses.
- `ctx.principal` exists from API-3 with a dev-only stub; AUTH replaces it. Mutating routes are written against `ctx.principal` from day one.
- Pagination: cursor-based, `limit` capped.
- Jobs: `jobs(id, queue, payload jsonb, run_at, attempts, max_attempts, status, last_error, locked_by, locked_at)`. Claim with `FOR UPDATE SKIP LOCKED`, backoff on failure, `dead` after max attempts. `last_error` must be redacted.
- Audit: `audit_events` append-only, written in the same transaction as the mutation. Metadata = ids, key names, counts - never values.

## Acceptance
`bun run dev:db && bun run db:migrate && bun run dev` serves `/health` and `/ready`; CRUD works; a job enqueued by the API is run by the worker once under concurrent workers; an OpenAPI doc and typed client are generated.

## Risks / human gates
Framework choice (D3) and DB driver (D4) are locked in FND-1 - changing later is expensive.
