# 00 Foundation - Log

## Run policy (set by user 2026-10-17, away ~6h, batch run through the roadmap)
- D1-D12 confirmed as proposed.
- One local commit per task on `main`; nothing is pushed, no remote.
- Gates: keep going; user reviews every task on return. Local design gates (crypto, authz model, migrations) are built to the approved SPEC and tagged **REVIEW** in the log. Outward-facing steps (real GitLab/cloud write, publish, push, MR) are NOT done: documented and left opt-in; a task that cannot finish without one is `[!]`.

## 2026-10-17 FND-1
- Wrote `docs/adr/0001..0012` from ROADMAP D1-D12 (all Accepted). ROADMAP decisions table marked confirmed.
- Gate: docs only, no code; `/code-review` and `/security-review` not applicable.
- Follow-ups: API-1 verifies Drizzle on `Bun.sql` (ADR-0004); UI-1 revisits ADR-0011.

## 2026-10-17 FND-2
- `git init -b main`; `.gitignore`; root `package.json` (workspaces `apps/*`, `packages/*`); `tsconfig.base.json`; README quickstart.
- Gate: `bun install` ok (no packages yet); `git check-ignore` confirms `.env*`, `*.pem`, `*.key`, `secrets.json` ignored and `.env.example` not. Config-only task: no `/code-review` (nothing to review beyond the invariants, which it does not touch).
- Deps added: none. `@types/bun` + `typescript` come with FND-3.

## 2026-10-17 FND-3
- Biome config (`biome.json`, 2-space, width 100, `.claude` excluded), root `tsconfig.json` (types: bun), scripts `typecheck` / `lint` / `test` / `check`, `packages/core` with a smoke test (red first: "Cannot find module", then green).
- Gate: `bun run check` green. Deliberate type error, lint error (`debugger`) and failing test each exited 1 at their own stage, then reverted (an earlier failing-test probe was invalid because Biome rejected its formatting first; redone with a formatted file).
- New deps (exact-pinned, devDependencies): `@biomejs/biome` 2.5.15 (ADR-0012 lint+format), `typescript` 7.0.2 (typecheck gate), `@types/bun` 1.4.3 (types for `bun:test`/Bun APIs).
- Biome 2.5 deprecates `linter.rules.recommended`; omitted since recommended is the default.
- Config + one constant only: no `/code-review`.

## 2026-10-17 FND-4
- `packages/core`: `loadConfig(schema, env)` -> throws `ConfigError` carrying key names + a value-free reason (`missing` or the zod issue code), never values or zod issues. `createLogger({write, level, bindings})` -> JSON lines; `redact()` masks sensitive keys at any depth (arrays, Headers, Map, Set, Errors incl. `cause`/`code`), scrubs secrets inside strings (URL userinfo, `Bearer`, sensitive query params), masks binary buffers (future DEKs) as `[Binary]`, stringifies BigInt, survives cycles and throwing getters.
- Gate: `bun run check` green, 23 tests. Includes canary leak tests (invariant 1).
- `/code-review` (medium) found 9; fixed: key-name coverage, string scrubbing incl. error message/stack, error cause/code, unknown level now falls back to info (was: everything incl. debug), Map/Set/URL, throwing getter, config reasons, one vacuous test. Not changed: `key`/`value` over-redaction (SPEC mandates it); built-ins `time/level/msg` win over same-named caller fields (intentional); per-task completion doc (the skill writes it in Phase 4).
- Security review (inline): `/security-review` diffs against `origin/HEAD` and this repo has no remote, so it cannot run. Reviewed by hand instead and found a real ReDoS in the query-param scrubber (1.2s on 200KB, quadratic); bounded the quantifiers and added a timing test. **Process note: `/security-review` is unusable until a remote exists; I do an inline review and record it here.**
- Known limit: redaction is key-name and pattern based. A secret under an innocuous key (`content`, `data`) is not caught. Callers must still never log secret values.
- New dep: `zod` 4.6.7 in `packages/core` (SPEC: one zod schema per app).

## 2026-10-17 FND-5
- `docker-compose.yml` (project `orch`, `postgres:18-alpine`, healthcheck, named volume `orch_pgdata` mounted at `/var/lib/postgresql` as PG18 images expect), `.env.example`, script `dev:db` (`docker compose --env-file .env.example up -d --wait db`), README section.
- Gate: `bun run dev:db` -> healthy; `Bun.sql` `SELECT 1` ok on Postgres 18.6 using only `.env.example` values (this also shows `Bun.sql` talks to PG18, input for API-1's Drizzle check). `bun run check` green. Config-only: no `/code-review`.
- Security (inline): port bound to `127.0.0.1` only; credentials are throwaway dev defaults, labelled as such in `.env.example`; no real `.env` created.
- Port 5433, not 5432: this machine already runs other projects' Postgres on 5432/5499 and Redis on 6379 (not touched). The `orch-db-1` container is left running for the following tasks.
- New deps: none (image `postgres:18-alpine` pulled from Docker Hub).

## 2026-10-17 FND-6 - BLOCKED (human gate: real GitLab)
- `.gitlab-ci.yml`: `oven/bun:1.4.2`, `check` job (`bun install --frozen-lockfile` then `bun run check`) with `postgres:18-alpine` service aliased `postgres`, bun install cache keyed on `bun.lock`, pipelines only for MRs and the default branch. `.bun-cache` added to `.gitignore`.
- Verified locally: YAML parses; the job's script lines and variables run green in the pinned image from a clean copy of the committable files (no `node_modules`), on a docker network with a Postgres service reachable at `postgres:5432` (`SELECT 1` ok). `bun.lock` carries the linux-x64 Biome and TypeScript binaries CI needs. Temporary sim containers/network removed.
- NOT verified: GitLab CI lint and a green pipeline on `main`. Needs a GitLab project and a push (human gate), and `glab` is not installed here. **To finish: create the project, push `main`, run `glab ci lint` (or the UI lint), confirm the pipeline is green, then mark FND-6 `[x]`.**
- Consequence: CLI-7 and OPS-1 list FND-6 as a dep and stay blocked behind it.
- Config only: no `/code-review`. Inline security: only throwaway service creds in the file; no secrets, no deploy, no push to default branch.
