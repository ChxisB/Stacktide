# 37 Resources Hub - Tasks

Cuts: A (RSH-1..2, audit and design, no product code), B (RSH-3..5, the read route and client), C (RSH-6..9, the page), D (RSH-10..11, layout, docs, demo). RSH-2 is a human gate. Cut B can start once the tables of 34 and 35 exist; cut C waits for the approved design.

### RSH-1 - Audit: how the project page, deployments and environments fit  `[ ]` S - deps: -
Do: read-only. Write `docs/resources-hub-audit.md`: the routes and navigation in `shell.tsx` and `app.tsx`, what `projects.tsx`, `deployments.tsx` (the Deployments card) and `variable-envs.tsx` show, which `components.tsx` parts exist, which data each needs and from which route, and what `orch resource ls` and `orch deploy status` print. Settle questions 1 and 2 of the SPEC as a recommendation with the file it came from.
Done when: the doc lists each item with a file path; nothing is edited or run.

### RSH-2 - Design: the hub, the picker, the Destroy dialog, the Add resource drawer  `[ ]` M - deps: RSH-1 - human gate
Do: make the design in Claude Design (quickstart with `intent: "design"`; Carebell design system if listed), one design for this feature and feature 34's picker and Destroy dialog, with the repo rules of the SPEC, real labels from the code and invented values only. Record the link, date, skills used, what is settled and which content is sample in the SPEC's `## Design` section. Changes you ask for go into the same design by its URL.
Done when: you approve it. Blocked until then; RSH-6..9, ODE-16 and ODE-17 wait for it.

### RSH-3 - The overview route  `[ ]` M - deps: BLP-14, BLP-17, ODE-4
Do: `GET /organizations/:orgId/projects/:projectId/overview` (reporter, deny by default) returning the SPEC's structure from the tables, with `capabilities` from the forge seam and `lastDeploy` from feature 31's deployments (null where there are none). Pure read: no forge or cloud call.
Done when: route tests on the GitLab and GitHub mocks for two environments with four resources; a project with no resources; an outsider refused; the guard-coverage test green; OpenAPI regenerated.

### RSH-4 - Console links and the estimate cell  `[ ]` S - deps: RSH-3
Do: a pure function building `consoleUrl` from fixed templates for GCP and AWS (project or account id, region, resource name; every part from the closed charsets of feature 35); the monthly estimate per resource from the stored plan estimate of its stack (feature 16), null with a reason code on GitHub or when none exists.
Done when: table tests for each kind on both clouds; a name with `/`, `?` or `#` cannot reach the URL (it never passes the schema, and a test proves the builder refuses it too); estimate null on a GitHub project.

### RSH-5 - Client and hook  `[ ]` S - deps: RSH-3
Do: the method in `packages/api-client` and a query hook in the web app, refreshed when a run, deployment or proposal event arrives (the way the Deployments card is).
Done when: client test; a hook test with the mock client showing the refresh.

### RSH-6 - Web: the resources page  `[ ]` M - deps: RSH-2, RSH-4, RSH-5
Design: the approved design's page: environment strip and resource table.
Do: build with `PageHead`, `Card`, `Chips`, `StatusBadge`, `RowMenu`; state words with glyphs; empty states and the capability-aware empty cells (why a cell is `—`).
Done when: component tests for no resources, no pipeline, applying, failed, destroyed, no estimate on GitHub; no value other than the allowlist on the page (leak test); one `h1`.

### RSH-7 - Web: Add resource  `[ ]` M - deps: RSH-6, BLP-16
Design: the approved design's Add resource drawer.
Do: kind, cloud, name, the blueprint's few inputs from `GET /blueprints`, `uses`, the file preview, and the proposal link after sending; the button word follows the forge; 422 shows the key.
Done when: component tests for each kind, a refused input, a repeat (the same proposal), and the keyboard path; the drawer traps and restores focus.

### RSH-8 - Web: resource actions  `[ ]` M - deps: RSH-6, CLD-13
Design: the approved design's row menu and resource detail.
Do: Deploy, Promote, Roll back (existing routes of 31 and 36, with their approval asks), Open in console, Variables (link), Change inputs (reuses RSH-7 in edit mode, `PATCH`), Destroy resource (opens feature 34's flow for the stack). Each shows the route's own refusal sentence.
Done when: component tests that each action calls the one named route and shows a refusal verbatim; a test lists every route the page calls and fails on any write route not named in this task and RSH-7.

### RSH-9 - Web: environments on the page  `[ ]` M - deps: RSH-6, ODE-16, ODE-17
Design: the approved design's environment strip.
Do: mount feature 34's picker and status/Destroy dialog on this page; New environment, Extend, Destroy; link the page from the project list and the navigation as RSH-1 decided.
Done when: component tests for live, creating, destroying, failed, expiring and destroyed environments; the Destroy dialog cannot be confirmed without the typed name.

### RSH-10 - Layout, accessibility and design review  `[ ]` S - deps: RSH-7, RSH-8, RSH-9
Do: add the route to `PAGES` in `apps/web/e2e/layout.e2e.ts`; run `bun run e2e`, `web-design-guidelines`, and the accessibility scan and inspect on the demo (`bun run dev:db`, then `bun run demo`); list each difference from the approved design and fix or record it.
Done when: e2e green at 390 px in both themes; findings fixed or listed in `LOG.md`; any scan that could not run is named as not run.

### RSH-11 - Docs, demo and journey  `[ ]` S - deps: RSH-10
Do: `docs/resources.md` (what the page shows, where each cell comes from, what it will not do, why it is not Coolify), demo seed with a project of two environments and four resources, one journey test on each mock forge (add a resource, apply, deploy, see the URL).
Done when: `bun run check` and `bun run e2e` are green.

### Backlog (not broken down)
Organization-wide resources page, metrics and uptime, logs, alerts, per-resource cost actuals, resource tags and search.
