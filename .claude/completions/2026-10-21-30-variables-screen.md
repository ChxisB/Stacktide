# 30 variables screen - done 2026-10-21 (not seen green end to end, see the gate)

The Variables page in the look of Infisical's secrets screen: a one-line toolbar, a table with hover actions and a ⋯ menu, an Environment menu with "All environments" as a matrix of marks and an open row, a quick-add row, Create / history / changes / details as side drawers, version history as a timeline, column menus, a toolbar for the matrix with an applies-to-all row, a select column with Delete selected, and one alignment-and-hover pass over the platform. Nothing is committed.

## What was built
- **A, the face (VUI-1..5).** Page head and one environment select, one-line toolbar, the table and its strip (path, Reveal all), row actions and the ⋯ menu (Copy value, Edit details, Add tags, Version history, Rotation, Delete), the quick-add row.
- **B, drawers and menus (VUI-6, 7, 13, 8, 14).** One drawer for details, history, Create, Import, Changes and the forms; the Add New menu; the Environment menu (filter, All environments, a box for each, Add environment as a centred dialog); Changes as a drawer, the page ending at the table.
- **C, All environments and the whole-page pass (VUI-9, 16, 17, 18, 15, 19, 10).** The matrix as marks with an open row (the lines hold the box's edge when it scrolls); column menus; the matrix toolbar and the applies-to-all row; the drawer's chrome; the timeline; alignment and hover (`demo:align` 0 findings); the demo shots and the layout journey.
- **D, selection (VUI-11).** A select box on each row and one in the header; a bar "N selected / Delete selected"; a confirm that lists each key and where it goes from; one bulk call for each level, narrowest first. Built on the later blanket go (it first waited for its own).
- **Delivery (VUI-12).** `docs/demo.md` "The Variables page"; `bun run demo:keys` (a keyboard-only walk of the 13 actions the old page had); this file; ROADMAP row 30.
- **No API, database, guard or dependency change** in any task. (`apps/api/src/routes/variables.ts` shows as modified in the working tree from earlier features; VUI work did not touch it.)

## Existing tests that changed path (each is a finding in LOG.md; every assertion kept as strong, none skipped or deleted)
- **VUI-8:** every test that picked an environment with `selectOptions` goes through the fixture's `envButton`, `openEnvs`, `showEnvs`, `showCompare`, `showSecrets`, `addEnvironment`.
- **VUI-9:** every test that clicked Edit, Delete, Override, Reveal, History or Rotation in a matrix cell goes through the open row's line (`editOf` and the like).
- **VUI-13 and VUI-17:** `variables.create`, `variables.drawer`, `variables.history`, `variables.test` open Create and Import through `addNew(user, item)` (Add New), not the two buttons under the matrix (the last two were found only now, with VUI-11).
- **VUI-7:** two `variables.drawer` tests rewritten (Add a variable and Import open in a drawer; Esc closes each).
- **VUI-14:** `variables.changes` `card()` clicks Changes and returns the drawer, so all ten tests read the drawer.
- **VUI-17:** `variables.quickadd` said "the matrix has no such row" and now says the matrix has it and what its value is called; `variables.create` likewise.
- **VUI-18:** every click on the drawer's "Close" in `variables.details`, `.history`, `.rotation` and the import test is "Close drawer".
- **VUI-15:** the history's wait is for the list "Versions of KEY", not a table; `versionsShown` and `rowOf` read list items.
- **VUI-11:** `rowOf` in `variables.fixture.tsx` skips the select column's cell; the list's column-header expectation is `["", "Name", …]` (a column was added on purpose).
- **Whole page:** `e2e/journey.e2e.ts` and `src/journey.test.tsx` add variables through Add New and fill the fields inside the drawer (the grid's quick-add has the same labels); `demo/shots.e2e.ts` opens a row with `tbody button[aria-expanded]`; `e2e/layout.e2e.ts` gained its checks (the first matrix check passed for the wrong reason and was strengthened, see VUI-10).
- Mutations were shown failing for the checks that mattered (VUI-10: matrix `overflow-x`, sticky names; VUI-11: the gate and `dryRun`; VUI-19: the alignment rules).

## Gate, stated plainly
- Typecheck and Biome: clean (the one existing info in `apps/api/src/limits.test.ts`).
- **`bun run check` exits 1** at its root test step: 5380 pass, **2 fail**, both known and not from this feature: `apps/cli/src/auth.test.ts` "orch login in the browser > answers once: a second request with the right state is too late"; `packages/db/src/stacks.test.ts` "syncStacks > a stack that is still there keeps its id, and each of its fields can change and change back". `check` joins its steps with `&&`, so its web step did not run.
- Web suite on its own: 804 pass, **1 fail**: `settings.test.tsx` "the sign-in methods on the settings page > giving one up asks first; keeping changes nothing; confirming ends it and the role it gave" (19 s; fails on HEAD too; cause not found). (The run before the last fix had a second failure, `journey.test.tsx`, which was mine and is fixed.)
- `bun run e2e` 9 of 9. `bun run demo:shots` 2 of 2 (every new picture read at 1280 and 390, light and dark). `bun run demo:align` 4 of 4, 0 findings. `bun run demo:keys` 1 of 1.

## Reviews
- **Security (by hand, copy value, generate, several-environment create):** nothing at 8/10 or above. Values reach the clipboard only, from the one audited read; `generate()` is the browser's CSPRNG; the grid's quick-add makes secrets only, one guarded and audited POST per environment. Not atomic across environments (said on the page).
- **Code review (by hand, the files this feature owns; the working tree mixes features 14 to 30, so a diff for 30 alone cannot be taken):** six findings, none a defect, listed in the VUI-12 LOG entry.

## Not checked
- **The keyboard walk is automated** (Playwright pressing Tab, arrows, Enter, Space, Esc, clicking nothing). Not a person, not a screen reader.
- Safari and Firefox; real GitLab-fed data (the demo's rows are seeded); a project with hundreds of variables or environments.
- VUI-11's boxes for a project maintainer (they see none, see below).

## Left out, on purpose
- Share secret (a public page) and Batch Edit; type-ahead and sub-menus in the row menu; an "only this environment" shortcut for dev to staging; the comment icon (VUI-3).

## Follow-ups for your decision
1. **The comment icon (VUI-3)** waits for your choice.
2. **"Only this environment" shortcut** for copying dev to staging: wanted or not.
3. **VUI-11 gate:** boxes show to org admins and owners only, because the access answer lists organization-level actions. A project maintainer who may delete sees none. Fixing it adds project actions to `GET /organizations/:orgId/access` (authz model: needs your go).
4. **VUI-11 against the task text:** the bulk route takes keys, not ids, and does not refuse deleting a variable another refers to.
5. **Rotation cannot be set from the page** (command line only; the panel says so).
6. **Row actions take 47 to 53 Tab presses to reach** (every row has several controls and there is no arrow movement between rows); a roving row would cut it.
7. **Container query units** in the open row (Chrome 105, Safari 16, Firefox 110).
8. The failing settings web test and the two failing root tests above.
