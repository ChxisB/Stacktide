# 29 Job nodes - Spec
Prefix: NOD · Milestone: M5 · Status: approved 2026-10-21 with the recommended answers to every question (feature 30 cut D, VUI-11, waits for its own go) · Needs: 28 · Came from: feature 28's Jobs panel read as a plain list; "can the pipeline jobs not look like the n8n nodes, step by step" and "if one project passes the pipeline to another, will the whole pipeline show?"

## Goal
Draw a pipeline's jobs the way n8n draws a workflow: a node for each job, left to right by stage, curved lines with arrowheads from one stage to the next, the state on every node, a failed node saying why. A trigger job (GitLab calls it a bridge) is a node too, and the pipeline it starts continues to its right, so one picture shows the chain, not only the first pipeline.

## What shows today (read from the code on 2026-10-21; not run against a real GitLab)
| Case | Today | Why |
|---|---|---|
| The jobs of the pipeline itself | A list by stage (feature 28's panel) | `GET .../pipeline-runs/:runId/jobs` reads `pipelines.jobs` |
| The trigger job that starts something else | **Not shown** | GitLab does not list trigger jobs among a pipeline's jobs; they are a separate call (`/bridges`) the panel never makes |
| A child pipeline in the same project | **Not shown in the panel.** IaC runs do read it (`readPipeline` in `run-ingest.ts`), and the webhook handler folds a same-project child into its parent's run (`sourceProjectId === projectId`) | the panel and the run recorder are separate code |
| A pipeline in another project (a multi-project trigger) | **Not shown.** The bridge parser keeps only `downstream_pipeline.id` and drops the project, so `readPipeline` reads that pipeline id against *this* project, GitLab answers not found, and the code skips it on purpose (its comment says so) | `packages/gitlab/src/pipelines.ts` `bridge` |
| That other project's own run | Its own row on **its** Status page, if that project is imported here and its webhook is set up; nothing links the two | the run recorder does not look at `source_pipeline`; so a same-project child probably also gets its own row (not tested) |

So the answer to "will the whole pipeline show" is: only the first project's own jobs, today. This feature changes that in two steps, and the second step is the one with a security question.

## Scope
- **Cut A, the look (NOD-1..4).** `job-flow-layout.ts` turns jobs into columns by stage and curved edges with arrowheads, through a small junction dot between two stages. A `JobFlow` component draws it: a node is a rounded square with a large status mark (a running one turns, unless the person asked for less motion), the name under it in the code font, the time under that, a failed one in a red ring with its reason; "Open job" under the name. The nodes are real list items in a list per stage, so a screen reader reads stages and jobs; only the lines are hidden. It replaces the stage list in the Jobs panel; the query, the polling, the 200-job cap and its note, the error panel and the retry stay as they are. At phone width the drawing scrolls inside its own box.
- **Cut B, the chain in one project (NOD-5..8).** The bridge parser keeps the downstream pipeline's project, status and address. The jobs answer gains `triggers` (each with its downstream pipeline) and `children` (the jobs of each same-project child pipeline). The picture continues to the right of the trigger node with a lane heading "Child pipeline #N". One level deep: a child's own triggers are nodes with a status and a link, not followed.
- **Cut C, across projects (NOD-9..12).** A trigger into another project is a node with the downstream's state. If that project is imported here **and you can read it**, its jobs continue the picture, read through that project's own route and guard; otherwise it says "Pipeline in another project" and shows nothing else.
- **Delivery (NOD-13).**

## Design
- **Edges are the stage order.** GitLab runs a stage when the one before it has finished, so a line from every node of a stage into a junction and from the junction to every node of the next is the real rule for a pipeline without `needs`. The jobs REST answer does not carry `needs`, so a pipeline that uses it (a DAG) is drawn stage by stage, which can show a wait that is not there. Reading `needs` takes GitLab's GraphQL API; not in this feature. The doc says so.
- **No new storage, no migration.** Everything is read live from GitLab when a row is opened, as feature 28 does, and never kept.
- **Same caps, shared.** At most 200 jobs in all across the pipeline and its children, 20 triggers, 5 child pipelines, one level of nesting; a cap that is hit says so (`truncated`).
- **Other-project jobs are read through that project's own route.** The web finds the other project among the projects the viewer can already see (matching GitLab's project number), asks that project's run list for the pipeline (a new optional `pipelineId` filter on the list route, additive), and then calls the existing `.../:runId/jobs` there. The guard on that project decides, the standard way: this project's route never reads another project, and the viewer's right to read it is checked, not assumed. The cost: the other project needs a recorded run of that pipeline (its webhook has arrived); until then the node shows only a state.
- **What a viewer of this project learns about another one:** the downstream pipeline's number, GitLab's project number and its state (a word), from the bridge of a pipeline they may read. Not its name, path or address, unless they can read it too.

