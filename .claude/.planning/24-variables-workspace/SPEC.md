# 24 Variables workspace - Spec
Prefix: VWS · Milestone: M5 · Status: done 2026-10-20 (planned and approved 2026-10-20, Q3 and Q4 as recommended; Q1 tags answered yes and built as VWS-12 to VWS-14; Q2 folders planned as feature 27, for approval) · Needs: 04, 22, 23

## Goal
Make variables and secrets pleasant to work with in the web app, in the way Infisical's secrets screen is: pick an environment, see one tidy list, search it, open a row for its details, add or import from the toolbar, reveal and download with care, and see what changed. Today the page is only a matrix (names down, environments across) where every cell carries its own buttons; it is good for comparing environments and poor for working in one.

## What the Infisical screen has, and what we do with each part
| In the screenshot | Here | Needs |
|---|---|---|
| Environment dropdown in the breadcrumb | An "Environment" select above the list | existing API |
| Search bar | Search over names (and plain values) of the chosen environment | existing API (filtered in the browser) |
| Name / Value table, key icon, masked dots | A Name / Value / Source table; secret and file values are a fixed `••••••••` (never the real length) | existing API |
| `${REF}` shown in yellow | A key that does not resolve gets a row naming the reference in a `mark` (VWS-3, from the resolved set's `issues`); a plain value as written, in the row's details, has each `${KEY}` in a `mark` (VWS-4, the by-id read). The list itself never shows a `${KEY}`: the resolver has filled it in. The `mark` uses the existing `--sun-tint`/`--warn` pair, no new token | existing API |
| Branch icon (override) | A source badge (Organization, Project, Environment) and "overrides the Project value" where a lower level has the same key | existing API |
| Comment icon | The description, shown as a note in the row details | existing API (read by id) |
| Row hover "..." and X, row click for a drawer | A row's name opens its details; **the actions stay visible** (feature 22/23 rule: no actions in menus or on hover): Edit, Override, History, Rotation, Delete, the same components as the matrix | existing components |
| "Add Secret" split button | Two visible buttons: "Add variable" and "Import" | existing components |
| Eye icon (reveal all), download icon | "Reveal all" (hides itself) and "Download .env" for the chosen environment | existing audited route `resolved-variables/values`; **human gate** |
| "71 Commits" | A "Changes" card: who changed which key, version and when, no values | a new read route; additive |
| Coloured tags with "+" | Tag chips on the row, a tag filter, tags edited in the details and the add form (VWS-12 to VWS-14; one colour, the existing `tag` class) | a `tags` column; additive |
| Folders (MICROSERVICE #1..3) | not built here: a new model, planned as feature 27 with an ADR | **decision Q2** |

The matrix stays as a second view, "Compare environments", because comparing is what it does well.

## Scope
A "Secrets" view beside the matrix (page keeps one URL; a view switch inside it); search; reference marks; row details; Add and Import in the toolbar; Reveal all and Download .env; a changes feed (route + card); Secrets as the default view once it can do everything the matrix can.

## Non-goals
- Tags and folders (decisions below). Personal overrides per user, secret approval flows (change requests exist, feature 11), dynamic secrets, secret referencing across projects.
- Actions in menus or on hover. A restyle of the matrix. Changing the encryption, scopes or `${REF}` rules (feature 04).
- A new dependency. A new table in the database.

## Design
- **Keep the markup, change the skin** (22/23): native `<table>`, `<label>`, `<button>`; tests find things by role and name; regions are named by their `Card` title. New classes get a rule in `styles.test.ts`, colours only as tokens in the three token blocks, and every new colour pair meets 4.5:1.
- **Read once per environment**: the list is `resolved-variables` of the chosen environment (the matrix already reads it per environment, so the same query key is shared). Description and version are read by id when a row is opened, so the list stays one request.
- **Secrets stay masked until asked**: the list shows plain values (as the API returns them) and the mask for everything else. A value is in the page only after a Reveal, for `REVEAL_MS`, and never in the query cache longer than that.
- **Bulk reveal is the audited export route**, not a new one: `GET .../resolved-variables/values` (guard `secret.reveal`, rate limited `reveal`, `no-store`, one `variable.reveal` audit row per secret with `via: export`, plus `variable.export`). The browser holds the answer in component state only, clears it on timeout, on a change of environment and on unmount, and builds the `.env` file in memory.
- **`.env` text** comes from the CLI's `dotenvLine` (quoting that `parseDotenv` reads back); VWS-8 moves it to `packages/core` so the CLI and the web share one.
- **Changes feed**: `GET /organizations/:orgId/projects/:projectId/variable-changes` over `variable_versions` joined to `variables` (key, kind, level, environment, version, actor, reason, time), cursor-paged like `audit-events`, guard `variable.read`. It carries no value. Read-only, so it writes no audit row (stated in `noAudit`, as `variable-search` does).
- **Environment choice** is component state (shortcut: not in the URL; the router is a bare hash, deep links are a later change).

## Acceptance
- Choosing an environment shows its variables in one table; typing in the search narrows it; "No variables match" says so.
- No secret value is in the DOM, a log line, an error, a download name or the query cache unless the person asked for it and for no longer than the reveal time; the tests prove it with the secret fixture value.
- Reveal all and Download .env each write the audit rows the route already writes (tested against the real route in the API tests that exist, and by checking the web calls only that route).
- Everything the matrix can do (add, edit, override, history, rotation, delete, import) can be done from the Secrets view; the matrix tests still pass, opened through "Compare environments".
- The Changes card shows who changed which key and when, and no response of the route holds a value (leak test).
- `bun run check` and `bun run e2e` are green; no test is weakened, skipped or deleted.

## Risks
- **Reveal all puts every secret of an environment into the browser at once**, and a downloaded file is outside our control (it sits on disk). Mitigations: it needs `secret.reveal`, it is rate limited, it is audited per secret, it hides itself, and the download says what it holds. This is a human gate and VWS-7 and VWS-8 need `/security-review`.
- Flipping the default view changes how every existing Variables test begins (one helper in `variables.fixture.tsx` opens "Compare environments"); the e2e journey gets the same step.
- The changes feed reads across every variable of a project: it must respect the caller's project role exactly as the list does (deny-by-default test in the authz matrix).
- A member without `secret.reveal` sees a 403 from Reveal all; the button must say so, not fail silently (tested).

## Decisions for you (nothing below is built unless you say so)
- **Q1 Tags.** Needs a forward-only migration (a `tags text[]` column on `variables`, default empty), create and patch bodies (at most 8 tags of 24 characters, `[a-z0-9-]`), a filter in the list and coloured chips. Three more tasks (db, API, UI), each small. Recommendation: yes, after the Secrets view is in, because tags are what makes a long list manageable without folders.
- **Q2 Folders.** A new model. A folder changes how a key resolves (`${REF}` paths), how sync targets, the CLI, import, snapshots and the matrix address a variable. That is a feature of its own with an ADR, not a task. Recommendation: not now; organization, project and environment scopes already group most things, and tags cover the rest.
- **Q3 Reveal all and Download .env.** Build as designed above, or leave them out. Recommendation: build them, with the guard, rate limit and audit that already exist.
- **Q4 Task order.** Secrets view first with the matrix as default until VWS-6, so no task leaves a screen that cannot do something it could before. Recommendation: as listed.
