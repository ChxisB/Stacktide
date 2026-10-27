# The demo

One command starts the real API and the real web page over a throwaway database, fills them with a believable organization (Acme) and gives you one link that signs you in. It is for showing the platform: a live walkthrough, a screen share, a screenshot for a deck.

```bash
bun run dev:db     # a Postgres on 127.0.0.1:5433 (needs Docker), or point DATABASE_URL at any Postgres you can create databases in
bun run demo       # prints a sign-in link; open it
```

Stop it with Ctrl-C: the demo's database is dropped, and nothing is kept between runs. `DEMO_PORT` moves it (default `3200`; the sign-in link is on the next port).

## What you will see
- **Projects**: `acme/web` and `acme/api` imported from GitLab and `acme/mobile` from GitHub (the Forge column says which); `acme/docs` is on GitLab but not imported, so the import has something to offer. The GitHub project is there to show the badges and the screens that name the forge: nothing in the demo runs a workflow on it.
- **Variables**: an organization secret, project variables, and per-environment values for `dev`, `staging` and `production`. Every value is invented; the secrets read `demo-not-a-real-secret-...` and are never shown. How the page works is under [The Variables page](#the-variables-page).
- **Status**: the newest pipeline of eight branches in every state. Retry on a failed or canceled one works. **Jobs** opens a pipeline as step-by-step nodes by stage (`feature/billing` has one that failed, with its reason). `main`'s newest pipeline also starts two others: a child pipeline of `acme/web` and a pipeline of `acme/api`, each drawn as a row of nodes to the right.
- **Deployments** (a card under Status, for `acme/web`): dev, staging and production, each with what is deployed and its numbers for the last 30 days. Production's newest attempt failed and staging's failure was fixed 10 minutes later. **Promote** and **Roll back** open a dialog that shows the plan; GitLab is the mock, so nothing is deployed whatever you press. See [deployments](deployments.md).
- **State**: two Terraform stacks with their versions and resources.
- **Findings**: four, one of each severity.
- **Sync**: a target that was applied once and has drifted by one change since. The strip at the top of its card shows variables, the three environments and the target. Plan it and apply it from the page; within a few seconds it reads "In sync". That is the real plan, the real worker and the real drift check.
- **Resources** (`acme/web`, through the CLI and the API; there is no page yet): one of each kind from the [resource catalog](resource-catalog.md) on GCP in `staging`: a network, a Postgres, a bucket and a service that uses all three. Each is a merge request on the mock GitLab, so none has been applied; the service carries an invented link, as a finished plan would. Try `orch resource ls` and `orch resource show staging-api-service`.
- **Settings and Organizations** are the real pages over the same data: the connection, the `linux-runners` worker pool and the API tokens. The connection's address is a local port, because GitLab is the mock (below).

## The Variables page
One project, one environment at a time, in the look of a secrets manager. Everything is a real call to the real API; every change is audited.
- **The list** (one environment): a search, a tag filter, a download icon (`.env` of the environment), **Add New** and a table of Name, Value and Source. Values of secrets show as dots; **Reveal all** shows every value of the environment for 15 seconds (an audited read), **Changes** opens who changed what, newest first. Each row has **Edit**, a copy icon and a **⋯** menu (edit details, add tags, version history, rotation, delete).
- **The Environment menu** (under the title) picks one environment, ticks several, or ticks **All environments**; **Add environment** is in it. All ticked is the **matrix**: a mark where an environment has the key (a tick), has not (a circle) or cannot resolve it (a cross). A key's arrow opens its line for each environment; a line opens the details drawer. Each column has a **⋯** menu (copy the slug, download its `.env`, view its changes). The row at the foot of the matrix makes a secret in every environment shown.
- **Add New** has two items: **Add a variable** (a drawer: name, value, the environments it applies to, advanced options) and **Import variables** (paste or choose a file, preview, apply).
- **Drawers** open from the right and close on Esc or the X; focus goes back to what opened them. A variable's details drawer has its value (revealed one at a time, audited), description and tags, kind, source, version, and **Edit**, **Override**, **History** (every version, with **Restore version**), **Rotation** (switch on, rotate now) and **Delete**.
- **Select and delete**: an organization admin or owner sees a box on each row and one in the header. Choosing rows shows "N selected" and **Delete selected**, which lists each key and the level it goes from, and asks. Nothing is deleted until the drawer's **Delete variables** is pressed.
- **A phone**: the toolbar's search is a row of its own, the tables scroll inside their cards (the names stay at the left of the matrix), and a drawer is the whole width.
- Every control is reachable by Tab. `bun run demo:keys` walks the page with the keyboard alone: add, import, edit, delete, reveal one and all, download, tags, history and restore, rotation, override, changes and add environment.

## Flow views
Three read-only views draw how things connect. None of them changes anything; each has the same facts as words beside the drawing.
- **Sync strip** (a sync target's card): the project's variables, one line for each environment the target maps (`dev → development`), and the target. With a plan open each line carries that environment's counts; without one the drift totals show once, under the strip. A plan line for an environment the target does not map is counted on the target's box, not lost.
- **Jobs** (Status, a button on each row): the pipeline drawn as nodes, a column for each stage in the order the stages first appear. A **node** is a square with a mark and word for the state, the job's name under it, how long it took, why a failed one failed, and "Open job" (to GitLab; no log is shown here). The same jobs are also real lists, one `ul` for each stage, so a screen reader walks them as lists; the drawing scrolls inside its box when it is wider than the card. The **lines are stage order, not `needs`**: every job of a stage points into a junction and out to every job of the next stage. GitLab's job list does not give `needs`, so a job that needs only one earlier job is still drawn as waiting for the whole stage.
  - **Triggers**: a job that starts another pipeline (a bridge) is a node of its own, marked "Triggers". A child pipeline of the **same project** is a **lane**: its jobs are drawn to the right under the heading "Child pipeline #N", one lane under another, with a line from the trigger. Only one level is drawn: the triggers of a child pipeline (or of a pipeline of another project) are not read, so they are not drawn.
  - **A pipeline of another project** is drawn as a lane only when you can see that project: its GitLab project number is matched against the projects in **your own project list**, and the run is looked up in that project, which the server checks again with the right to read pipelines there. The lane is headed with the project's name and the pipeline's number (`acme/api #50`). Otherwise the node is the state alone, with the reason in words: "Not set up here" (no project of yours has that number), "Not recorded yet" (the project is here but the platform has not seen that pipeline, or it ran on another GitLab), or "Could not read its jobs". **What one project's reader learns of another:** the other pipeline's state and the GitLab numbers of its project and pipeline, and nothing else (no name, path, address or job) unless their own list holds that project. A reader of project A with no access to B can therefore see the state of B's downstream pipeline.
  - They are **read from GitLab when the row is opened**, through the connection that last read the pipeline, and are never stored; they are looked at again every few seconds only while the pipeline, or one of the pipelines it started, is still going, and not at all once the row is closed. Needs the right to read pipelines. At most 200 jobs in all (the parent's and its children's together), 20 triggers and 5 child pipelines are shown, and it says when there are more; which 200 is GitLab's choice (newest first, so a pipeline of over 200 jobs shows its latest stages). Jobs are ordered oldest first by job number, which is how a pipeline runs: GitLab lists newest first and names no stage order, so a job made again by a retry sorts after the jobs of the later stages.
- **Show order** (Plan runs, under a plan's stacks): the stacks of the run as boxes in columns, each waiting for the ones on its left, with the state of each. `dependsOn` and the column (`wave`) are worked out when the run is read, from the **stacks registered for the project**, which are the default branch as last scanned, **not the commit the run planned**. So the drawing can be out of date: after a merge request changes which stack uses which, or after stacks are added or removed, until the next scan. A stack the registry does not have sits in the first column with no lines; a run of more than 60 stacks says the graph is not shown. **Not yet seen on a live install or in the demo:** nothing outside the tests fills the registry of stacks today (FLW-4, blocked in `.claude/.planning/28-flow-views/LOG.md`), so a plan run has no lines and "Show order" is not offered until it does.

## What is real and what is not
| Real | Not real |
|---|---|
| The API, the database, authorization, audit, sealing of secrets, the job worker, plan and apply of a sync, the drift check | **GitLab and GitHub are mocks** (the ones the tests use; the demo's GitHub token is invented and never leaves the machine): no pipeline or workflow runs, so the runs on screen are seeded rows and their links go nowhere you can open |
| The web page you would deploy | Nothing is read from your machine; every name and value is made up |

Say that in a demo before someone asks where the pipeline's logs are.

## Pictures of every page
```bash
bun run demo:shots
```
Starts its own demo on port `3210` (`DEMO_PORT` moves it), signs in, visits all ten pages in the dark and the light theme at 1280 wide and again at 390 wide (a phone), with the phone menu open over Home, and writes one PNG for each to `apps/web/demo/shots/` (not committed). It is also a check: it fails if a page crashes, scrolls sideways, logs a console error or makes a request the server refuses. It needs the Playwright browser (`cd apps/web && bunx playwright install chromium`, once) and the same Postgres as the demo.

## Safety
- Both servers bind `127.0.0.1` and there is no setting to change that. The sign-in link issues a session for the demo owner **without a GitLab sign-in**, which is only acceptable because nothing here is real. Do not put it behind a tunnel or a proxy, and do not reuse the code for anything that holds real data.
- Anything on the machine that can reach the link's port can sign in as the demo owner and see the fake data.
- Cookies ignore the port: opening the sign-in link replaces the session cookie of any other copy of the platform you have open on `127.0.0.1` (your dev app, for one), so you are signed out of it. Use a private window for the demo, or sign in again afterwards.
- A hosted, public demo is not built: it would need a read-only demo sign-in, which is a change to the sign-in model and a decision of its own.

## How it is made
`apps/web/demo/seed.ts` fills a backend from `apps/web/src/testing.tsx` (the one the screens' tests use) through the API client wherever a route exists; the pipelines, state versions and findings have no route to create them, so they are written to the database directly. `apps/web/demo/server.ts` is the entry. It imports the tests' backend, which needs the web app's dev dependencies, so it is not in the container image.
