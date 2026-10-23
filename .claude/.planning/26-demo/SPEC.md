# 26 Demo - Spec
Prefix: DEMO · Milestone: M5 · Status: building · Needs: 22, 23 (the screens)

## Goal
Show the platform without a GitLab, a cloud account or any setup beyond a Postgres: one command starts the real API and the real web page, fills them with a believable organization, and signs you in. For a live walkthrough, a screen-share, or screenshots for a deck.

## What is real and what is not
- **Real:** the API, the database (a throwaway one, dropped on exit), the web page, the job worker, authorization, audit, sealing of secrets, the sync plan and apply (against the mock GitLab).
- **Mock:** GitLab. It is the in-process mock the tests use (`@orch/gitlab/mock`), so a pipeline never runs; the runs on screen are rows the seed wrote. Say so in a demo.
- **Fake data:** every name, value and key is invented and obviously so (`demo-...`). Nothing is read from the machine.

## Scope
1. `apps/web/demo/seed.ts`: `seedDemo(backend)` fills a fresh backend and returns the ids a caller needs. `apps/web/demo/server.ts`: the entry (`bun run demo`).
2. Something on every page that reads data: the newest pipeline of eight branches in every state (failed and canceled ones retry for real), Terraform state versions of two stacks, findings of every severity, a worker pool, variables per environment, and a sync target that was applied once and has drifted since, so plan and apply can be shown live. (IaC runs and approvals are not seeded: no screen reads them until DNS-15.)
3. `docs/demo.md` and a README line.
4. `bun run demo:shots`: every page in dark and light, saved as PNGs.

## Non-goals
- A hosted demo or a public sign-in (changes the auth model; a human gate, not planned here).
- Running pipelines for real, or a real GitLab.
- A new dependency, or any change to the API or the screens.
- Keeping demo data between runs.

## Design
- **Same pattern as `e2e/server.ts`:** it already boots `startBackend` (real API, fresh database, mock GitLab, worker) with the page in front. The demo is that with a richer seed and a sign-in link. `startBackend` lives in `src/testing.tsx` and imports Testing Library, a dev dependency: fine on a laptop, and the demo is not in the image (`.dockerignore`).
- **Everything goes through the API client where it can** (organizations, connections, imports, environments, variables, pools, sync targets), so the seed also shows the API works; the database is written directly only for what has no route: pipeline run history, run stacks and summaries, findings, state versions, a change request.
- **Sign-in:** the seed makes a session in the database (as the tests do) and a second loopback-only listener, on the next port, answers one request with the cookie and a redirect to the app. Cookies ignore the port, so one click signs you in.
- **Loopback only:** both servers bind `127.0.0.1` and take no `HOST`. There is no way to expose the demo by a setting.
- **Safe to leave running:** the database is created by `createTestDb` under a random name and dropped on SIGINT/SIGTERM.

## Acceptance
- `bun run dev:db && bun run demo` prints one link; opening it lands signed in on Home, and each of the ten pages has data.
- `seed.test.ts` seeds a backend and reads back, through the API, each thing the seed claims to have made.
- No seeded secret value is in any list response (the leak check the API tests make everywhere).
- `bun run demo:shots` writes a non-empty PNG per page and theme.
- `bun run check` is green; no test is weakened.

## Risks
- The seed drifts from the schema or the screens as they change. The seed test fails first, and the shots script fails on a page that shows the error boundary.
- A session cookie handed out by a link: anything on the machine that can reach the second port gets the demo user. The user has fake data only and the port is loopback; said in the doc.
- The seed writes to tables directly, so a column added later may need a line here.
