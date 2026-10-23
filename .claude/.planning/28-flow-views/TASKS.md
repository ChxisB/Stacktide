# 28 Flow views - Tasks

Gate for every task, from the repo root: `bunx biome format --write <touched folders>`, `bunx biome check .`, `bun run typecheck`, then the suites of the folders touched (`bun test --env-file=.env.example packages apps/api apps/cli`, `cd apps/web && bun test --env-file=../../.env.example`). Tests need Postgres on `localhost:5433` (`bun run dev:db`). Web tasks also run `bun run e2e`. Nothing here touches a real GitLab or cloud account (the mock GitLab only).

**Rule for every task: every existing test passes unchanged.** A test that has to change (an exact key list gaining a field) is a finding, written in LOG.md, not an edit made quietly. Every new CSS class gets a rule in `apps/web/src/styles.test.ts`.

**Cuts.** A (FLW-1 to FLW-4) the run graph. B (FLW-5, FLW-6) the Sync strip. C (FLW-7 to FLW-10) the job panel. FLW-11 delivers. The cuts do not depend on each other; approve any of them alone. Listed in the order I would build them: A is the biggest gain, B is the cheapest, C is the only one that adds a GitLab read.

## A. Run graph

### FLW-1 - Run stacks carry their order  `[x]` M - deps: none
Do: in `apps/api/src/routes/runs.ts` the stacks of a run answer gain `dependsOn: string[]` (direct dependencies that are in the same run) and `wave: number`. Work them out at read time from `listStacks` with `buildGraph(...).waves(runStacks)` from `@orch/iac`; one registry read per request, not per run. A stack the registry lacks gets `[]` and wave 0; a graph that does not build gives `[]` and wave 0 for all and logs one warning (names only). Update `runSchema`, `bun run openapi`.
Done when: route tests (seen failing first): a chain a→b→c gives waves 0, 1, 2 and the edges; a diamond gives 0, 1, 1, 2; a dependency that is not in the run is not in `dependsOn` but still orders the waves through it (`waves(subset)`); a removed stack and a cyclic registry answer 200 with wave 0 and no edges; the list route reads the registry once for many runs; reporter reads, stranger 404 (the existing guards). The existing run tests pass unchanged apart from the two new keys in an exact key list.

### FLW-2 - Graph layout as data  `[x]` S - deps: none
Do: `apps/web/src/run-graph-layout.ts` (no React, no DOM): `layout(stacks: {name, dependsOn, wave}[])` returns the boxes (`name`, `column`, `row`, `x`, `y`) and the edges (`from`, `to`, an SVG path string) using constants for box width, height and gaps. Columns follow `wave`, rows follow the sorted names within a column, an edge leaves the right side of the dependency and enters the left side of the dependent as a cubic curve, an edge to a name that is not in the list is dropped, and the result holds the width and height of the drawing.
Done when: unit tests: columns by wave; rows sorted by name; the same input in another order gives the same output; a chain, a diamond and a stack alone; an edge skips a column without crossing a box (it curves above or below the row); an unknown name adds no edge; an empty list gives an empty drawing.

