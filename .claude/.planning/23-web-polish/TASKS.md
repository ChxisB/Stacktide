# 23 Web polish - Tasks

Gate for every task, from the repo root: `bunx biome format --write apps/web/src`, `bunx biome check apps/web`, `bun run typecheck`, then `cd apps/web && bun test --env-file=../../.env.example` (needs `bun run dev:db`). The last task runs `bun run check` and `bun run e2e`.

### PLS-1 - One rhythm for cards and fields  `[x]` S - deps: none
Do: in `styles.css` the children of a card have no margin of their own and sit one gap apart (20 px); cards get 28 px padding; `.stack` gap 24 px; `h3` gets a style and a rule above it as a section start; inputs and selects stop at 30 rem, textareas do not.
Done when: `styles.test.ts` has cases for card children, the `h3` rule and the field cap, and fails without the CSS.

### PLS-2 - Tables that keep whole words  `[x]` S - deps: PLS-1
Do: row headers break only at word boundaries (`overflow-wrap: break-word`), `time` never wraps, cells get 16 px padding, and buttons inside a table are compact (32 px) with a quiet border.
Done when: `styles.test.ts` pins the row header, `time` and compact-button rules; the existing row header case test still passes unchanged.

### PLS-3 - Short labels on row actions  `[x]` S - deps: PLS-2
Do: Retry (Status), Dismiss (Findings) and Test (Settings) show one word, and keep the full name for assistive technology with a visually hidden span, so the accessible name is what it was.
Done when: the existing tests that find `Retry <ref>`, `Dismiss <where>` and `Test <connection>` by name pass unchanged, and each gains an assertion that the visible text is the single word.

### PLS-4 - The Variables cell  `[x]` M - deps: PLS-2
Do: in a matrix cell the actions become a row of quiet words (no border, body text, Delete in the danger colour), and the cell is top-aligned with its row header. Changed while building: accent text was tried first and the link orange read the same as the danger red, so Delete did not stand out; the tags were left as they were (they already sit on one line).
Done when: `styles.test.ts` pins the quiet cell buttons; `variables.test.tsx` still passes unchanged; a probe at 1280 px shows no cell's actions taller than two lines.

### PLS-5 - Home, Sync, Projects and Pipeline details  `[x]` M - deps: PLS-1
Do: the checklist shows the link with its hint underneath; Sync with no targets says so inside a card; the Projects connection row aligns its button with its text; the Pipeline detect card uses the new rhythm (tested by the shots in PLS-6, no markup change expected there).
Done when: `home.test.tsx` and `sync.test.tsx` still pass unchanged, `styles.test.ts` pins the checklist hint line, the row alignment and the stack rhythm, and the Sync empty state is asserted to be in a region named by its card. Changed while building: the home markup did not change (the hint was already its own element), so its test stays as it was and the CSS test pins the layout; the wizard steps and forms, which are `stack card`, got the card rhythm too, as the detect card's 70 px gaps came from a paragraph margin on top of the stack gap.

### PLS-6 - Read every page  `[x]` M - deps: PLS-1..5
Do: shoot all ten routes in dark and light at 1280, 1440 and 390 px against the seeded scratch server and read each shot (the scratch script is outside the repo). Fix what is cramped, uneven or clipped; log what is left.
Done when: every shot was read, `e2e/layout.e2e.ts` passes, and LOG.md lists what was read and what was fixed. Changed while doing it: not every shot was read (light 390 and 1440 are covered by the script's overflow report and the e2e check); the Pipeline wizard steps 2-4 were driven and shot by a second script. LOG.md lists exactly which were read.

### PLS-7 - Delivery  `[x]` S - deps: PLS-6
Do: `bun run check` and `bun run e2e`, a code review of the diff, the completion file `.claude/completions/YYYY-MM-DD-23-web-polish.md`, ROADMAP row 23 set to done.
Done when: the completion file exists and states the gate plainly. Changed while doing it: `bun run check` was not seen green end to end (three tests fail in this environment, listed in the completion file and LOG.md), so "both gates green" is not claimed; `bun run e2e` is green.
