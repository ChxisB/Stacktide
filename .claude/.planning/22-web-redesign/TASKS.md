# 22 Web redesign - Tasks

Gate for every task: `bun run check` (typecheck + lint + test). The web tests need Postgres: `bun run dev:db`.

### RDS-1 - Carebell tokens and the forced-theme sets  `[x]` S - deps: none
Do: in `apps/web/src/styles.css` put the Carebell values under the existing token names and add the new ones (`--raised --line-strong --field-line --slate-tint --mint --sun-tint --danger-tint --aqua-tint --hl --active --idle --action --on-action`); write dark twice (media guarded by `:root:not([data-theme="light"])`, which is also what lets a forced light beat a dark system, and `:root[data-theme="dark"]`); `:root[data-theme="light"]` only sets `color-scheme`. Update `styles.test.ts` to read the new blocks.
Done when: `styles.test.ts` passes and gains two cases: the media dark set equals the `[data-theme="dark"]` set, and the new text-on-tint pairs reach 4.5:1 in both sets.

### RDS-2 - Self-hosted fonts  `[x]` S - deps: none
Do: add `@fontsource-variable/plus-jakarta-sans` and `@fontsource-variable/jetbrains-mono` (OFL; no request to a third party), declare their Latin files in `styles.css`, set `--font` and `--mono` with `system-ui` and `ui-monospace` fallbacks. If Bun's HTML import does not bundle the woff2 files, stop, keep the system stack, mark `[!]` and say so.
Done when: `bun build apps/web/index.html --outdir <tmp>` carries the fonts (it inlines them as `data:` URIs, see LOG.md), and `server.test.ts` (serves the page and its assets) still passes.

### RDS-3 - Base elements restyled  `[x]` M - deps: RDS-1
Do: CSS only, no markup change: type scale, pill buttons (primary uses `--action`), 44px targets, fields with the 1.5px field line, cards at 28px radius, tables (caps header, row hover, 56px rows, horizontal scroll inside `.matrix`/`.scroll`), tags and `.status-*`, `.diff-*`, focus ring, `prefers-reduced-motion`. Keep every existing class name.
Done when: `bun run check` is green with no test file changed; `styles.test.ts` still finds no colour outside the token sets.

### RDS-4 - Theme toggle  `[x]` S - deps: RDS-1
Do: `useTheme()` in `apps/web/src/theme.ts` (reads and writes `localStorage` in try/catch, sets `data-theme` on `document.documentElement`, falls back to following the system) and a `ThemeToggle` segmented control (`aria-pressed`, labelled "Dark" and "Light") in `components.tsx`.
Done when: `theme.test.tsx`: choosing a theme sets the attribute and is read back on the next mount; a throwing `localStorage` leaves the toggle working for the session; the control is reachable by keyboard.

### RDS-5 - Shared components  `[x]` M - deps: RDS-3
Do: `components.tsx`: `PageHead` (eyebrow, h1, lede, actions), `Card` (title, sub, actions), `StatusBadge` (tone `ok|bad|warn|active|manual|quiet`, inline SVG glyph `aria-hidden`, the text is always rendered), `Kpi` (label, value, unit, foot; no delta or meter until a screen has a trend), `Chips` (a group of `aria-pressed` buttons with optional counts). Their CSS from the design's `console.css`, written against the token names.
Done when: `components.test.tsx`: each renders; `StatusBadge` shows its text and exposes no glyph to assistive technology; `Chips` marks one pressed and calls `pick` with a keyboard Enter and Space.

### RDS-6 - Shell: sidebar and top bar  `[x]` M - deps: RDS-4, RDS-5
Do: rewrite `shell.tsx`: sidebar (brand mark, `OrgSwitcher` as the `.org` pill, grouped `<nav aria-label="Main">` with an inline SVG icon per link, the user and Sign out), top bar (breadcrumb "section › page", `ThemeToggle`). Under 900px the sidebar sits above the page. Keep the skip link, `ErrorBoundary`, link names, `aria-current="page"`, `<main id="main" tabIndex={-1}>`.
Done when: `app.test.tsx`, `organizations.test.tsx` and the e2e navigation helper pass unchanged; a new case shows the breadcrumb follows the route and the current link has `aria-current`.

### RDS-7 - Page heads  `[x]` S - deps: RDS-5, RDS-6
Do: the ten wrappers in `app.tsx` render `PageHead` (eyebrow and lede per page, same h1 text, actions slot where a page already has a primary action).
Done when: every `getByRole("heading", { name })` in the tests still passes; a case checks each page's eyebrow is present.

### RDS-8 - Home  `[x]` M - deps: RDS-5, RDS-7
Do: Home shows `Kpi` tiles from data the app already loads (projects imported, GitLab connections; open findings dropped, as findings are per project) above the getting-started checklist, which becomes a `Card` with a step list and a `Glyph` per step. No new endpoint, no chart.
Done when: `app.test.tsx` and `onboarding` assertions pass; a new test against the real test backend shows the counts, and an empty organisation shows zeros and the checklist.

