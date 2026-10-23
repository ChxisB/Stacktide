# 29 Job nodes - Tasks

Gate for every task, from the repo root: `bunx biome format --write <touched folders>`, `bunx biome check .`, `bun run typecheck`, then the suites of the folders touched (`bun test --env-file=.env.example packages apps/api apps/cli`, `cd apps/web && bun test --env-file=../../.env.example`). Tests need Postgres on `localhost:5433`. Web tasks also run `bun run e2e` and, for the demo tasks, `bun run demo:shots` and the demo tests. Nothing here touches a real GitLab or cloud account (the mock GitLab only).

**Rule for every task: every existing test passes unchanged.** A test that has to change is a finding, written in LOG.md, not an edit made quietly. Every new CSS class gets a rule in `apps/web/src/styles.test.ts`. A layout fault is found by reading the picture, so each picture is read, not just asserted.

**Cuts.** A (NOD-1 to NOD-4) the nodes. B (NOD-5 to NOD-8) the chain inside one project. C (NOD-9 to NOD-12) across projects, the authorization question. NOD-13 delivers. B needs A; C needs B. Approve any prefix of that order.

## A. The nodes

### NOD-1 - Node layout as data  `[x]` S - deps: none
Do: `apps/web/src/job-flow-layout.ts` (no React, no DOM): `layout(jobs: {id, name, stage, status}[])` returns nodes (`id`, `column`, `row`, `x`, `y`), junctions (one between each two neighbouring columns) and edges (`from`, `to`, an SVG path as a cubic curve, ends at the arrow's tip), and the drawing's width and height, from constants. Columns follow the order stages first appear in the jobs given; rows follow the order within a stage; the same jobs in another order give the same output (sorted by id first).
Done when: unit tests: three stages give three columns; a stage of four jobs gives four rows; every node of a stage has an edge into the junction after it and one out of the junction before it; one stage has no junction; a job alone; an empty list is an empty drawing; the edges never end inside a node's box.

### NOD-2 - JobFlow component  `[x]` M - deps: NOD-1
Do: `apps/web/src/job-flow.tsx`: one `<ol>` per stage (heading with the stage's name) of `<li>` nodes placed by `layout`, under an `aria-hidden` SVG of the edges with arrowheads. A node: rounded square with the status mark from the existing glyphs (running turns, and not under `prefers-reduced-motion`), the name beneath in the code font (two lines, then an ellipsis, the full name in `title`), the time as `1m 12s`, a red ring and the reason for a failed one (`reasonIn`), the quiet look and "Failed, allowed" for an allowed failure, "Open job" through `webUrl()`. New classes get `styles.test.ts` rules. The box scrolls inside itself (`overflow-x: auto`).
Done when: web tests: every state shows its word and mark; a failed node shows its reason; an unsafe `webUrl` shows no link; the stages read as headed lists; a name of 120 characters is clamped and whole in `title`; a failed look keeps its state.

### NOD-3 - The Jobs panel draws nodes  `[x]` M - deps: NOD-2
Do: in `runs.tsx` the `Jobs` panel renders `JobFlow` in place of the stage list; the query, the key, `keepPreviousData`, polling, the truncated note, `ErrorPanel` and the retry are unchanged; the panel's width rules (`.jobs-host`, the container-query panel) keep the drawing inside the card.
Done when: the existing 13 job tests pass unchanged except where they read the old list's elements (each such change is a finding in the LOG, assertions kept as strong); a new test: the nodes of a pipeline in two stages are in two lists.

### NOD-4 - Demo shots for the nodes  `[x]` S - deps: NOD-3
Do: the demo shot of Status (`feature/billing` open) shows the nodes; `shots.e2e.ts` runs its `cutOff` check over the nodes and their box at 1280 and 390, both themes.
Done when: `bun run demo:shots` and `bun run e2e` pass; I read the four Status pictures and the failed node is visibly the failed one; a mutation (the box's `overflow-x` removed) fails the check.

## B. The chain inside one project

### NOD-5 - Triggers know their pipeline  `[x]` S - deps: none
Do: `packages/gitlab/src/pipelines.ts`: the bridge keeps `stage`, `webUrl` and a `downstream` of `{ pipelineId, projectId, status, webUrl }` (or null while there is none) next to `downstreamPipelineId`, which stays for `run-ingest` and `mr-plan`. The mock's bridges carry them; a helper makes a downstream pipeline in another mock project.
Done when: gitlab tests (seen failing first): a bridge with a same-project child, with a pipeline in another project, and with none; fields the parser does not name are dropped; the contract test passes against the mock; `run-ingest` and `mr-plan` tests pass unchanged.

### NOD-6 - The jobs answer has triggers and children  `[x]` M - deps: NOD-5, NOD-3
Do: `GET .../pipeline-runs/:runId/jobs` (guard `pipeline.read`, unchanged) also answers `triggers` (name, stage, status, webUrl, and `downstream`: pipeline id, state, `sameProject`, and for another project only its GitLab project number) and `children` (for each same-project child: pipeline id, state, jobs in the same ten-key shape, `truncated`). Caps: 200 jobs in all, 20 triggers, 5 children, no deeper; a child that is gone is left out and its trigger says so. Names and reasons clipped as now. A pipeline in another project is **not read** by this route. `bun run openapi`; counts in `spec.test.ts` and `authz.test.ts` if they move.
Done when: route tests (seen failing first): a pipeline with a trigger and a two-job child; the child's jobs have exactly the allow-listed keys (leak test with the trace, variables, runner and user on a mock job, as FLW-8); 201 jobs across both give 200 and `truncated`; a sixth child is not read; a child's own trigger is not followed; a trigger into another project answers its state and **the mock records no jobs request for the other project**; a gone child; the existing jobs tests pass unchanged apart from the answer's exact key list (a finding).

### NOD-7 - Nodes for triggers and children  `[x]` M - deps: NOD-6
Do: `JobFlow` draws a trigger as a node (its own mark, "Triggers" and the name) in its stage, an edge into the child's first column, and the child's jobs as a lane headed "Child pipeline #N"; a trigger into another project is a node saying "Pipeline in another project" with the state and no link yet. `layout` takes the lanes.
Done when: unit and web tests: a chain a trigger then two children's jobs; lanes do not overlap; a trigger with no child is a node alone; a state the web does not know still draws; the NOD-1..3 tests pass unchanged.

### NOD-8 - Demo for the chain  `[x]` S - deps: NOD-7
Do: the seed gives `acme/web`'s `main` (or one branch) a `deploy` job that triggers a same-project child of two jobs (`addDownstream`); `seed.test.ts` pins it; the shot opens it. Read first, and report in the LOG: whether the recorder gave the child its own row on Status.
Done when: `bun run demo:shots` and `bun run e2e` pass; `seed.test.ts` passes (seen failing first); pictures read at 1280 and 390, both themes.

## C. Across projects (approve separately: an authorization question)

### NOD-9 - A trigger into another project: its state  `[x]` S - deps: NOD-7
Do: the node for another project's pipeline shows its state and "Pipeline in another project" and nothing else; the answer carries GitLab's project number and the pipeline number, no name, path or address.
Done when: route test: with the connection able to read the other project, the answer still holds none of its name, path or address (leak test over the answer and the logs); web test: the node's words.

### NOD-10 - Find a run by its GitLab pipeline  `[x]` S - deps: none
Do: `GET .../pipeline-runs` takes an optional `pipelineId` and answers the run of that GitLab pipeline in that project (the same guard, `pipeline.read`; additive).
Done when: route tests (seen failing first): it finds the run; another project's pipeline id finds nothing; a stranger gets 404 and a reporter reads; `openapi` is current.

### NOD-11 - Expand into the other project  `[x]` M - deps: NOD-9, NOD-10, NOD-7
Do: in the web, a node for another project matches GitLab's project number against the projects the viewer can see; on a match it asks that project's run list for the pipeline and, when found, reads `.../:runId/jobs` there and draws the jobs as the next lane (headed with the project's name from the viewer's own list); on no match, or no run, it stays the state-only node, with the reason in words ("not set up here" or "not recorded yet").
Done when: web tests: a match draws the lane; no match draws only the state; a match with no recorded run says "not recorded yet"; **a viewer who can read only the first project never sends a request for the other project's jobs** (asserted on the requests); polling follows the lanes while any pipeline is going.

### NOD-12 - Demo across projects  `[x]` S - deps: NOD-11
Do: the seed gives `acme/web`'s `deploy` a trigger into `acme/api` (both imported) and records that downstream pipeline as a run of `acme/api` with jobs; `seed.test.ts` pins it; the shot shows the lane with the project's name.
Done when: `bun run demo:shots` and `bun run e2e` pass; pictures read at 1280 and 390, both themes; `seed.test.ts` passes (seen failing first).

## Delivery

### NOD-13 - Docs, review, delivery  `[x]` S - deps: the cuts you approved
Do: update the "Flow views" section of `docs/demo.md` (what a node and a lane are, that edges are the stage order and `needs` is not read, the caps, what a reader of one project sees of another); `docs/openapi.json` current; `/code-review` over the diff and `/security-review` by hand (cut C especially: no read of another project by a route that did not check it); the completion file in `.claude/completions/`; ROADMAP row 29 to done.
Done when: `bun run check` and `bun run e2e` are run and their results stated plainly, with every failure named; the completion file lists what was not checked.
