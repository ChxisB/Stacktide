# 30 Variables screen - Spec
Prefix: VUI · Milestone: M5 · Status: approved 2026-10-21 with the recommended answers to every question (feature 30 cut D, VUI-11, waits for its own go) · Needs: 22, 23, 24 · Came from: nine Infisical screens sent 2026-10-21 with "the environments area doesn't look neat like infisical ... I want to get close to replicating these"

## Goal
Make the Variables page look and work like Infisical's secrets screen: one tidy toolbar, one table whose rows have quiet hover actions and a menu, the same screen for one environment or **All environments** (a check mark per cell, not a value), and the rest (create, history, changes) in side drawers instead of cards stacked down the page. Behaviour that exists today stays; this is mostly the face, plus three small things Infisical has that we do not (create in several environments at once, a quick-add row, a value generator).

## What you sent, what is here now, what changes
Read from the nine screens and from `apps/web/demo/shots/variables-dark.png` (2026-10-21). "Here" is the Variables page after feature 24.

| Infisical | Here now | This feature |
|---|---|---|
| One toolbar line: environment select, wide search with an icon, a filter button, a download button, "Add New" | Five labelled fields and four text buttons that wrap onto two lines; the project select above them; a "Secrets / Compare environments" chip row above that | One line (wraps to two on a phone): environment, search, filter (tags), Download .env, Import, **Add a variable** (VUI-2). Project select moves up beside the page title (VUI-1) |
| "All Environments" is one option of the environment select; the table gets a column for each environment with a ✓ where the secret is set | A separate "Compare environments" chip; its cells each hold a value, Reveal, Edit, History, Delete and Rotate buttons | The select gains "All environments" and the chip row goes. A cell shows a mark and, on a click, opens the details drawer. Not set is a quiet "+ Set" (VUI-9) |
| A strip above the table: path, "Reveal All", "Commit History", "Batch Edit" | "Reveal all" in the toolbar; the Changes card at the foot of the page | A strip: project / environment, Reveal all, Changes (opens the feed in a drawer) (VUI-3, VUI-8). **Batch Edit is not built** |
| A row: select box, key icon, name, a comment icon, the masked value; hover shows Edit, Copy and "⋯" | A row: name with tag chips, value, source chip; click opens an in-page panel | Same row with a key icon for secrets, a comment icon when there is a description, the source chip kept, hover or focus shows Edit, Copy value, "⋯" (VUI-3, VUI-4) |
| "⋯" menu: Annotate (comment, tags, reminder, metadata), Secret references, Version history, View access, Multi-line encoding, Add override, Share secret, Copy secret, Delete | Those that exist are buttons in the details panel | A menu with **Edit details, Add tags, Version history, Rotation, Add override, Copy value, Delete**. The rest are listed under Non-goals (VUI-4) |
| A last row "Add a secret name / Add a secret value" | Add is a button that opens a form | Quick-add row: key, value, Enter (VUI-5) |
| Footer: a count and page controls | none | A count (pages only if the list is already paged: VUI-3 checks) |
| "Create Secret" drawer: Environments (several), Key, Value + Generate, Comment, Advanced (Tags, multi-line, metadata), "Add More", Upload, Cancel, Create | An inline form with a level and an environment | A drawer: **Applies to** (several environments, the whole project, or the organization), Key, Value + Generate, Comment, Advanced (Tags, Kind), Add more, Import, Cancel, Create (VUI-7) |
| "Version History" drawer: the secret, its environment, v1 Current with date, copy and reveal icons, who made it | A history list inside the details panel | The same list in a drawer, rollback kept (VUI-6) |
| "View Shared Secret": a public page that shows a value once until it expires | none | **Not built, and not in this feature**: it is a public, unauthenticated read of a secret (question 3) |

## Revision 2026-10-21: what the live Infisical screens changed
Authority: the user, after the live look at their Infisical account: "I think we've got enough now to update our platform UI and functionality. Let's implement based on the screenshots." This amends answer 1 and adds tasks VUI-13 to VUI-15; VUI-7 to VUI-10 are rewritten below (TASKS.md). Seen in the account and used: the Secrets page in one and in All environments, the environment menu, the column menu, Add New, the Create Secret drawer, Add Folder, Version History. **Not seen, so not built: Batch Edit, Import/Upload panels, Commit History, a row's own detail panel.**
- **The environment control is a popover, not a native select** (answer 1 amended): a filter box, "All environments", a checkbox for each environment, "+ Add environment" at the foot, and the hint "Use the checkboxes to select multiple environments." One environment ticked is the list; several, or All, is the matrix of those environments. The "New environment" card goes: Add environment is a small modal from the popover (small form = modal, big form = drawer) (VUI-8).
- **Add New menu** replaces the import icon and the "Add a variable" button: "Add a variable" and "Import variables" (their New Secret and Upload Secrets) (VUI-13).
- **The matrix shows presence, not values**, with a menu on each environment's column head: Copy environment slug, Download .env, View changes. Its last row is "Add a variable name | Add a variable value (applies to all)", which creates the variable in every environment shown, one create each, stopping at the first refusal and saying which were made (VUI-9). Their "Delete environment" is not built (no route, and destructive).
- **Changes** is a button in the strip, where theirs puts Commit History, and opens the feed in a drawer (VUI-14).
- **Version history is a timeline** (a masked box, then Copy, Reveal and Roll back as icon buttons that keep their names, and "Changed by"). Their per-version Delete is not built (no route, and destructive) (VUI-15).
- **Not built:** Batch Edit and filter by resource (one resource type here), Manage Access, dynamic secrets, proxied services and honey tokens.

