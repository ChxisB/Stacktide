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

`bun run dev:db && bun run db:migrate && bun run dev` starts the API on `127.0.0.1:3000` (`HOST`, `PORT`, `LOG_LEVEL` override). `GET /health` is liveness, `GET /ready` checks the database. Errors are `application/problem+json` with a stable `code` and a `request_id` that is also in the logs. Callers are checked: a GitLab sign-in session (cookie `orch_session`) and a role per organization or project; roles come from GitLab membership: an organization's `gitlabGroupId` and a project's `gitlabProjectId` link them to GitLab, and the user's access level there (Reporter and up, inherited included) becomes the role, looked up with `GITLAB_MEMBERSHIP_TOKEN` and kept 5 minutes. GitLab unreachable means 503, never a guess. A CI job posts its GitLab `id_token` (`id_tokens:` with `aud: $ORCH_CI_AUDIENCE`) as `{"id_token": ...}` to `POST /auth/ci/exchange` and gets a token (`Authorization: Bearer orchci_...`, 15 minutes at most) that reads its own project and environment; a protected environment is only reached from a protected ref. Without the token nobody holds a role, and only organization creation by `ORCH_PLATFORM_ADMIN_GITLAB_IDS` works. `bun run dev` sets `ORCH_DEV_AUTH=1`, which turns that off (every caller is the dev principal); the API refuses it outside `NODE_ENV=development|test` and on a non-loopback `HOST`.

Connections (`/organizations/:orgId/connections`, org admins only) hold the credentials the platform uses for outside systems; today a GitLab access token with `read_api` and its base URL (https, or loopback for tests). `POST` checks the token against GitLab first (a bad one is a 422 and nothing is stored), seals it with a per-connection key and answers without it; `POST .../:id/test` re-checks it and reports the account and scopes; no route ever returns the token. They need `ORCH_MASTER_KEYS` (`k2:<base64 32 bytes>,k1:<...>`, newest first, see ADR-0007): without it creating and testing answer 503, and a key list that does not parse stops the API from starting. An organization with connections cannot be deleted until they are.

Importing (`/organizations/:orgId/connections/:connectionId/...`, org admins only): `GET .../gitlab-projects` lists the GitLab projects the connection sees (cursor paged, `search`, `archived`), marking the ones already imported; `POST .../imports` takes up to 25 GitLab project ids and creates or refreshes a platform project for each, named by its GitLab path, with its default branch and **detected types** (`bun`, `node`, `docker`, `terraform`, `terragrunt`, each with a confidence and the paths that suggest it). Detection reads file paths only, never contents. Importing again refreshes the branch and types and keeps a name changed here. A project GitLab does not know, the token may not read, whose name is taken, or whose path or branch is not acceptable fails alone; a failing GitLab or token fails the whole import with nothing written. A repository with more than 5000 entries is reported `truncated`: its types may be incomplete.

Webhooks: an org admin issues a connection's webhook secret with `POST /organizations/:orgId/connections/:connectionId/webhook-secret` (shown once, only its hash is stored; issuing again replaces it) and sets it as the **Secret token** of a GitLab webhook that posts to `/webhooks/gitlab/:connectionId`. The receiver checks the token in constant time before it reads the body; an unknown connection, a connection without a secret and a wrong token all answer the same 401. Push, merge request, pipeline, job and note events each become one job on the `gitlab.event` queue, carrying ids and a few fields (never the body, which can hold CI variables and note text); other events are accepted and dropped. A repeated `Idempotency-Key` (else `X-Gitlab-Event-UUID`) is answered `duplicate` and queues nothing; without one there is no dedupe. Bodies over 1 MiB are refused (413). Nothing consumes the queue yet (the pipeline and IaC features will).

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
