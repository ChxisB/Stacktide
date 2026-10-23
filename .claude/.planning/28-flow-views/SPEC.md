# 28 Flow views - Spec
Prefix: FLW · Milestone: M5 · Status: approved 2026-10-20 with the recommended answer to each open question, building · Needs: 09, 05, 22, 23 · Came from: six n8n editor screenshots ("how neat they are, and how the flows look"), ranked ideas 1 to 3

## Goal
Show the platform's own flows as flows, the way n8n shows a workflow: boxes with a status mark, lines between them, a count on a line. Three places, read-only, no canvas library:
1. **Run graph.** The stacks of a plan as boxes in columns (the order they run in) with a line from each stack to the stacks that wait for it.
2. **Job panel.** Open a pipeline on the Status page and see its jobs by stage, with a status, a duration and a link. (n8n's "Latest logs" pane, without the logs.)
3. **Sync strip.** The Sync card's `Environments: dev → development` sentence as a drawn flow: Variables → environment mapping → target, with "2 to create, 1 to change" on the line.

## What is taken from n8n, and what is not
| n8n | Here | Note |
|---|---|---|
| Nodes with a check mark and a label, curved edges, a count on an edge | Run graph, Sync strip | FLW-2, FLW-3, FLW-5 |
| The Latest logs pane: a step list with a duration and a detail view | Job panel (list, durations, link; **no log text**) | FLW-7..9; logs are a separate decision, see non-goals |
| Dragging, zoom and pan, a floating toolbar, "Test workflow", the Chat dock, Editor/Executions tabs | **not taken** | these edit or run a graph; ours are read-only views over data that lives in the repository and GitLab |

## Found by reading (2026-10-20)
- **Correction, found while building FLW-4 (2026-10-20): the `stacks` table is empty in a real deployment.** Its only writer is `syncStacks` (`packages/db/src/stacks.ts`) and nothing outside tests calls it; the MR plan, the drift check and apply scan GitLab live (`scanStacks`) and never store the result. So the sentence below that the scan keeps `stacks.depends_on` was true of the intent (IAC-1) and not of the code, and question 2's recommended answer (read the registry) draws nothing outside tests. The manual run route also checks names against that table. Decision needed; see LOG.
- **Stack dependencies exist in the database, not in a run.** `stacks.depends_on` (text[]) is kept by the scan (`packages/db/src/schema/stacks.ts`). `run_stacks` has no `dependsOn`; a run names its stacks and the create route checks the names against `listStacks`. No route returns `dependsOn` today. `packages/iac/src/graph.ts` (`buildGraph`, `waves(subset)`, `GraphError`) has no imports and is already used by `mr-plan.ts` and `pipeline-gen.ts`.
- **A plan run is not a pipeline run.** `runs` (plans, `/runs`, shown in the "Plan runs" card) holds ref, sha, MR iid and its stacks; `pipeline_runs` (GitLab pipelines, `/pipeline-runs`, shown in "Latest pipelines") holds GitLab's pipeline id. Nothing stores which pipeline made a plan, so the graph and the job panel cannot be joined by an id. They stay on their own cards.
- **Jobs are read but never returned.** `gitlab.pipelines.jobs()` is called by `pipeline-runs.ts` (to name the first failed job), `run-ingest.ts` and `secret-scan.ts`; no API route returns a job list. The parsed job (`packages/gitlab/src/pipelines.ts`) has id, name, stage, status, allowFailure, failureReason and webUrl, **no start, finish or duration**. There is no job log call in `packages/gitlab`.
- **Job names carry the stack**: generated pipelines name jobs `plan:<stack>`, `estimate:<stack>`, `summary:<stack>`, `import:<stack>`, `apply:<stack>` (`packages/iac/src/pipeline-gen.ts`). The first cut groups by GitLab's stage and does not parse names.
- **The Plan runs card already lists a plan's stacks** (`<ul class="plan-stacks">` with a status badge, DNS tag, lint and policy words). The graph is added beside it, not instead of it.
- **Sync data for a strip is on the page already**: `target.environmentMapping`, the drift counts (totals for the target) and a plan's lines (each has a `scope`). No test pins the `Environments:` sentence.
- **The web may import only types from `@orch/core`**; runtime shared code must be a no-import subpath module. So the order (waves) is worked out in the API and sent, and the web only draws.

## Scope
- **Run graph (cut A).**
  - API: each stack of a run answer gains `dependsOn` (names, only those in the same run) and `wave` (0-based), worked out at read time from the project's registered stacks with `buildGraph(...).waves(runStacks)`. A name the registry no longer has gets no edges and wave 0. A registry graph that does not build (a cycle, an unknown name) gives wave 0 and no edges for every stack and never a 500.
  - Web: a pure layout function (waves to columns, names to rows, fixed box size, edge paths as numbers, no DOM measuring) and a `RunGraph` component: an SVG of curved edges under HTML boxes (icon and word for the state, never colour alone; the DNS tag). It sits in a "Show order" disclosure under a plan's stack list when the plan has at least one edge. A visually hidden list says "<stack> waits for <stack>". The box row scrolls inside its own container at phone width.
  - A plan with more than 60 stacks keeps the list and shows no graph (stated in the UI).
- **Sync strip (cut B).** `SyncFlow` replaces the `Environments:` paragraph on a target's card: a Variables box, one line per mapped environment (`dev → development`), the target box. With a plan open each line shows that environment's counts ("2 to create, 1 to change"), from the plan's lines by scope; with none, the drift totals are shown once under the strip. The same words stay as text, the drawing is `aria-hidden`.
- **Job panel (cut C).**
  - `packages/gitlab`: a job also carries `startedAt`, `finishedAt`, `duration` (all nullable); the mock server's jobs gain them.
  - API: `GET /organizations/:orgId/projects/:projectId/pipeline-runs/:runId/jobs` (guard `pipeline.read`) reads the pipeline's jobs from GitLab with the connection that last read the pipeline (as retry does) and returns an allow-listed list: id, name, stage, status, allowFailure, failureReason, duration, startedAt, finishedAt, webUrl. At most 200 jobs, with `truncated`. No log text, no variables, no runner, no user, no commit.
  - Web: each row of "Latest pipelines" gets a "Jobs" button (`aria-expanded`); opened, it shows the jobs by stage with a status mark, the duration (`1m 12s`) and "Open job". It reads only when opened and looks again only while the pipeline is going.
- **Demo and journeys.** Each cut ends with the demo showing it, a shot read at 1280 and 390 in both themes, and the layout journey asserting no page-wide horizontal scroll.

## Non-goals
Dragging, zoom and pan, a toolbar, editing a graph, "Test workflow", a chat dock; **job logs** (see question 4); joining a plan run to its pipeline or a job to its stack; a graph of the whole project's stacks outside a run (the registry's own picture is a follow-up); "Uses / Used by" `${REF}` lists in the variable details and a project-scoped tabbed page (ideas 4 and 5, each its own feature); a graph or chart library; building anything before you approve.