### RDS-9 - Status screen  `[x]` M - deps: RDS-5, RDS-7
Do: `runs.tsx`: `StatusBadge` replaces `tag status-<tone>` (tone map unchanged), a `Chips` filter by tone (All, Failed, Running, Passed, Other) with counts, rows and Retry unchanged.
Done when: `runs.test.tsx` passes with its class assertion (line 192) changed to the badge contract, and says so in LOG.md; new cases for the filter and its counts.

### RDS-10 - Projects and the connect/import wizard  `[x]` M - deps: RDS-5, RDS-7
Do: `projects.tsx`: `Card` per section (imported projects, the import flow, the connect form), `StatusBadge` for the imported and archived marks. No `Chips` (the screen has no filter) and no connection state badge (the API gives none to show). No behaviour change.
Done when: `projects.test.tsx` and `journey.test.tsx` pass unchanged.

### RDS-11 - Variables  `[x]` M - deps: RDS-5, RDS-7
Do: `variables.tsx`, `variable-parts.tsx`, `variable-history.tsx`, `variable-import.tsx`, `variable-rotation.tsx`: the grid and the environment form in `Card`s, `.mask` and reveal styling. Left out: environment `Chips` (the grid already has a column per environment; a filter would hide columns, a new behaviour) and diff rows (this screen shows none; the panels were already cards). Values stay masked by default.
Done when: `variables.test.tsx`, `variables.history.test.tsx` and `variables.rotation.test.tsx` pass unchanged; the leak assertions still pass.

### RDS-12 - Sync  `[x]` M - deps: RDS-5, RDS-7
Do: `sync.tsx`: target cards with a `StatusBadge` for drift and for each result, plan rows marked `+ ~ -` (key names only), Plan sync in the card head. Apply and dry run stay per target (they act on one target, so they cannot live in the page head).
Done when: `sync.test.tsx` passes unchanged.

### RDS-13 - Pipeline builder  `[x]` M - deps: RDS-5, RDS-7
Do: `pipeline.tsx`, `pipeline-delivery.tsx`: template choice as selectable cards, steps as the design's stepper, YAML diff in a code box (`.diff-add` and `.diff-del` stay; it already was one), MR state as `StatusBadge` (left out: the screen shows no MR state, only a link).
Done when: `pipeline.test.tsx` passes unchanged.

### RDS-14 - Findings  `[x]` S - deps: RDS-5, RDS-7
Do: `findings.tsx`: severity and status as `StatusBadge` (critical and high = bad, medium = warn, the rest idle; open = manual, resolved = ok), `Chips` for severity and status filters with counts (left out: the status filter is the `Show` select the tests drive, and the API filters by it, so counts per status are not known; see LOG.md).
Done when: `findings.test.tsx` passes unchanged except any assertion that read a class, listed in LOG.md.

### RDS-15 - State  `[x]` S - deps: RDS-5, RDS-7
Do: `state.tsx`: versions and resources in cards, and the lookup form in a card (left out: lock state and restore and unlock controls; this screen is a read-only look, the API gives no lock state here, and there is nothing to put in the page head).
Done when: `state.test.tsx` passes unchanged.

### RDS-16 - Settings, tokens, identities, pools, organisations and SSO  `[x]` M - deps: RDS-5, RDS-7
Do: `settings.tsx`, `tokens.tsx`, `identities.tsx`, `pools.tsx`, `organizations.tsx`, `sso.tsx`: `Card` sections and a `kv` summary list (the `dl` elements, styled as a two-column grid). A token is still shown once. Left out: role tags in the member table and `Chips` for secret gate and role (a role is not a state, and no screen filters by either; see LOG.md).
Done when: `settings.test.tsx`, `identities.test.tsx`, `pools.test.tsx`, `organizations.test.tsx` and `sso.test.tsx` pass unchanged.

### RDS-17 - Look at it in a browser  `[x]` M - deps: RDS-6 .. RDS-16
Do: start `apps/web/e2e/server.ts` (mock backend), take Playwright screenshots of every route in dark and light at 1440 and 390 px, read them, fix overflow, clipped text and unreadable pairs. Save no screenshots in the repo.
Done when: every route read in both themes and both widths, no horizontal page scroll at 390 (asserted by one e2e check on `document.scrollingElement`), and `bun run e2e` green or its absence stated.

### RDS-18 - Delivery  `[x]` S - deps: RDS-17
Do: write `.claude/completions/<date>-22-web-redesign.md`, set the ROADMAP row to done with what stays a human gate, list the left-out screens in the backlog.
Done when: the completion file and ROADMAP row exist and `bun run check` is green.
