# 32 UI redesign - Tasks

Gate for every task, from the repo root: `bunx biome format --write apps/web`, `bunx biome check .`, `bun run typecheck`, `cd apps/web && bun test --env-file=../../.env.example`, `bun run e2e`. Tests need Postgres on `localhost:5433` (`bun run dev:db`). Pictures: `bun run demo:shots`; also `bun run demo:align` and `bun run demo:keys`. Nothing here changes the API, the database or a guard, adds a dependency, and nothing touches a real GitLab or cloud account.

**Rule for every task: existing tests pass unchanged, or the change is a named finding.** A control that stays on screen keeps its accessible name. A control that moves into a dialog, drawer or toast changes how its tests reach it: write each such test in LOG.md as a finding, keep the assertion as strong, never delete or skip one. Only enter animations exist: an overlay unmounts at once on close, so nothing waits for an animation (SPEC, Design decisions). Every new CSS class and token gets a rule in `apps/web/src/styles.test.ts`; every colour comes from the tokens. A layout fault is found by looking at the picture, so each UI task ends with `bun run demo:shots` (or the one route it touched) and the picture read beside its board. The known flaky test `identities.test.tsx` "giving one up asks first" is not a reason to mark a task blocked: rerun it.

**Design.** Every `Design:` line names a board in the artifact https://claude.ai/artifact/3uXmNbS92iQiCxu79fJsy6 (Version 24; two pages: **style** and **screens**). It is read with `Artifact` `action: "read"` before the task starts. It is sample content: never copy its names, numbers or wording that the SPEC does not list as settled.

**Cuts.** A (UXR-1 to UXR-6) the standard: tokens, buttons, fields, cards and badges, callouts and skeletons, tables. B (UXR-7 to UXR-10) overlays and feedback: motion for drawer, popover and menu; the dialog; the toast; page-enter. C (UXR-11, UXR-12) the shell and the phone menu. D (UXR-13 to UXR-28) the screens, one or more tasks each. E (UXR-29 to UXR-31) checks and delivery. Questions 1 to 15 in SPEC.md are answered before UXR-1; the tasks assume the recommended answers and are edited if you choose otherwise.

## A. The standard

### UXR-1 - Tokens, motion rules and the reduced-motion guard  `[ ]` S - deps: none
Do: `styles.css`: add `--dur-1/2/3` (120, 200, 320 ms), `--ease-out`, `--ease-in`, `--ease-io` and `--r-sm/md/lg` (8, 12, 20 px) beside the existing `--radius*` (old ones stay until UXR-31). One `@media (prefers-reduced-motion: reduce)` block that removes transforms and keeps fades, in place of the scattered rules; the `job-spin` spinner is exempt (a running job still shows the glyph and the word).
Done when: `styles.test.ts` pins each token's value, that every `transition` and `animation` in `styles.css` names only transform, opacity, colour, background, border-color or filter (a scan of the file), and that the reduced-motion block exists and drops the `transform` ones.
Design: Motion board (durations, curves, what moves, reduced motion), Main board (the five rules).

### UXR-2 - Buttons  `[ ]` M - deps: UXR-1
Do: restyle `button` and its variants to the Buttons board: slate default, `.primary` dark green, `.quiet` ghost, `.danger` tinted, `.danger.solid` for the confirm of a delete (new), `.small` and `td button` 32 px, `.icon` 44 px. Rest, hover, focus-visible, pressed (a 1 px settle, not a scale), disabled and busy (`aria-busy="true"` draws a leading spinner; the label stays). Pill becomes `--r-md` if question 1 is yes.
Done when: `styles.test.ts` rules for every variant and state, 44 px and 32 px heights, the `button.quiet` pin updated with a LOG line; `components.test.tsx` renders a busy button and finds it by name; all pages' tests pass unchanged.
Design: Buttons board, Main board.

