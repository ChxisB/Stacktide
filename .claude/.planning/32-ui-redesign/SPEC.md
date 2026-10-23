# 32 UI redesign - Spec
Prefix: UXR · Milestone: M5 · Status: planned 2026-10-22, design drawn, waiting for your go (no product code written) · Needs: 22, 23 · Came from: "redesigning the DevOps platform, we want nice motion and animation; clean and clear UI/UX. Can we redesign every page and also come up with standardised style such as buttons, models, hover states etc. Let's do every screen in the platform" (2026-10-22)

## Goal
One standard look and feel for every part of the web app, and every screen redrawn on it. The standard is small and written down: five button kinds, one field, one card, one table, one badge, one callout, one empty state, one skeleton, one drawer, one dialog, one toast, and one set of motion rules (what moves, how long, how fast, and what stays still). The screens are the eleven that exist, plus the phone layout. Motion answers a touch (things open from what opened them), nothing moves on its own except a run that is running, and reduced motion keeps the meaning.

## What changes and what stays
- **Stays:** every route, every API call, every permission, the Carebell colours and their light, dark and forced-dark sets, Plus Jakarta Sans and JetBrains Mono, native markup (`<table>`, `<label>`, `<button>`, `<dialog>`), 44 px targets, status as a glyph plus a word, one `h1` a page, masked secrets. No API, database or guard change. No new dependency.
- **Changes:** the shape and feel of controls (radii, hover, pressed, busy, disabled, focus), a motion layer (CSS only, transform and opacity), four new parts (`Callout`, `Empty`, `Dialog` as `Drawer centered`, `Toaster`), `Loading` drawn as skeletons, the shell (sidebar, top bar, a phone menu), and on the screens, results by toast and destructive confirms in a dialog instead of inline.
- **Design class to app selector** (builders map, they do not copy class names; tests find controls by role and name):

| Design (carebell.css) | App |
|---|---|
| `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-danger-solid`, `.btn-sm`, `.btn-icon` | `button` / `.button`, `.primary`, `.quiet`, `.danger`, `.danger.solid` (new), `.small` (and `td button`), `.icon` |
| `.seg` (Dark / Light) | `fieldset.seg` in `ThemeToggle` (exists) |
| `.card`, `.kpi`, `.badge`, `.tag` | `Card`, `Kpi`, `StatusBadge`, `.tag` |
| `.tbl` | the native `<table>` under `Card` |
| `.callout` (`c-info` `c-ok` `c-warn` `c-bad`) | new `Callout tone`; `p.warn`, `.error` and the 41 `role="alert"` blocks move onto it where their tests allow |
| `.empty`, `.skel` | new `Empty`; `Loading` (36 uses) keeps its words and draws skeletons |
| `.scrim`, `.drawer`, `.dialog`, `.toast` | `Drawer`, `Drawer centered`, new `Toaster` |
| `.nav`, `.org`, `.side-foot`, `.crumbs` | `shell.tsx` |
| `--dur-1/2/3`, `--ease-out/in/io`, `--r-sm/md/lg` | new tokens beside the existing `--radius*` (question 2) |

## Scope
- **Cut A, the standard (UXR-1..6).** Tokens and the reduced-motion rule; buttons; fields and checks; cards, KPI, badges and tags; callouts, empty states and skeletons; tables.
- **Cut B, overlays and feedback (UXR-7..10).** Drawer, popover and menu motion; the dialog; the toast; page-enter motion.
- **Cut C, the shell (UXR-11..12).** Sidebar, top bar, theme toggle; the phone menu.
- **Cut D, the screens (UXR-13..28).** Sign-in, Home, Projects, Pipeline, Status (two), State, Sync (two), Variables (two), Findings, Organizations, Settings (three).
- **Cut E, checks and delivery (UXR-29..31).**
- Build order is the task order. A to C alone leave the screens on the old skin; each screen task is independent of the others once its parts exist.

## Non-goals
Dark or light changes to the Carebell palette; new fonts; an animation library; a UI library; a switch control (drawn on the Forms board, but no screen has an on/off field today); the design's org-wide "Open findings" KPI (findings are read per project, so there is no number to show: left out, as in feature 22); exit animations (see Design: nothing waits for an animation); drag and drop; a page-transition library; anything on the API side; building anything before you approve.