## Acceptance
- A plan of three stacks in a chain shows three columns and two lines; a diamond shows three columns, two stacks in the middle; a stack with no dependencies is in the first column alone or with others; status is readable with colour removed.
- `GET .../runs` and `.../runs/:runId` answer with `dependsOn` and `wave` on each stack and **nothing existing changes** (the existing run tests pass unchanged apart from the extra fields in an exact key list, written in LOG.md as tags were).
- A Sync target with two mapped environments draws two lines; with a plan open each carries its counts; the drift totals show otherwise; the words `dev → development` are still on the page.
- Opening a pipeline on Status lists its jobs by stage with durations; a failed job shows GitLab's reason; nothing is read until a row is opened; a deleted connection shows the API's message and changes nothing.
- No log text, secret or GitLab field outside the allow-list appears in the jobs answer (an exact key list test over a mock job that carries extra fields).
- At 390 wide no page scrolls sideways; a wide graph scrolls inside its box; both themes read (Playwright journey and a shot).
- `bun run openapi` differs by additions only; no migration.

## Risks / human gates
- **A GET that asks GitLab** (cut C): any `pipeline.read` holder causes a read of that pipeline's jobs through the organization's connection. Same connection and same trust as retry; the answer is an allow-list, capped, read only when a row is opened. It gets `/security-review` by hand (FLW-11). No human gate unless you want logs (question 4).
- **The registry is not the run's commit.** `dependsOn` comes from the last scan of the default branch; a merge request that changes a dependency shows the old order until it merges. The UI says "As registered on the default branch". A stored copy on `run_stacks` (an additive migration) is the upgrade (question 2).
- **Layout is not testable in happy-dom.** The layout is a pure function with tests; overflow and wrapping are asserted in the Playwright journey (FLW-4, FLW-6, FLW-10).
- **Poll load on GitLab** (cut C): one jobs read per opened running pipeline every `POLL_MS`; stops when the pipeline finishes or the row closes.
- **Size.** 11 tasks in three independent cuts; each leaves the gate green and can be approved or dropped alone.

## Open questions (answer at approval)
1. **Where do jobs come from?** Read from GitLab when a row is opened (recommended: no migration, never stale, one call per open), or stored by the worker in a table (a migration, works when GitLab is down, can be stale)?
2. **Where does `dependsOn` come from?** The registered stacks at read time (recommended: no migration, may differ from the run's commit), or a copy stored on `run_stacks` when the run is made (an additive migration, exact, older runs have no graph)?
3. **Where does the graph sit?** In a "Show order" disclosure inside each plan row of "Plan runs" (recommended), or one larger graph above the table for the newest plan?
4. **Logs.** Confirm they stay out: a trace call in `packages/gitlab`, redaction of what a job prints, a leak test and your sign-off make it a feature of its own.