### UXR-3 - Fields, checks and the secret field  `[ ]` M - deps: UXR-1
Do: `input`, `select`, `textarea`, `label`, checkbox, radio and the `.mask` field to the Forms board: 44 px, `--r-md`, visible label above, a hint or error line below (`.hint` and `.error` rules; `aria-describedby` already wired where an error exists), focus ring, disabled, invalid (`aria-invalid`), search with a leading `Icon`. A `Field` wrapper only if three screens already repeat the same label, control and hint markup (check first; otherwise styles only).
Done when: `styles.test.ts` rules and AA pairs for the field states in light, dark and forced dark; one web test renders an invalid field and finds its error by `aria-describedby`; page tests unchanged.
Design: Forms board.

### UXR-4 - Cards, KPI, badges and tags  `[ ]` M - deps: UXR-1
Do: `Card` gains the flat 1 px border at `--r-lg` and an optional sub line (the `PageHead` / `Card` title keeps its heading level); `Kpi` gains an optional foot link; `StatusBadge` and `.tag` get the five tones as glyph plus word (keep `tag status-<tone>`). A card grid class on a 24 px gap. The `styles.test.ts` pins for card padding (28 px), `.card-flow` (20 px) and `.stack` (24 px) change only where the Data board differs, each with a LOG line.
Done when: `styles.test.ts` rules and AA pairs for every badge tone; `components.test.tsx` renders `Kpi` with and without a foot link and `StatusBadge` per tone, each with its word.
Design: Data board (cards, KPI, badges), Main board.

### UXR-5 - Callout, Empty and skeletons  `[ ]` M - deps: UXR-1, UXR-3
Do: add `Callout` (`tone`: info, ok, warn, bad; glyph plus text, `role="alert"` only for bad, otherwise none), `Empty` (title, text, optional action) and the new warning glyph (triangle with a bang) in `Icon`. `Loading` keeps its text and renders skeleton lines (`aria-busy`, `role="status"` kept). A migration pass is NOT part of this task: screens adopt the parts in their own tasks.
Done when: `components.test.tsx`: `Callout` per tone finds its text and glyph; `Empty` renders its action; `Loading` still finds "Loading…" by role `status`; `styles.test.ts` AA pairs for the four tones, light, dark, forced dark.
Design: Data board (callouts, empty, skeletons, error with retry).

### UXR-6 - Tables  `[ ]` S - deps: UXR-4
Do: the native `<table>` in a `Card`: quiet header, hover row, numeric columns aligned, a sticky first column only where it exists today; horizontal scroll stays inside the card at phone width. The `styles.test.ts` table cell padding pin changes only where the Data board differs, with a LOG line.
Done when: `styles.test.ts` rules for header, row hover, cell padding and the compact-button rule (`td button` 32 px); `bun run e2e` layout still passes at 390 px.
Design: Data board (table).

## B. Overlays and feedback

### UXR-7 - Drawer, popover and menu motion  `[ ]` S - deps: UXR-1
Do: `Drawer` enters from the right over a scrim fade (`--dur-3`, `--ease-out`); `Popover` and `RowMenu` pop from their opener (`--dur-2`, origin at the opener, opacity and a 4 px rise); enter only, nothing waits on exit. Reduced motion keeps the fade. Focus, Escape, scroll lock and return stay as built.
Done when: `styles.test.ts` pins the keyframes and the reduced-motion override; `components.test.tsx`: open, Escape, scrim click and focus return pass unchanged, and the overlay is gone from the DOM in the same tick it closes.
Design: Overlays board (drawer, popover, menu), Motion board.

### UXR-8 - Dialog  `[ ]` M - deps: UXR-2, UXR-7
Do: `Drawer centered` becomes the dialog: heading, optional sub, body, footer with Cancel then the confirm (`.danger.solid` for a delete), an optional error line (`role="alert"`) and a busy state that disables both buttons. Under 600 px it is a bottom sheet (CSS only, `--dur-3`). A destructive dialog opens with focus on the cancel button. No screen adopts it yet.
Done when: `components.test.tsx`: a dialog is named by its heading (`aria-labelledby`), focus goes to Cancel for a destructive one and to the first field for a form one, Tab stays inside, Escape and the scrim close it and return focus, a busy confirm is disabled with `aria-busy`; `styles.test.ts` rules for the centred and the sheet forms.
Design: Overlays board (dialog, sheet), Phone board (sheet).