## Design
Made in Claude Design with the three skills named below. **It is a design, not code**: it is sample content on invented data, and the app is built from it, task by task.
- **Link:** https://claude.ai/artifact/3uXmNbS92iQiCxu79fJsy6 (private, owner only; Version 24, 2026-10-22). Eighteen boards on two pages: **style** (Main, Motion, Buttons, Forms, Overlays, Data) and **screens** (SignIn, Home, Projects, Pipeline, Status, State, Sync, Variables, Findings, Organizations, Settings, Phone). Every screen board is interactive: states are reached by clicking, and a theme lever flips light and dark.
- **Date:** 2026-10-22.
- **Skills used:** `frontend-design` (direction, hierarchy, wording), `bencium-controlled-ux-designer` (each choice goes to you at the approval stop; flat, no shadows, 100 to 500 ms, ease-out in and ease-in out, transform and opacity only, `prefers-reduced-motion`), `composition-patterns` (explicit variants, not boolean modes: `tone`, `kind`). `ui-ux-pro-max` was not used: the palette and type are fixed by Carebell.
- **Built from** `apps/web/src/styles.css` Carebell tokens (light and dark). No design system was attached: the artifact has its own `carebell.css`, scoped under `.cb`, which exists only to draw the boards.
- **Verified while drawing:** every board was rendered at 1440 light and dark and at 390; each interactive board was driven by a script (open, close, Escape, scrim, error and success paths, focus return, per-role views) with no console problems. Measured locally, not in the real canvas.

### Settled (the standard)
- **Five rules** (Main board): one primary action a view, the dark green button, everything else slate or plain; every state drawn (rest, hover, focus, pressed, busy, disabled); motion answers a touch; reduced motion keeps the meaning (fades stay, movement goes, a running job still shows a glyph and the word "Running"); secrets stay masked.
- **Motion** (Motion board): 120 ms for colour and press, 200 ms for pop and rise, 320 ms for drawers and sheets; ease-out in, ease-in out; transform, opacity and colour only; the only looping motion is a running job (spinner glyph) and a running flow line; page content enters with a short fade and rise on a route change, not on a data refresh.
- **Buttons** (Buttons board): slate by default, dark green for the one primary, ghost, danger (tinted), danger solid (confirm of a delete), link, small (32 px, table rows), icon (44 px). Busy shows a spinner before the label.
- **Fields** (Forms board): 44 px, one radius, visible label above, a hint or an error line below, a `.mask` secret, search with a leading icon, checkbox, radio.
- **Data** (Data board): cards, table with a quiet header and hover row, badges (glyph plus word, five tones), KPI with a foot link, callouts in four tones, empty state, loading skeletons, error block with a retry.
- **Overlays** (Overlays board): drawer from the right for forms of more than a field or two, dialog for a question or a one-field form, popover and menu; a drawer or dialog opens from its opener, focus goes in, Escape and the scrim close it, focus returns; results of an action appear as a toast with the same words the page says today.
- **Shell** (every screen board): 264 px sidebar with brand, organization switcher, grouped navigation with icons, the user and Sign out; top bar with breadcrumbs and the Dark / Light toggle. **No eyebrow above page titles** (18 uses and 8 test lines today; question 5).
- **Phone** (Phone board, 390 by 844): below 900 px the stacked sidebar becomes a top bar (menu button, breadcrumb, theme toggle) and a slide-in menu holding the groups, the organization switcher, the user and Sign out; dialogs become a bottom sheet. Three states drawn: Home with the menu closed, the menu open, Settings with a confirm sheet.