### FLW-3 - RunGraph and the Plan runs card  `[x]` M - deps: FLW-1, FLW-2
Do: `apps/web/src/run-graph.tsx`: an SVG for the edges under absolutely placed boxes using `layout`; a box shows the status mark and word (`PLAN_STATE`'s label and tone, an icon from the existing glyphs, never colour alone) and the DNS tag; the drawing is `aria-hidden`, and a visually hidden list says "`<stack>` waits for `<stack>`". In `runs.tsx` a plan with at least one edge and at most 60 stacks gets a "Show order" `<details>` under its stack list (closed), holding the graph and "As registered on the default branch."; a plan with more than 60 stacks says the graph is not shown. The box row scrolls inside its own container (`overflow-x: auto`). `PlanStack` gains `dependsOn` and `wave`. New classes get `styles.test.ts` rules.
Done when: web tests: a chain shows three boxes and two edges once "Show order" is open; each box carries its state word; the hidden list names who waits for whom; a plan with no dependencies shows no "Show order"; a plan of 61 stacks shows the message and no graph; a state the web does not know still draws (as `planStateOf` does); the existing Plan runs tests pass unchanged.

### FLW-4 - Demo and layout journey for the graph  `[!]` S - deps: FLW-3
Do: read first how a stack and a run get into the demo (the seed has none today); then the smallest way to give the demo project four stacks (one dependency chain and one alone) and a plan run over them, through the API and the mock GitLab as the rest of the seed does. `seed.test.ts` pins it. The layout journey opens "Show order" at 1280 and 390 in both themes and asserts the page does not scroll sideways while the graph box may.
**Blocked 2026-10-20 (see LOG): no production code fills the `stacks` table, so the registry the graph reads is empty outside tests; waiting for the choice in the LOG.**
Done when: `bun run demo:shots` writes the Status shots with a graph and I read them at 1280, light and dark; `bun run e2e` passes; `seed.test.ts` passes (seen failing first). If the demo cannot make stacks without a real scan, stop and say so instead of faking rows.

## B. Sync strip

### FLW-5 - SyncFlow on the target card  `[x]` M - deps: none
Do: `apps/web/src/sync-flow.tsx`: a Variables box (the project's name), one line per mapped environment (`dev → development`, as words) and the target box (name and type). With a plan open each line carries that environment's counts ("2 to create, 1 to change"), taken from the plan's lines whose `scope` is the mapping's value (confirm in this task that `Line.scope` is that value; if it is not, counts go on the target box only); with no plan, the drift totals show once under the strip ("0 to create, 1 to change, 0 to delete", the words the card has today). The drawing is `aria-hidden`; the same words are text. `sync.tsx` uses it in place of the `Environments:` paragraph; a target with no mapping shows no strip. At phone width the strip stacks (Variables above, lines, target below). New classes get `styles.test.ts` rules.
Done when: web tests: two mapped environments give two lines with their words; an open plan puts each environment's counts on its line; without a plan the drift totals show once; a target with no mapping shows no strip; a plan line for an environment that is not mapped is not lost (counted on the target box); the existing Sync tests pass unchanged.

### FLW-6 - Demo and layout journey for the strip  `[x]` S - deps: FLW-5
Do: the demo's Sync shot shows the strip with a plan open (the seed's mapping has more than one environment, or is given a second); the layout journey checks it at 1280 and 390 in both themes with no sideways page scroll.
Done when: `bun run demo:shots` and `bun run e2e` pass; the Sync shots are read at 1280, light and dark, and at 390.

## C. Job panel

### FLW-7 - Jobs have times  `[x]` S - deps: none
Do: `packages/gitlab/src/pipelines.ts`: the job gains `startedAt`, `finishedAt` (ISO strings or null) and `duration` (seconds or null) from GitLab's `started_at`, `finished_at`, `duration`; the mock server's jobs carry them. No other caller changes.
Done when: gitlab tests (seen failing first): a finished job has the three; a pending job has nulls; a job with a field GitLab sends that the parser does not name does not carry it; the contract test (`contract.ts`) passes against the mock; the existing gitlab, `pipeline-runs` and `run-ingest` tests pass unchanged apart from an exact-object job in a test, written in LOG.md.

### FLW-8 - Jobs route  `[x]` M - deps: FLW-7
Do: `GET .../pipeline-runs/:runId/jobs` in `apps/api/src/routes/pipeline-runs.ts`, guard `pipeline.read`, no audit (a read). It loads the pipeline run (404), needs a linked project (422 `not_linked`) and the connection that last read the pipeline (409 `no_connection`, as retry), then reads the jobs through `gitlabFor` and returns `{ jobs, truncated }` with exactly: id, name, stage, status, allowFailure, failureReason, duration, startedAt, finishedAt, webUrl. At most 200 jobs; names and reasons clipped as `pipeline-runs.ts` clips them. GitLab failures map through `retryProblem`. `bun run openapi`; counts in `spec.test.ts` and `authz.test.ts`.
Done when: route tests (seen failing first): a pipeline with three jobs in two stages answers all three in GitLab's order; the answer holds exactly the allow-listed keys even when the mock job carries a trace, variables, a runner and a user (leak test); 201 jobs give 200 and `truncated: true`; a deleted connection is 409 and calls GitLab not at all; an unlinked project is 422; a GitLab 404/403/5xx map to the API's words; reporter reads, stranger and another project 404, a token without the scope is refused; no secret value or token in the answer or the logs.

### FLW-9 - Jobs panel on Status  `[x]` M - deps: FLW-8
Do: in `runs.tsx` each row of "Latest pipelines" gets a "Jobs" button labelled with the branch (`aria-expanded`, `aria-controls`); opened, a panel under the row lists the jobs by stage (stage heading, then a status mark and word, the name, the duration as `1m 12s`, a short reason on a failed job, "Open job" through `webUrl()`). It reads only when opened (a `useQuery` with `enabled`), looks again every `POLL_MS` only while the pipeline is going, shows `ErrorPanel` with retry on a failure and says "Showing the first 200 jobs" when truncated. New classes get `styles.test.ts` rules.
Done when: web tests: nothing is fetched until "Jobs" is opened; the jobs show by stage with durations and a failed job's reason; a running pipeline looks again and a finished one does not; closing stops the polling; an unsafe `webUrl` shows no link; the error panel retries; the truncated note shows; the existing Status tests (filters, retry, polling) pass unchanged.

### FLW-10 - Demo and layout journey for the panel  `[x]` S - deps: FLW-9
Do: the mock pipelines the demo seeds have jobs (a passed, a failed with a reason, a running) with durations; the demo's Status shot is taken with one row open; the layout journey opens it at 1280 and 390 in both themes with no sideways page scroll.
Done when: `bun run demo:shots` and `bun run e2e` pass; `seed.test.ts` pins the jobs (seen failing first); the Status shots are read at 1280, light and dark, and at 390.

## Delivery

### FLW-11 - Docs, review, delivery  `[x]` S - deps: the cuts you approved
Do: a short section in `docs/` (the existing page that describes the web app, or `docs/demo.md` if none fits) on what each view shows, where `dependsOn` comes from and when it can be out of date, and that jobs are read live and no log is shown; `docs/openapi.json` current; `/code-review` over the diff and `/security-review` by hand (the jobs route's reads through the connection, the allow-list, the leak tests); the completion file in `.claude/completions/`; ROADMAP row 28 to done.
Done when: `bun run check` and `bun run e2e` are run and their results stated plainly, with every failure named; the completion file lists what was not checked.