### UXR-9 - Toaster  `[ ]` S - deps: UXR-1, UXR-2
Do: add `Toaster` and a `useToast()` that shows one toast at a time (new replaces old), bottom right (bottom centre under 600 px), 5 s then removed, with a Dismiss button; the sentence is a `role="status"` live region that stays mounted so a screen reader hears it; the container sits under the overlays in stacking (`z-index` below the scrim) so it never blocks a dialog's buttons. Mounted once in the shell.
Done when: `components.test.tsx`: the toast text is found by role `status`; it goes after 5 s (fake timers) or on Dismiss; a second toast replaces the first; `styles.test.ts` pins the stacking order against the overlay and the AA pairs.
Design: Overlays board (toast), Phone board (toast inside the phone).

### UXR-10 - Page enter  `[ ]` S - deps: UXR-1
Do: on a route change the page content enters with a 200 ms fade and 6 px rise (keyed on the route, not on a data refresh); nothing else enters on its own; no animation on first paint of cached data.
Done when: `shell.test.tsx` or `app.test.tsx`: the key changes on a route change and not on a query refetch; `styles.test.ts` pins the keyframe and the reduced-motion override.
Design: Motion board (page enter).

## C. The shell

### UXR-11 - Sidebar, top bar and theme toggle  `[ ]` M - deps: UXR-2, UXR-4
Do: `shell.tsx` and its CSS to the screen boards' shell: 264 px sidebar (brand, organization switcher, the three nav groups with icons, the current item marked by `aria-current="page"`, the user and Sign out), top bar with breadcrumbs and the existing Dark / Light `fieldset.seg`. Hover and current states per the Buttons board. Route names and the order of the nav links are unchanged. No eyebrow in the shell.
Done when: `shell.test.tsx` passes unchanged (every nav link is still found by role and name); a new test finds the current page link by `aria-current`; `styles.test.ts` rules for the sidebar width, the nav item states and AA pairs for the current item.
Design: Home board (shell at 1440), Main board.

### UXR-12 - Phone menu  `[ ]` M - deps: UXR-7, UXR-11
Do: below 900 px the stacked sidebar becomes a top bar (menu button, breadcrumb, theme toggle) and the nav a slide-in menu from the left (`--dur-3`), a labelled dialog (`aria-modal`) that holds the groups, the organization switcher, the user and Sign out. Opens onto its Close button; Escape, the scrim, a nav click and a route change close it; focus returns to the menu button. State lives in `shell.tsx`. Tests first.
Done when: `shell.test.tsx`: the menu button opens the menu, Close focus, Tab trapped, Escape closes and returns focus, choosing a link closes it; `bun run e2e` layout at 390 px both themes; `demo:keys` walks the menu by keyboard.
Design: Phone board (Home with the menu closed, the menu open).

## D. The screens

### UXR-13 - Sign-in  `[ ]` S - deps: UXR-2, UXR-5
Do: `SignIn` to the board: one centred card, the dark green primary, the error as a `Callout` bad (the text and `role="alert"` unchanged), SSO entry as in the app now.
Done when: sign-in tests pass unchanged; picture beside the board in both themes.
Design: SignIn board.

### UXR-14 - Home  `[ ]` M - deps: UXR-4, UXR-5, UXR-6
Do: the "Getting started" checklist with a progress bar and rows that link whole; KPI cards with a foot link where a destination exists; `Loading` skeletons for the cards and the recent runs; the org-wide "Open findings" KPI is NOT built (SPEC, non-goals).
Done when: `home.test.tsx` passes unchanged except named findings; a test for the progress bar value (`role="progressbar"` with `aria-valuenow`) and for a KPI foot link by name.
Design: Home board.

### UXR-15 - Projects  `[ ]` M - deps: UXR-7, UXR-9, UXR-3
Do: the add-connection form moves into a `Drawer`; import shows a live count of what will be imported; results by toast with the same sentences; the project list on the `Card` / table parts.
Done when: `projects.test.tsx` passes with each moved test a finding in LOG.md; a test for the live import count.
Design: Projects board.