## Scope
- **Cut A, the screen's face (VUI-1..5).** Page head with the project select; the one-line toolbar; the table with its strip, icons, count, hover actions and "⋯" menu; the quick-add row. The existing in-page panels still open as they do now.
- **Cut B, drawers (VUI-6..8).** A `Drawer` component (dialog semantics). Details and version history, the Create drawer, then Changes and "Add environment" as drawers. The in-page panels go.
- **Cut C, All environments (VUI-9..10).** The matrix, and the demo and layout checks that prove the whole page at 1280 and 390.
- **Cut D, selection (VUI-11, approve separately).** Select rows and delete them in one go, through the existing bulk route.
- **Delivery (VUI-12).**

## Design
- **No new API.** Every call exists: the resolved list, create, patch, delete, versions and restore, import, bulk, reveal, changes, tags. Creating in several environments is one create for each, so it can stop half way: the drawer says which were made and which were not, and does not undo (VUI-7).
- **Reveal and copy are the audited reveal.** "Copy value" on a secret uses the same reveal route as Reveal all, so the audit row is the same and no value reaches the page unless a person asked for it. A plain value copies without a call. The value in the clipboard is not the platform's to log.
- **Where "Add" lands.** The quick-add row creates a **secret** (masked, the safe default) in the **open environment**. The drawer chooses the level. This is question 2.
- **Components.** `Drawer` (right side, `role="dialog"`, `aria-modal`, a name, focus moves in and returns, Esc and the scrim close it, the page behind does not scroll, full width at phone width) and `RowMenu` (a button with `aria-haspopup`, `role="menu"` and `menuitem`s, arrow keys, Esc returns focus). Neither exists in the app today. Built by hand: about 150 lines for the two; a library is a heavy dependency, a human gate.
- **Names stay.** A control that stays on screen keeps its accessible name (an icon button gets the old text as `aria-label` and `title`). Any control that moves into a menu or drawer changes how its tests reach it: each such test is a finding in LOG.md, its assertion kept as strong, and none is deleted or skipped. There are about 140 variable tests across ten files, so this is the main cost of the feature.
- **The matrix cell is a button** named `<key> in <environment>` with its state as text ("Set here", "From project", "From organization", "Not set"); the mark is `aria-hidden`. A state is never colour alone.
- **CSS.** New classes get a `styles.test.ts` rule each; phone media rules go in their own block.

## Non-goals
Batch Edit; "Share secret" and any public page; reminders and rotation reminders in the menu (rotation exists and stays); encrypted metadata; "Secret references" and "View access" (nothing here answers either without new API); folders and the path in the strip (feature 27 owns them, and the strip leaves room for the path); drag and drop of a file onto the table; sort by column; the n8n-style look (feature 29); a UI library; changing the model of three levels; building anything before you approve.

## Acceptance
- The toolbar is one line at 1280 and no more than two at 390; the environment select holds each environment and "All environments"; no "Compare environments" chip remains.
- Every action that exists on the page today is still reachable by keyboard: add, import, edit, delete, reveal (one value and all), download, tags, history and rollback, rotation, override, changes, add environment (list checked off in VUI-12).
- All environments: one row for each key, one cell for each environment, a mark and the state in words, a click opens the details drawer, "+ Set" opens Create with the key and environment filled in; no value is shown in the matrix.
- Create in two environments makes two variables; one made and one refused says so, naming both.
- A secret's value is in no list response, no audit row and no log, and is in the page only after a reveal (the existing leak tests pass unchanged).
- A drawer traps focus, closes on Esc, returns focus to what opened it, and does not let the page scroll (tests); `bun run demo:shots` and the layout journey show the page at 1280 and 390 in both themes, the page does not scroll sideways, and I read each picture.
- Every existing variable test passes, or is a named finding as above; no test is skipped or weakened.

## Risks / human gates
- **Test churn (see Names stay).** About 140 tests reach controls that move. Each change is a finding. A moved assertion must still fail when the behaviour breaks (checked by a mutation for the ones on reveal, delete and rollback).
- **Accessibility of two new widgets.** A drawer and a menu are the two things a hand-made version gets wrong most. VUI-6 and VUI-4 have the keyboard and focus tests first, and the e2e journey drives each by keyboard.
- **Several environments at once is not atomic.** Said above; the alternative (a new bulk-across-environments route) is an API change and a new audit shape, a gate. Not proposed.
- **Copy value puts a secret on the clipboard.** It is the person's own act and goes through the audited reveal; it is a deliberate behaviour, so `/security-review` covers VUI-4 and VUI-7.
- **No API change, no migration, no new dependency, no change to a guard.**
- **Feature 27 (folders) lands in the same table.** Whichever is built second changes the strip and the quick-add row; VUI-3 leaves a slot for the path, and FLD's web tasks are re-read when this is approved.

## Open questions (answer at approval)
1. **"All environments"** replaces the "Compare environments" chip (recommended, as Infisical does; tests that click the chip become findings), or keep the chips and only restyle the matrix?
2. **Quick-add and the Create drawer:** a quick-add creates a secret in the open environment (recommended); the drawer offers "Applies to" with several environments, the whole project, or the organization (recommended); or the drawer only offers environments, as Infisical does (the project and organization levels stay in the old form)?
3. **Share secret** (a public page that shows a value once until it expires): leave it out (recommended; it is a new unauthenticated route, an auth-model change and a human gate), or plan it as feature 31 after this one?
4. **Selection and bulk delete (cut D):** include it, as a separate approval after cut C (recommended), or leave it out?
5. **Cuts:** all of A to C in one go (recommended; cut A alone leaves the page half in the old style), or A first and look at it?
