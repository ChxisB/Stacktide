# 26 Demo - Tasks

Gate for every task, from the repo root: `bunx biome format --write apps/web`, `bunx biome check apps/web`, `bun run typecheck`, then `cd apps/web && bun test --env-file=../../.env.example` (needs a Postgres: `bun run dev:db`, or any at `DATABASE_URL`). The last task runs `bun run check`.

### DEMO-1 - The world and the command  `[x]` M - deps: none
Do: `apps/web/demo/seed.ts` exports `seedDemo(backend)`: an organization, a mock GitLab with three projects, a connection, two projects imported, three environments, org/project/environment variables (plain and secret), one worker pool, and a signed-in owner. `demo/server.ts` boots `startBackend`, the worker and `startWeb` on `DEMO_PORT` (default 3200), plus the loopback sign-in listener on the next port, prints one link, and drops the database on exit. `bun run demo` in the root `package.json`; `demo` added to the web `tsconfig` and `.dockerignore`.
Done when: `demo/seed.test.ts` (seen failing first) seeds a fresh backend and reads back through the API client: the projects, the environments, each variable with its scope, the pool, and that no secret's value is in a list response.

### DEMO-2 - Something on every page  `[x]` M - deps: DEMO-1
Do: the seed adds what the pages read: the latest pipeline of eight branches of `acme/web` in every state (the failed and canceled ones are real pipelines of the mock GitLab, so Retry works in the demo), two Terraform stacks with state versions, four findings of every severity, and a sync target on the mock GitLab that has been applied once and has since drifted, so the demo can show plan and apply live.
Done when: `seed.test.ts` reads each back through the API (latest runs by status with the failure reason, state versions per stack, findings by severity, the target's last run and its drift), applies the drifted target's plan with the worker running and sees the mock GitLab hold the change and the drift gone (this test is last: it changes the world), and the leak test now covers these responses too.
Changed from the plan: the first version also seeded an IaC run with stacks, plan summaries and a pending approval, and two weeks of run history. No screen reads those (Status shows the latest run of each branch; there is no IaC run or approval screen until DNS-15), so they are left out; add them when a screen needs them.

### DEMO-3 - Say what it is  `[x]` S - deps: DEMO-1
Do: `docs/demo.md` (run it, what is real and mock, how to stop and reset, the cookie-link note, using another Postgres) and one line in the README quickstart.
Done when: the doc's commands are the ones in `package.json` (a test reads the script names out of the doc and the file), and the README links it.

### DEMO-4 - Screenshots  `[x]` S - deps: DEMO-2
Do: `apps/web/demo/shots.e2e.ts` (a Playwright test with its own config, `demo/playwright.config.ts`, not `shots.ts`) (`bun run demo:shots`): seeds in-process, signs in, visits each route in dark and light at 1280 px, writes `apps/web/demo/shots/<page>-<theme>.png` (git-ignored), and fails if a page shows the error boundary, a failed request, or sideways scroll.
Done when: running it writes twenty non-empty PNGs and exits 0; with a route deliberately broken in a scratch edit it exits non-zero.

### DEMO-5 - Delivery  `[x]` S - deps: DEMO-1..4
Do: `bun run check`; `/security-review` over the diff (a session is issued without a sign-in: loopback only, said and tested); `/code-review`; the completion file `.claude/completions/YYYY-MM-DD-26-demo.md`; ROADMAP row 26 set to done.
