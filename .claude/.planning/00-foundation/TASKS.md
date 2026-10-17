# 00 Foundation - Tasks

### FND-1 - Confirm decisions as ADRs  `[x]` S - deps: -
Do: Walk the user through ROADMAP D1-D12, record each answer as a short `docs/adr/000N-title.md` (context, decision, consequences). Mark the ROADMAP table "confirmed".
Done when: user confirmed every row; ADR files exist; ROADMAP matches. **Human gate.**

### FND-2 - Bootstrap repo  `[x]` S - deps: FND-1
Do: `git init` (branch `main`); `.gitignore` (node_modules, dist, `.env*` except `.env.example`, `*.pem`, `*.key`, `secrets.json`); root `package.json` with workspaces; `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, bundler resolution); README quickstart.
Done when: `bun install` succeeds; `git status` shows no ignored secrets.

### FND-3 - Quality gates  `[ ]` S - deps: FND-2
Do: Biome config; scripts `typecheck`, `lint`, `test`, `check`; one smoke test in `packages/core`.
Done when: `bun run check` is green, and a deliberate type error, lint error and failing test each turn it red (verify once, then revert).

### FND-4 - Config loader and redacting logger  `[ ]` S - deps: FND-3
Do: In `packages/core`: `loadConfig(schema, env)` and `createLogger()`.
Done when: tests prove invalid env throws listing all bad keys without values; logger redacts nested objects and headers.

### FND-5 - Local infrastructure  `[ ]` S - deps: FND-2
Do: `docker-compose.yml` with Postgres (pinned major, healthcheck, named volume); `.env.example`; script `dev:db`; README section.
Done when: `bun run dev:db` then a `psql`/`Bun.sql` `SELECT 1` succeeds using only `.env.example` values.

### FND-6 - Dogfood CI  `[ ]` S - deps: FND-3, FND-5
Do: `.gitlab-ci.yml`: pinned `oven/bun` image, cached bun install cache, a `check` job with a Postgres service.
Done when: config passes GitLab CI lint (`glab ci lint` or the UI) and the pipeline is green on `main`.
