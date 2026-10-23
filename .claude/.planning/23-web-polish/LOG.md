# 23 Web polish - Log

Per-task gate: `bunx biome format --write apps/web/src`, `bunx biome check apps/web`, `bun run typecheck`, the whole web suite (`cd apps/web && bun test --env-file=../../.env.example`, needs `bun run dev:db`). The last task runs `bun run check` and `bun run e2e`.

## 2026-10-20 - PLS-1 One rhythm for cards and fields
- Why: the user sent a screenshot of the Variables matrix ("UI isn't neat and tidy, can we make sure every page is spacious, clean and user friendly"). All ten pages were then shot (dark, 1280 px) and read; the findings are in SPEC.md. This feature is planned from that, and runs on the same standing go as 22 (the user asked for the result, not a plan to approve); nothing is committed.
- `styles.css`: `.card-flow` gap 20 px and `.card-flow > * { margin: 0 }` (a paragraph or list had its browser margin on top of the gap, so a card's parts sat 16, 30 and 48 px apart); `.card` padding 28 px (16 px under 600 px, unchanged); `.stack` gap 24 px; a new `h3` style, with `.card-flow > h3` starting a section under a 1 px rule; inputs and selects stop at 30 rem, textareas keep the full width.
- Tests (3, each seen failing first, in `styles.test.ts`): card gap and margins, the section rule, the field cap.
- Gate: typecheck, lint, 385 web tests pass (382 + 3).
- The seeded scratch server (outside the repo) now runs with `development: true`, so CSS edits show on a refresh. Its session was reissued: the sign-in link on port 3011 has to be opened again.

## 2026-10-20 - PLS-2 Tables that keep whole words
- `styles.css` only: row headers break at word boundaries (`overflow-wrap: break-word`, was `anywhere`, which split `FEATURE_FLAGS` mid-word); `time` never wraps; table cells 56 px high with 10 px by 16 px padding, the first and last cell flush with the card edge; buttons inside a table are 32 px, 13 px type, with the stronger border (`td button, td .button`, placed before the hover rule so Biome's specificity order holds).
- Tests (2, each seen failing first, in `styles.test.ts`): row header wrapping with `time`; cell padding with the compact in-table buttons. The existing row header case test passes unchanged.
- Gate: ran with PLS-3, below. A visual check of Variables and Status at 1280 px dark was made first.

## 2026-10-20 - PLS-3 Short labels on row actions
- New `Named` in `components.tsx`: a short word, then the rest of the name in a `.visually-hidden` span, so the accessible name is unchanged. Used for Retry (Status), Dismiss and Reopen (Findings) and Test (Settings). The pending words ("Retrying…", "Testing…") stay plain text.
- Tests: a `Named` unit case in `components.test.tsx`; one added assertion each in `runs.test.tsx`, `findings.test.tsx` and `settings.test.tsx` that the visible text is the single word (seen failing first); `visibleText()` added to `testing.tsx`. Every existing name-based test passes unchanged.
- Gate (covers PLS-2 and PLS-3): format, Biome and typecheck clean; web suite 387 pass, 1 fail (the known identities flake, "giving one up asks first"); that file alone passes twice (6 of 6). 388 tests in all: 385 at PLS-1, plus 2 PLS-2 style cases and 1 `Named` case. The added assertions in runs, findings and settings add no tests.
- Reopen has no assertion of its own; it uses the same component as Dismiss.

## 2026-10-20 - PLS-4 The Variables cell
- `styles.css`: `button.quiet` (no border, body text, 6 px side padding), `button.quiet.danger` (danger colour), `.tags.cell-actions` (-6 px left margin, so every line of words, wrapped or not, starts under the value), `.matrix th, .matrix td` top-aligned. `variables.tsx`: the five cell buttons use `quiet` in place of `small`; labels, aria-labels and handlers are unchanged. `.small` stays for Reveal, Hide, Set and the history buttons.
- Built twice. Accent text first: the link orange (`--accent`) and the danger red are close in hue, so Delete did not stand out; body text it is. The first version also called the container `actions`, which is the page header's class (12 px gap), so Delete wrapped onto its own line in the shot; it is `cell-actions` now. The probe and the shot caught both.
- Test (1, seen failing first, in `styles.test.ts`): the quiet button, Delete colour, container offset and top alignment. `variables.test.tsx` passes unchanged (55 with the style tests).
- Probe at 1280 and 1440 px against the seeded server: 13 cells, none with actions on more than two lines (only the five-action secret cells wrap), the first word's text starts at the value's left edge. The Variables page is 1312 px tall in the shot, from 1420.
- Gate: format, Biome and typecheck clean; web suite 389 pass, 0 fail (388 + 1).
- Follow-up for PLS-6: the "Set" button in an empty cell and Reveal are still outlined pills; they are single, primary actions of a cell, so left as they are unless the read says otherwise.

## 2026-10-20 - PLS-5 Home, Sync, Projects and Pipeline details
- `styles.css`: `.stack > * { margin: 0 }` (a paragraph or list in a stack had its browser margin on top of the 24 px gap, which is where the Pipeline detect card's 70 px gaps came from); `.stack.card` gap 20 px and `.stack.card > h3` with the section rule, so the wizard steps and the forms that are `stack card` (Pipeline steps 1-4 and the result, sync form, variable import, rotation, history and edit forms) share the card rhythm; `.checklist li > span` is a grid, so the hint sits under the link; `.row.middle` centres text beside a button.
- `sync.tsx`: no targets is now a `Card` titled "Sync targets", not a loose line. `projects.tsx`: the connection row is `row middle`, so "Connection: Acme GitLab" is level with "Add a connection".
- Tests: `styles.test.ts` gains two cases (stack rhythm; checklist hint and centred row), each seen failing first; `sync.test.tsx` "a project with none says so" now asserts the message is inside the region named "Sync targets" (seen failing first). `home.test.tsx`, `projects.test.tsx` and `pipeline.test.tsx` pass unchanged.
- Read in the shots (dark, 1280): Home, Sync, Projects and Pipeline detect. The Pipeline steps 2-4 and the Result card are read in PLS-6.
- Gate: format, Biome and typecheck clean; web suite 391 pass, 0 fail (389 + 2).
- The scratch dev server did not pick up a changed `projects.tsx` (it served the old bundle after a touch); restarted it, which reissued the session, so http://127.0.0.1:3011/ has to be opened again.

## 2026-10-20 - PLS-6 Read every page
- Read: all ten pages, dark at 1280 and 390 px; light at 1280 for Status, Findings and Variables; the Pipeline wizard steps 2-4 (dark 1280, light 390). Light 390 and 1440 for the other pages are covered by the script's overflow report only (none) and by the e2e check.
- Fixed, each with a style test seen failing first (`styles.test.ts`, 3 new cases and one extended): the Status actions cell (`.row.nowrap`: link and Retry on one line, so a row with a Retry is no taller than one without); the section rule for a form or section that opens with an h3 inside a card (`.card-flow > .stack > h3:first-child`, Settings "Create a token"), with `.card-flow > .stack { max-width: none }` so the rule spans the card instead of stopping at 40rem; the choice cards of the Pipeline wizard (`.item > .stack` gap 4 px, the title was 24 px from its hint). `runs.tsx` gains the `nowrap` class; no other markup changed.
- Left as they are, on purpose: Organizations keeps Rename and Delete on separate lines (two forms, and a destructive action stays apart from the rename); the Link button on Settings "Link another" appears only once a slug is typed (existing behaviour, pinned by `identities.test.tsx`); `Set` and `Reveal` stay outlined pills.
- Follow-ups, not done: at 390 px the sidebar sits above the content as a wrapped nav, about 410 px before the page starts; a collapsed menu would be tidier but is a behaviour change (menu button, focus handling), so it needs its own task. Pipeline `section.stack` headings (lint, guardrails, missing variables) inside a step are not ruled; not seen in a shot, as the seeded project raises none of them.
- The 404 in the console on every page is the expected SSO discovery request (no identity provider configured).
- Gate: format, Biome and typecheck clean; web suite 392 pass, 0 fail before the wizard change, `bun run e2e` 3 of 3 pass (journey, layout light, layout dark). The choice-card test adds one more (393).

## 2026-10-20 - PLS-7 Delivery
- `/code-review` of the feature's diff returned 15 findings. Fixed three: "Show more" on the Projects list is in a `.row` (test added, seen failing first: parent was `stack`), the Role rules caption on Single sign-on is visually hidden like every other caption, and "organisation" is "organization" in two ledes. The rest are listed as follow-ups in the completion file; one is declined with a reason (Open findings as the neutral "manual" tone is feature 22's RDS-14, pinned by `findings.test.tsx`).
- Gate: format, Biome and typecheck clean. Web suite 392 pass, 1 fail (`identities.test.tsx` "giving one up asks first": same failure against HEAD's `identities.tsx`, 15 to 19 s, still fails with `--timeout 60000`, cause not found). Root suite 5092 pass, 2 skip, 2 fail (`apps/cli/src/auth.test.ts` "answers once...", `packages/db/src/stacks.test.ts` "a stack that is still there keeps its id..."), both in code this feature did not touch and passing against Docker's Postgres earlier today. `bun run e2e` 3 of 3 pass after the last markup change.
- All suites ran against a throwaway native Postgres 18 (scram, UTC) in the scratchpad because Docker stopped answering after the disk filled. `bun run check` is not seen green end to end; re-run it once `bun run dev:db` works.
- New dependencies: none. No test weakened, skipped or deleted.
