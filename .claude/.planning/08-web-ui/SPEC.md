# 08 Web UI - Spec
Prefix: UI · Milestone: M2 · Status: building

## Goal
The "super easy" surface: connect GitLab, pick projects, get a pipeline MR, manage variables per environment, see sync and pipeline health - without reading docs.

## Scope
App shell + auth; onboarding/import wizard; variables editor; sync panel; pipeline setup wizard; pipelines dashboard; settings; e2e smoke.

## Non-goals
Marketing site, mobile layout beyond "usable", custom theming.

## Design
- React served via Bun HTML imports (D11), the typed client from API-5, TanStack Query for server state. Revisit the stack in UI-1 only if a concrete blocker appears.
- **Secrets are masked by default**; reveal is an explicit click that calls the audited reveal endpoint and auto-hides.
- Variables screen is an environment matrix: rows = keys, columns = environments, cells show inherited vs overridden.
- Plans/diffs render `+ ~ -` with key names only; there is no value column for secrets.
- Pipeline wizard: detect -> choose -> params form generated from the manifest schema -> rendered YAML diff -> Create MR.
- Accessibility: keyboard reachable, labelled controls, contrast-safe colours in light and dark.

## Acceptance
A new user signs in with GitLab, imports a project, creates a pipeline MR, adds variables to two environments, runs a sync plan and applies it, all in the browser against the mock backend (Playwright).

## Risks / human gates
Design direction (look and feel) needs a quick user check at UI-1 before screens multiply.