### Settled (per screen, what the design changes)
- **Sign-in:** one primary action on a centred card; the error as a callout.
- **Home:** "Getting started" card with a progress bar and rows that link whole; KPI cards with a foot link; skeletons while loading.
- **Projects:** the add-connection form is a drawer; import shows a live count; results by toast.
- **Pipeline:** a segmented stepper; radio cards for template and delivery; the merge-request diff as a figure; one callout per state.
- **Status:** the runs table with Retry only for failed or canceled runs; the protected-environment approval flow end to end in a dialog; jobs panels open one at a time; results by toast.
- **State:** the intro as a sub line plus an info callout; a hint or error under the stack input.
- **Sync:** count pills above the plan; a danger callout when deletes are more than zero; the unmanaged policy as a callout; the apply confirmation as a dialog; the last-sync disclosure is a button with `aria-expanded`; results by toast.
- **Variables:** the matrix cells open the details drawer; the tag filter is an inline select; Reveal all and Download .env in list mode; edit, delete and bulk delete in a drawer or a dialog; row actions are always visible (feature 30's hover reveal goes: question 8).
- **Findings:** chips replace the "Show" select; a dismiss dialog; glyph plus word badges; long paths wrap.
- **Organizations:** cards on one grid; delete organization and release zone as dialogs (the cancel button keeps its word "Keep"); the blocked-delete error; Members get an empty state; the claim form shows its validation.
- **Settings:** Connections (Add a connection in a drawer, test result as a callout naming the connection, delete in a shared dialog), Worker pools (the isolation sentence as a warn callout, a Health column after Check health, admin only), Single sign-on (a facts list, a role-rules table, owner actions Test, Turn on or off, Edit, Delete; a provider drawer with rule cards), Sign-in methods ("Link another" with a trust callout; the button appears once a slug is typed; unlink in a dialog), API tokens (a state badge with glyph and word, a three-column create form, a fresh-token panel shown once with Copy and "I have copied it", revoke in a dialog). Per-role views: admin, member and viewer lose what they cannot do, as today.

### Sample content (not the product's: never copy it into the app)
Organization "Acme" and user "Sam Rivers"; repositories `acme/web`, `acme/docs`; sync targets `web-ci`, `web-group`, `docs-sandbox` and their variable names; the Findings sample data; the Organizations sample members, zones and role mapping; the Settings sample connections, worker pools, SSO provider and tokens; the SSO slug example `acme`; every secret is a `demo-not-a-real-secret` string and every value is invented. Heights, counts and dates are sample. **Not drawn:** the Settings copy-failure path, the SSO link redirect and return, a "Not checked" pool health, jump-to anchor chips; Variables rotation, move, describe, folder rename and delete and the override form; Sync "Never synced", plan failed, an expired plan and "adopt"; Organizations delete success, the switcher's own states and a rename error. Screens are built on the existing behaviour for these.
- **New copy in the design, awaiting your approval (question 12):** the revoke warning "Anything using this token stops working at once. This cannot be undone."; the empty-state texts; the SSO test-fail text; the link-error text; the duplicate and cap errors; the Organizations claim-form validation and create-form hints; the "Not set" and sample button words that differ from the app.

### Design decisions that keep tests alive
- **Nothing waits for an animation.** Only enter animations exist: a drawer, dialog, menu or toast unmounts at once on close, so focus return, Escape and every test that checks "it is gone" behave as today. happy-dom runs no CSS animation, so tests never see motion.
- **Names stay.** A control that stays keeps its accessible name; a control that moves into a dialog or a toast changes how its tests reach it, and each such test is a named finding in LOG.md, its assertion kept as strong. Results by toast keep their sentence and `role="status"`; errors keep `role="alert"`.
- **Class contracts** (`.org`, `.diff-add`, `.diff-del`, `p.warn`, `tag status-<tone>`, `button.quiet`, `.card-flow`, `.stack`) are grepped before a rename; `styles.test.ts` pins (card padding 28 px, `.card-flow` gap 20 px, `.stack` 24 px, `button.quiet`, table cell padding) change only where a board differs, with the rule and a LOG line in the same commit.
- **Native `type=number`** stays for the GitLab group ID (the design drew a text field with `inputmode="numeric"` only because its preview runtime warns on the number input).

## Acceptance
- `bun run check` is green and no test is weakened, skipped or deleted; each test that had to move is a finding in LOG.md.
- Every state the boards draw exists in the app and has a test: busy, disabled, error, empty and loading for each part and each screen that has them.
- `styles.test.ts` keeps its colour rule and AA pairs and gains the new pairs (every button variant at rest and hover, the callout tones, badge tones, the toast, the current nav item) in light, dark and forced dark; it pins the new tokens, the 44 px and 32 px sizes and the phone breakpoints.
- Motion: every transition and animation in `styles.css` moves only transform, opacity, colour or filter; reduced motion removes movement and keeps fades; no timer or animation gates an unmount (tests).
- `bun run e2e` opens every route at 390 px in both themes with no sideways scroll, and a journey opens the phone menu, goes to Settings and back by keyboard.
- Every drawer, dialog, menu and toast: named, focus in and back to its opener, Escape, a trapped Tab (not a toast), no secret value in any new place.
- `bun run demo:shots` pictures of every route (light, dark, 1440, 390) and of each open overlay; each is read by eye and set beside its board; each difference you chose is a line in LOG.md.
- The web-design-guidelines and accessibility scans are run on the demo and their results are in the completion, or the completion says they could not run.

## Risks / human gates
- **Test churn.** About 900 web tests across 52 files, found by role and name. Moves into dialogs and toasts are the cost (inline confirms in Settings, Organizations, Sync, Findings and Variables; 17 inline `role="status"` lines; 8 eyebrow assertions). Each is a finding; none is deleted.
- **Shape change.** Buttons from pill to 12 px, cards from 28 to 20 px, fields from 14 to 12 px, change `styles.test.ts` pins and every picture. It is the biggest visible change and a design choice that is yours (question 1).
- **The phone menu is a `shell.tsx` change** (new state, focus rules): two things a hand-made version gets wrong most are a trapped Tab and focus return; UXR-12 writes the keyboard tests first.
- **Dialogs replace inline confirms** on five screens: a behaviour change, not only a skin (question 8).
- **Design measured locally.** The boards were checked in a local harness, not the live canvas; sample heights are not the app's.
- **No API change, no migration, no new dependency, no change to a guard.** A new token, font or dependency is a human gate: questions 2 and 4.
- **Known flake, not from this feature:** `identities.test.tsx` "giving one up asks first" fails about one run in three.

## Open questions (answer at approval)
1. **Shape.** Buttons pill to 12 px, cards 28 to 20 px, fields 14 to 12 px (recommended: it is most of what makes the design read as clean), or keep the pill buttons and 28 px cards and take only the motion and states?
2. **Tokens.** Add `--dur-1/2/3`, `--ease-out/in/io` and `--r-sm/md/lg` beside the existing `--radius*` (recommended; the old ones go when nothing uses them), or reuse the old radii and write durations inline?
3. **Compact controls.** 32 px row buttons already exist (`td button`); the design adds 36 px filter chips. Both are under the app's 44 px rule and over WCAG 2.2's 24 px minimum. Keep (recommended), or make chips 44 px?
4. **No new font, library or dependency.** Motion is CSS only. Agreed (recommended)?
5. **Eyebrow.** Stop passing it on the 18 screens (recommended: the design has none) and delete the prop in UXR-31 when no caller is left, or keep eyebrows?
6. **Toasts.** Results of actions appear as a toast with the same sentence and `role="status"` (recommended; tests find the status by role), or stay inline as today?
7. **Dialog.** `Drawer centered` is restyled as the dialog (recommended: no new component), or a separate `Dialog` is built?
8. **Confirms.** Destructive confirms (delete a connection, provider, token, organization, variable, finding dismiss, apply sync) become a dialog with focus return (recommended), or stay inline? Variables row actions become always visible (recommended), or keep feature 30's hover reveal?
9. **Phone navigation.** Menu button and slide-in menu below 900 px, a `shell.tsx` change (recommended; today every page opens on a 400 px menu), or keep the stacked sidebar?
10. **Tables at phone width.** Keep horizontal scroll inside the card as built (recommended). The Phone board draws Settings' Connections as stacked rows; that is a list, not a table, and would be a separate task if you want it.
11. **Bottom sheet.** The dialog becomes a bottom sheet under 600 px (recommended, CSS only), or stays centred?
12. **New wording.** Approve the new copy listed under Design, or send changes.
13. **Findings.** Chips replace the "Show" select (recommended; tests that use the select become findings), or keep the select?
14. **Smaller choices, recommended answers in brackets:** Status retry button's accessible name follows its text while busy ("Retrying", so the name matches what is shown); long paths on Findings wrap with `<wbr>` (the design used a zero-width space); the new warning glyph (triangle with a bang) for callouts, not for status badges; a new SSO provider starts **off** (the route passes no `enabled` today, so UXR-27 first checks what the database defaults to); the State lede says "its lock" but the screen shows none, so the lede loses the phrase.
15. **Cuts.** All of A to E in one go (recommended; A to C alone leave every screen on the old skin), or A to C first so you can look at the standard before the screens?
