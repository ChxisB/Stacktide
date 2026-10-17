# DevOps Orchastrature

A control plane that sets up GitLab CI/CD for projects in minutes, manages variables and secrets in one place, syncs them to where they are needed, and later orchestrates IaC stacks. GitLab CI is the runner; the platform never holds cloud credentials.

Plan and status: [.claude/.planning/ROADMAP.md](.claude/.planning/ROADMAP.md). Decisions: [docs/adr/](docs/adr/).

## Quickstart

Requires [Bun](https://bun.sh) 1.4+.

```bash
bun install
bun run check      # typecheck + lint + test
bun run dev:db     # local Postgres on 127.0.0.1:5433 (needs Docker)
```

## API

`bun run dev:db && bun run db:migrate && bun run dev` starts the API on `127.0.0.1:3000` (`HOST`, `PORT`, `LOG_LEVEL` override). `GET /health` is liveness, `GET /ready` checks the database. Errors are `application/problem+json` with a stable `code` and a `request_id` that is also in the logs. Until real authentication exists (AUTH-3) every caller is the dev principal: keep it on loopback, and it refuses to start with `NODE_ENV=production`.

## Local database

`bun run dev:db` starts Postgres 18 from [docker-compose.yml](docker-compose.yml) using the throwaway defaults in [.env.example](.env.example), and returns once it is healthy. Data lives in the named volume `orch_pgdata`.

- Port 5433 is used so it does not clash with another local Postgres on 5432.
- To override a setting, export it in your shell first (`POSTGRES_PORT=5440 bun run dev:db`). Shell variables win over `.env.example`.
- Stop: `docker compose -p orch down`. Wipe data too: `docker compose -p orch down -v`.
- Schema changes: edit `packages/db/src/schema/`, run `bun run db:generate`, commit the new SQL in `packages/db/drizzle/`. Migrations are forward-only. `bun run db:migrate` applies them to `DATABASE_URL`; it falls back to the local database above unless you export `DATABASE_URL` in your shell, so check before pointing it elsewhere.
- Tests need the database running (`bun run dev:db`). Each test file creates and drops its own `orch_test_*` database via `createTestDb()` from `@orch/db/testing`.
