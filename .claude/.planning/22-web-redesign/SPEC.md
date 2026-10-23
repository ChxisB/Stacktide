# 22 Web redesign - Spec
Prefix: RDS · Milestone: M5 · Status: done · Needs: 08 (web-ui)

## Goal
Give the web UI the look, layout and components of the Carebell redesign, on the screens that exist today, without changing what any screen does. Design source: https://claude.ai/artifact/MboN3YR3wLJzG52Ne3Znj9 (14 boards, six shared components, a components sheet and a data-models sheet).

## What the design is
- **Tokens**: Carebell, dark first, a light set, and a toggle. Plus Jakarta Sans for text, JetBrains Mono for keys, refs and logs.
- **Layout**: a 264px sidebar (brand mark, organisation switcher, grouped navigation with icons, the signed-in user) and a top bar (breadcrumbs, theme toggle). Under 900px the sidebar becomes a top block.
- **Components**: page head (eyebrow, title, lede, actions), card, KPI tile, status badge (a shape glyph plus text, never colour alone), filter chips, data table, log box.
- **Status**: ok = check, bad = cross, warn = bang, active = half circle, manual = pause, idle = dash.

## Scope
Style tokens and a theme toggle; self-hosted fonts; the shell; five shared components (`PageHead`, `Card`, `StatusBadge`, `Kpi`, `Chips`); a restyle of the ten screens that exist: Home, Projects, Variables, Sync, Pipeline, Status, Findings, State, Settings, Organizations.

## Non-goals (left out on purpose, see the backlog in ROADMAP)
- **Overview charts** (run volume, durations, failure heat map, sparklines): no API answers run history, only the latest run per branch. Needs a history route first.
- **Run logs viewer** (search, level filters, folded sections, minimap): the API has no job-trace route. One would carry text that can hold secrets, so it needs its own SPEC, masking and `/security-review`.
- **Stacks screen**: no stack list or plan-diff endpoint is shaped for a page yet.
- Renaming navigation labels (the design says Overview and Pipelines; the app says Home and Status). Tests and the e2e journey find links by those names.
- A new dependency for charts or icons. Icons are inline SVG.
- The Components and Models sheets as an in-app style guide.

## Design
- **Keep the markup, change the skin.** About 170 assertions find tables, rows, headings, labels and `[role=alert]` by role. Screens keep their native `<table>`, `<label>` and `<button>`; the new look is CSS on those elements. A few tests hold a class contract (`.org`, `.diff-add`, `.diff-del`, `p.warn`, `tag status-<tone>` in `runs.test.tsx`); a task that changes one changes that test in the same commit and says so in LOG.md.
- **Token names stay** (`--bg --surface --text --muted --border --accent --accent-text --danger --ok --warn --focus`); Carebell values go in. New tokens are added beside them (`--raised --line-strong --slate-tint --mint --sun-tint --danger-tint --aqua-tint --hl --active --idle`). `styles.test.ts` keeps enforcing: every colour only in the token sets, a dark value for every colour, WCAG AA on the listed pairs. It gains the new pairs and the forced-dark set.
- **Theme**: follows the operating system by default. The toggle sets `data-theme` on `<html>` and is remembered in `localStorage` as a per-viewer convenience (read and written in try/catch; the page works without it). Dark is written twice, as the design system asks: under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme="light"])`, and under `:root[data-theme="dark"]`. A test pins the two sets equal.
- **Fonts**: self-hosted (variable woff2 through `@fontsource-variable`), so no request leaves for a third party and the page needs no CSP exception. The stack falls back to `system-ui` if a file fails.
- **Shell**: `<nav aria-label="Main">` with the same link names and `aria-current="page"`, skip link and `ErrorBoundary` unchanged. Navigation is grouped, the organisation switcher stays a `<select>` inside `.org`.
- **Components** live in `apps/web/src/components.tsx`, each small, typed, tested, and used by at least two screens (one use stays a local piece of that screen).
- **Accessibility**: 44px targets, a visible focus ring, glyph shapes with text for status, `prefers-reduced-motion` respected.
- **Secrets**: no screen gains a value column. Masked values keep the `.mask` look; reveal behaviour is untouched.

## Acceptance
- `bun run check` is green and no test was weakened, skipped or deleted (changed tests are listed in LOG.md with the reason).
- Every route renders in dark and light at 1440 and 390 px with no horizontal page scroll and no unreadable text (RDS-17 screenshots).
- The Playwright journey (UI-9) still passes.
- A reviewer can switch theme from the top bar and the choice survives a reload.

## Risks
- **Test brittleness**: a class rename breaks a test far from the change. Mitigation: grep the class in `*.test.tsx` before renaming; prefer adding classes to renaming them.
- **Fonts and the Bun bundler**: whether `@fontsource-variable` CSS and its woff2 files bundle through an HTML import is unproven. RDS-2 is a spike with a system-font fallback.
- **Dark and light were never rendered in the design canvas** (it was authored without a render). Contrast is checked by test, layout by RDS-17.
- Real GitLab is not involved; nothing here writes to an external system.

## Open questions
- Adopt the design's navigation names (Overview, Pipelines) later? Needs a test and e2e sweep; not done here.
- Which of the three left-out screens first? Suggest Stacks, then Run logs (needs a security decision), then Overview charts.