## Non-goals
Logs (feature 28's answer stays: "Open job" goes to GitLab); drag, zoom or editing; `needs` edges; following child pipelines deeper than one level; drawing the registry-based run graph (feature 28 cut A, FLW-4) in the same look (it is blocked, and restyling it would change its tests; a follow-up once FLW-4 is decided); a view of a whole pipeline on the Pipeline page; retrying one job; a canvas library; building anything before you approve.

## Acceptance
- A pipeline with jobs in three stages is drawn as nodes in three columns with arrowed lines; every state has a word and a mark; a failed node shows its reason; the list is readable without the picture.
- With cut A only, every existing Status and Jobs test passes unchanged except those that read the old list's markup, which are written up as findings.
- A pipeline whose `deploy` triggers a child pipeline of two jobs shows the trigger node, then the child's two nodes in a lane; the jobs answer holds exactly the allow-listed keys (leak test); caps are tested.
- A trigger into another project: with no right on that project the picture shows "Pipeline in another project" and a state, the mock records **no** read of the other project's jobs by this project's route, and nothing of that project's name, path or address is in the answer.
- With the right on both, the other project's jobs continue the picture, and a request made as a user who can read only the first project never reaches the second project's jobs.
- `bun run demo:shots` shows the nodes (and the chain) at 1280 and 390 in both themes; I read the pictures; the page does not scroll sideways, and no node is cut off by its box except by its own scroll.
- No secret, token or trace in any answer, log or audit row.

## Risks / human gates
- **Cut C is an authorization question** (what a reader of one project may see of another). The design leans on the existing guards and shows less when in doubt, but it is a change to what the Jobs read exposes, so it is yours to approve (question 1). Cuts A and B do not touch it.
- **Not verified on a real GitLab:** the shape of `downstream_pipeline` (project, status, address) is from GitLab's documentation, not a live answer; the same holds for the order of jobs (feature 28's note). The contract test against the mock covers the mock only.
- **A same-project child may also be its own row on Status** (the recorder ignores `source_pipeline`); if so, a branch's "latest pipeline" can be a child. Not part of this feature; NOD-8 looks at it with the demo and reports.
- **Many nodes.** A pipeline of 200 jobs is 200 nodes; the box scrolls and the cap holds; it is not pretty and it does not need to be.

## Open questions (answer at approval)
1. **Across projects:** show a trigger into another project as a node with its state only (cuts A and B, NOD-9 is the state), and add the expand-when-you-can-read-it step (NOD-10..12) as well (recommended); or only the state, never the jobs; or skip other projects altogether?
2. **Edges:** stage to stage through a junction (recommended), or read `needs` through GitLab's GraphQL API for a true DAG (a second read path; its own feature)?
3. **The old list:** replaced by the nodes, kept as the hidden text alternative (recommended), or offer a "List / Nodes" switch?
4. Logs stay out and "Open job" goes to GitLab (recommended, as feature 28 decided), or build a log view now?
