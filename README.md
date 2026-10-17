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

`bun run dev:db && bun run db:migrate && bun run dev` starts the API on `127.0.0.1:3000` (`HOST`, `PORT`, `LOG_LEVEL` override). `GET /health` is liveness, `GET /ready` checks the database. Errors are `application/problem+json` with a stable `code` and a `request_id` that is also in the logs. Callers are checked: a GitLab sign-in session (cookie `orch_session`) and a role per organization or project; nobody holds a role yet (AUTH-5), so only organization creation by `ORCH_PLATFORM_ADMIN_GITLAB_IDS` works. `bun run dev` sets `ORCH_DEV_AUTH=1`, which turns that off (every caller is the dev principal); the API refuses it outside `NODE_ENV=development|test` and on a non-loopback `HOST`.

## Local database

`bun run dev:db` starts Postgres 18 from [docker-compose.yml](docker-compose.yml) using the throwaway defaults in [.env.example](.env.example), and returns once it is healthy. Data lives in the named volume `orch_pgdata`.

- Port 5433 is used so it does not clash with another local Postgres on 5432.
- To override a setting, export it in your shell first (`POSTGRES_PORT=5440 bun run dev:db`). Shell variables win over `.env.example`.
- Stop: `docker compose -p orch down`. Wipe data too: `docker compose -p orch down -v`.
- Schema changes: edit `packages/db/src/schema/`, run `bun run db:generate`, commit the new SQL in `packages/db/drizzle/`. Migrations are forward-only. `bun run db:migrate` applies them to `DATABASE_URL`; it falls back to the local database above unless you export `DATABASE_URL` in your shell, so check before pointing it elsewhere.
- Tests need the database running (`bun run dev:db`). Each test file creates and drops its own `orch_test_*` database via `createTestDb()` from `@orch/db/testing`.

## GitLab contract against a real instance

`packages/gitlab` ships one contract suite ([contract.ts](packages/gitlab/src/contract.ts)). It always runs against the in-process mock; it can also run against a real GitLab **sandbox group**, which is how the mock stays honest. It is off by default and the first run is a deliberate step: it writes to the instance.

What it writes, all inside the one project you name: branches `orch-contract-*` (with a `.gitlab-ci.yml` of one manual job), merge requests on them (closed again), CI variables `ORCH_CONTRACT_*` in that project and in the group, and manual pipelines (cancelled). It never commits to the default branch. When it finishes it deletes the branches and variables it created (a removal that fails fails the run; merge requests go with their branches). Pipelines stay, cancelled. If a run is killed midway, anything named `orch-contract-*` or `ORCH_CONTRACT_*` is safe to delete by hand. The group-level variables exist briefly and are inherited by every project in the group, so use a group of its own.

```bash
export GITLAB_E2E_URL=https://gitlab.example.com
export GITLAB_E2E_TOKEN=...            # a project/group access token with `api` scope (Owner on the sandbox group)
export GITLAB_E2E_GROUP=sandbox/orch   # full path of the sandbox group
export GITLAB_E2E_PROJECT=sandbox/orch/demo   # a project inside it with a default branch and at least one commit
export GITLAB_E2E_ALLOW_WRITES=yes     # confirms the run may write there
bun test packages/gitlab/src/real.contract.test.ts
```

Group variable scopes are Premium; a Free group makes the scope cases fail by design (the client reports a scope GitLab ignored). Differences between the mock and the instance show up as failing contract cases: fix the mock, not the assertion, unless GitLab's behaviour is not guaranteed.
