# 37 Resources hub - Spec
Prefix: RSH · Milestone: M5 · Status: planned 2026-10-23, waiting for your go (no product code written, **no design made yet**, see Design) · Needs: 22, 31, 32, 34, 35, 36 · Came from: "I want a powerful tool like Coolify, Space Cloud, Dokploy … to easily manage resources and deploy new ones in an all in one platform which is easy to manage" (2026-10-23)

## Goal
One screen per project that answers "what is running, where, and what can I do about it", on **GitLab or GitHub** projects and **AWS or GCP** resources: **Project → Environment → Resources**, each resource with its state, its URL, its last deploy and its monthly estimate, and the actions that belong to it: add a resource, deploy, promote, roll back, open the cloud console, edit variables, change inputs, destroy. This is the "all in one, easy to manage" part of the request; Coolify and Dokploy call it the dashboard.

It adds **one read route and one page**. Every action on it is a route that features 31, 34, 35 and 36 already provide; this feature adds no new way to change anything. That is deliberate: the page is the easy part, and it must not become a second path around the gates.

## What I read (2026-10-23)
- Coolify and Dokploy READMEs list what their dashboards do (applications, databases, domains, logs, backups, previews, notifications, rollback). **I did not see their screens**, only the feature lists, so nothing here copies a layout.
- This repository: `apps/web/src/` has `projects.tsx`, `deployments.tsx` (feature 31's card), `variable-envs.tsx`, `shell.tsx`; feature 32 (UI redesign) is delivered. RSH-1 reads how they fit together before the design is made.
- The design target for the Variables screen is the Infisical reference (memory note); it does not apply to this screen.

## Scope
A) Audit and design (a gate). B) One aggregate read route. C) The page: list, add-resource drawer, resource detail with actions, environment strip. D) Layout, accessibility, docs, demo.

## Non-goals
- Any new write: no direct cloud call, no console embedded, no shell or log tailing (Coolify has terminals and logs; we link to the cloud's console instead).
- Metrics, uptime graphs and alerting (backlog), per-resource cost actuals (only the estimate, and only where the forge supports it), team or billing views.
- A cross-project "all resources in the organization" page (backlog; the data would allow it).
- Showing a secret value, a connection string, a state address or a plan: only allowlisted public outputs (BLP-17).

## Design
**The page.** A project page section (or a route; RSH-1 decides from the existing navigation) with:
1. **Environment strip**: the project's environments as chips (`Chips`), each with its derived state word and glyph (live, creating, destroying, failed, destroyed) and, for ephemeral ones, the expiry with Extend. Actions: New environment (feature 34's picker), Destroy (34's dialog).
2. **Resource table** for the chosen environment: name, kind and cloud with region, state word and glyph, URL (a link, only if a public output exists), last deploy (status, time, short ref; `—` where the forge or resource has none), monthly estimate (`—` with a reason on GitHub). A row menu (`RowMenu`): Deploy, Promote, Roll back (services only), Open in console, Variables, Change inputs, Destroy resource (opens feature 34's flow for that stack).
3. **Add resource**: a `Drawer`: kind, cloud, name, the few inputs of that blueprint, `uses`, and a **preview of the files** that will be proposed, then "Open merge request" / "Open pull request" (the word follows the forge). The result is a link to the proposal, never a silent change.
4. **States to design**: empty project (no pipeline yet → link to onboarding), no resources yet, proposal open and waiting, applying, failed, destroyed, an environment on a forge without estimates or deployments, 390 px phone, light and dark.

**The read route.** `GET /organizations/:orgId/projects/:projectId/overview` (reporter, deny by default): environments with their derived state and expiry; each with resources `{id, kind, cloud, region, name, state, url|null, consoleUrl, lastDeploy|null, monthlyEstimate|null, stack}` plus `capabilities: {estimates, deployments}` from the forge seam so the page can say *why* a cell is empty. Built from the tables of features 31, 34 and 35 and stored estimates. **No cloud call, no forge call at request time** (the data is what the webhooks and runs already recorded), no variable value, nothing outside the allowlisted outputs. `consoleUrl` is built from fixed templates for the two clouds (project or account id, region, name); it is a link, not a call.

**Forge and cloud neutral by construction.** The route reads records; the forge differences (no estimate on GitHub, approvals observed) arrive as capability flags, not branches in the page.

**Actions go through the existing routes**: deploy and promote (31, 36), propose a resource (35), create and destroy an environment (34), variables (30). The page shows a refusal with the route's own sentence.

**Repo rules for the design** (they beat the design skills): colour only from the tokens in `apps/web/src/styles.css`; parts from `components.tsx` (`PageHead`, `Card`, `StatusBadge`, `Kpi`, `Chips`, `Drawer`, `Popover`, `RowMenu`, `Icon`); native `<table>`, `<label>`, `<button>`; 44 px targets; a status is a glyph plus a word; one `h1`; no place that shows a secret value; no new token, font or dependency without an open question.

## Design (screens)
**Not made yet, and I am deviating from the skill's usual order.** The skill asks for the design pass before the gate in Phase 1 for a screen with nothing beside it to copy. This is such a screen. I did not make it now because (1) it is the same design as feature 34's picker and Destroy dialog (one pass is cheaper than two and keeps them consistent), and (2) which cells exist depends on your answers to questions 1 to 3 below, so a design now would be redrawn. RSH-2 is the design task and a gate: it is made in Claude Design with the repo rules, the link goes into this section, and you approve it before RSH-6 starts. **Say "design it now" and I will do it first**, for the hub, the picker, the Destroy dialog and the Add resource drawer in one go.

## Acceptance
- `GET …/overview` returns the structure above for a project with two environments and four resources on the mock GitLab **and** the mock GitHub, a reporter can call it, an outsider cannot (guard-coverage test), and a leak test finds no variable value, state address or non-allowlisted output.
- The page lists the same resources as `orch resource ls` (a test compares the route and the CLI output).
- Add resource opens exactly one proposal (MR or PR, by forge) and shows its link; Deploy, Promote and Roll back call feature 31's and 36's routes and show their refusals verbatim.
- On GitHub the estimate cell says why it is empty; on a project with no pipeline the page says "set up the pipeline first".
- `bun run e2e` (390 px, both themes) is green with the new route in `PAGES`; the accessibility scan and `web-design-guidelines` ran on it, or are named as not run.
- Not claimed: that any resource exists in a real cloud. That is BLP-21, CLD-15 and ODE-19, human gates.

## Risks / human gates
- **RSH-2 (the design)** is a human gate: nothing is built before you approve it.
- **The page can become a second path around the gates.** Mitigation: it adds no write route (acceptance above is a test that lists the routes the page calls).
- **Stale records.** The page shows what webhooks and runs recorded; a resource changed in the cloud console shows only when drift detection (feature 10) runs. The page says "as of" with the time of the last run.
- **Depends on four unbuilt features.** It cannot be built before 34, 35 and 36 have their routes; the order is 35 → 36 → 34 → 37.
- **Scope.** A dashboard invites additions (logs, metrics, terminals). The non-goals above are the line.

## Open questions (recommended answer first)
1. **Where it lives.** A section on the existing project page (recommended: no new nav item) or a new top-level "Resources" route?
2. **First view.** One environment at a time with chips (recommended) or all environments in one grouped table?
3. **Console link.** A fixed template link to the cloud's console (recommended) or none in the first cut?
4. **Cost cell.** Show the estimate where it exists, `—` with a reason elsewhere (recommended), or leave cost off the page?
5. **Organization-wide view.** Backlog (recommended) or a second page now?