### UXR-16 - Pipeline  `[ ]` M - deps: UXR-3, UXR-5, UXR-6
Do: a segmented stepper (native, the steps as a labelled list), radio cards for template and delivery (native `<input type="radio">` inside a label), the merge-request diff as a figure (`.diff-add` / `.diff-del` kept), one `Callout` per state (no template, not configured, MR open, merged).
Done when: `pipeline.test.tsx` passes unchanged except named findings; radios are found by name; the stepper marks the current step with `aria-current="step"`.
Design: Pipeline board.

### UXR-17 - Status runs and Retry  `[ ]` M - deps: UXR-6, UXR-9
Do: the runs table on the standard table; Retry only for failed and canceled runs; a retrying button shows "Retrying…" (its accessible name follows its text, question 14); results by toast with the same words.
Done when: `runs.test.tsx` passes with each name change a finding in LOG.md; a test that Retry is absent on a passed run.
Design: Status board (runs).

### UXR-18 - Status approval and jobs panels  `[ ]` M - deps: UXR-8, UXR-17
Do: the protected-environment approval flow as one dialog (it collapses today's `Drawer` plus form titles into one heading); jobs panels open one at a time; results by toast.
Done when: the approval tests find the dialog by its heading and the flow runs end to end in a test; `job-flow.test.tsx` and `run-graph.test.tsx` pass unchanged.
Design: Status board (approval, jobs).

### UXR-19 - State  `[ ]` S - deps: UXR-3, UXR-5
Do: the intro as a sub line plus an info `Callout`; a hint or error under the stack input; the lede loses "its lock" (question 14); empty and loading on the standard parts.
Done when: `state.test.tsx` passes unchanged except named findings; the stack input has an error described by `aria-describedby`.
Design: State board.

### UXR-20 - Sync plan  `[ ]` M - deps: UXR-5, UXR-6
Do: count pills above the plan (create, update, delete as glyph plus word); a danger `Callout` when deletes are more than zero; the unmanaged-variable policy as a `Callout`; the last-sync disclosure is a button with `aria-expanded`.
Done when: `sync.test.tsx` and `sync-flow.test.tsx` pass unchanged except named findings; a test that the danger callout shows only when deletes are more than zero.
Design: Sync board (plan).

### UXR-21 - Sync apply  `[ ]` S - deps: UXR-8, UXR-9, UXR-20
Do: the apply confirmation as a dialog (the confirm button keeps its current words; a destructive plan uses `.danger.solid`); results and errors by toast and `Callout` with the same sentences.
Done when: the apply tests reach the confirm in the dialog (findings in LOG.md); the confirm is blocked while busy.
Design: Sync board (apply dialog, results).

### UXR-22 - Variables list and matrix  `[ ]` M - deps: UXR-6, UXR-7
Do: matrix cells open the details drawer; the tag filter is an inline select; Reveal all and Download .env only in list mode; row actions are always visible (feature 30's hover reveal goes, question 8); every secret stays masked.
Done when: the `variables.*.test.tsx` files pass with each moved test a finding in LOG.md; a leak test that no secret value appears in any new place; `demo:align` read by eye.
Design: Variables board (list, matrix, toolbar).

### UXR-23 - Variables edit, delete and bulk delete  `[ ]` M - deps: UXR-8, UXR-9, UXR-22
Do: edit in the drawer; single delete and bulk delete in a dialog that names what goes; results by toast. Rotation, move, describe, folder rename and delete and the override form are NOT redrawn: they get the new parts through the shared styles only.
Done when: `variables.rowactions`, `variables.select` and `variables.changes` tests pass with moved ones as findings; the dialog names the count for a bulk delete.
Design: Variables board (drawer, delete dialog).

### UXR-24 - Findings  `[ ]` M - deps: UXR-4, UXR-8, UXR-9
Do: chips replace the "Show" select (question 13); a dismiss dialog; glyph plus word badges; long paths wrap with `<wbr>`.
Done when: `findings.test.tsx` passes with each moved test a finding in LOG.md; the chips are found by name and their pressed state by `aria-pressed`; a long path wraps at 390 px (`bun run e2e`).
Design: Findings board.

### UXR-25 - Organizations  `[ ]` M - deps: UXR-5, UXR-6, UXR-8
Do: cards on the 24 px grid; delete organization and release zone as dialogs (Cancel keeps the real word "Keep"); the blocked-delete error as a `Callout`; Members get an `Empty`; the claim form shows its validation (question 12); the GitLab group ID stays `type=number`.
Done when: `organizations.test.tsx` passes with moved tests as findings; an `Empty` test for Members; the blocked delete shows its error in the dialog.
Design: Organizations board.

### UXR-26 - Settings: Connections and Worker pools  `[ ]` M - deps: UXR-7, UXR-8, UXR-9
Do: Add a connection in a `Drawer`; the test result as a `Callout` naming the connection; delete in the one shared confirm dialog (a small hook the other Settings tasks reuse); Worker pools: the isolation sentence as a warn `Callout`, a Health column after "Check health", admin only as today.
Done when: `settings.test.tsx`, `pools.test.tsx` and `settings.skin.test.tsx` pass with moved tests as findings; the shared confirm is used by delete connection and delete pool; the Health column appears only after Check health.
Design: Settings board (connections, pools, connect drawer, delete dialog).

### UXR-27 - Settings: Single sign-on  `[ ]` M - deps: UXR-26
Do: a facts list, a role-rules table, owner actions (Test, Turn on or off, Edit, Delete); the provider in a `Drawer` with rule cards (cap of four rules as built); delete in the shared confirm. First check what `PUT` leaves `enabled` as in `apps/api/src/routes/sso.ts` (line ~192) and what the database defaults to; a new provider starts off if that is true, otherwise the SPEC question 14 is reopened with you.
Done when: `sso.test.tsx` passes with moved tests as findings; the default-state check is written in LOG.md.
Design: Settings board (single sign-on, provider drawer).

### UXR-28 - Settings: Sign-in methods and API tokens  `[ ]` M - deps: UXR-26
Do: "Link another" with a trust `Callout`, the button visible once a slug is typed, unlink in the shared confirm; tokens: a state badge (glyph plus word), a three-column create form, the fresh-token panel shown once with Copy and "I have copied it", revoke in the shared confirm with the new revoke warning (question 12). The token value is shown only in that panel, never anywhere else.
Done when: `identities.test.tsx` and `settings.test.tsx` pass with moved tests as findings; a leak test that the token value is absent after "I have copied it" and from every list; Copy failure keeps the value visible.
Design: Settings board (sign-in methods, tokens, revoke dialog).

## E. Checks and delivery

### UXR-29 - Colour pairs and motion sweep  `[ ]` S - deps: UXR-12, UXR-28
Do: `styles.test.ts`: the AA pairs for every button variant at rest and hover, callout tones, badge tones, toast and the current nav item in light, dark and forced dark; a scan that no hex colour sits outside the tokens (already enforced: confirm it still runs over the new rules); a scan that every `animation` has a reduced-motion override.
Done when: the added `styles.test.ts` rules pass; any pair that fails is fixed in the token, not in the test.
Design: Main board (colour), Data board.

### UXR-30 - Phone journey, pictures and scans  `[ ]` M - deps: UXR-12, UXR-28
Do: `e2e/layout.e2e.ts` keeps its `PAGES` and checks every route at 390 px, both themes; `e2e/journey.e2e.ts` gains a phone journey (open the menu, go to Settings, back by keyboard); `bun run demo:shots` for every route (light, dark, 1440, 390) and each open overlay; read each by eye beside its board; run `web-design-guidelines` on the changed files and `accesslint` scan and inspect on the running demo, or name them as not run.
Done when: `bun run e2e` is green; every picture is read and each difference you chose is a LOG.md line; the scan results are in LOG.md.
Design: all screen boards, Phone board.

### UXR-31 - Clean-up and delivery  `[ ]` S - deps: UXR-29, UXR-30
Do: delete the `eyebrow` prop from `PageHead` when no caller is left (question 5); delete the old `--radius*` tokens when nothing uses them (grep first); check `docs/` for a style page that says the old shape and update it; write `.claude/completions/2026-MM-DD-ui-redesign.md` with the artifact link at the top and the check results; set 32 to `done` in ROADMAP.
Done when: `bun run check` and `bun run e2e` are green or the failures are named; nothing in `apps/web/src` references the deleted names (grep); the completion is written.
Design: not needed, closes the work.
