# 22 web-redesign - done 2026-10-20

Design source: the Carebell redesign (14 boards, six shared components). The work is in the real web app, `apps/web`, on the ten screens that exist. Nothing a screen does was changed. Nothing is committed.

## What was built
- **RDS-1** Carebell tokens: a light set, a dark set for a dark system and an identical forced-dark set for the toggle, plus the extra tokens the design uses (`--raised`, `--action`, `--hl`, the tints, the radii). `styles.test.ts` fails on a hex colour outside the three token sets, on a `var()` that names no token, on a dark set that differs from the forced one, and on a text, muted, action or status pair under WCAG AA 4.5:1.
- **RDS-2** Plus Jakarta Sans and JetBrains Mono, self-hosted from `@fontsource-variable` (no request leaves for a font). Only the Latin subset is declared, two `@font-face` rules costing 98 KB in the stylesheet; a glyph outside Latin falls back to the system font.
- **RDS-3** The base elements restyled in place (buttons, fields, tables, fieldsets, tags). The markup stays native, so every test that finds things by role and name still does.
- **RDS-4** `theme.ts` and a `ThemeToggle`: the choice is kept in `localStorage` (`orch.theme`), applied as `data-theme`, and the page follows the system until one is made.
- **RDS-5** Shared components in `components.tsx`: `PageHead`, `Card`, `StatusBadge` (a shape glyph with the word, never colour alone), `Glyph`, `Kpi`, `Chips`, `ThemeToggle`.
- **RDS-6, RDS-7** The shell: a grouped sidebar with icons, the organisation switcher and the signed-in person, a top bar with breadcrumbs and the toggle, and a page head (eyebrow, title, lede) on every page. Under 900 px the sidebar becomes a block above the page. `pages.test.tsx` keeps the page heads and the sidebar groups in agreement.
- **RDS-8 to RDS-16** Home (tiles and the checklist), Status (filter chips, badges, retry), Projects and the import wizard, Variables, Sync, the Pipeline wizard (a pill stepper, template tiles), Findings, State, and Settings with its tokens, sign-in methods, worker pools, SSO and the Organizations page, each in the new skin and on the shared components.
- **RDS-17** A look in a real browser: every route in both themes at 1440 and 390 px. It found overflow at phone width on five screens, tables capped at 60 rem, four screens held in the narrow form column, row headers in capitals, and a link out of line with its button; all fixed. `e2e/layout.e2e.ts` opens every route fresh at 390 px in both themes and fails if the page scrolls sideways.
- Docs: none changed; the feature is in `.claude/.planning/22-web-redesign/` (SPEC, TASKS, LOG).

## Reviews (once over the whole feature, not per task)
- **`/code-review`: 14 findings.** Five fixed test first: a chosen filter chip lost its contrast on hover; the stored theme was applied after the first paint (a white flash on every load for a dark choice on a light system), so `index.html` now applies it in the head; the toggle did not follow the system when it changed; the Home tiles hid the connections tile on any error, not only on a refusal; and the layout e2e could measure a page before its table arrived. One comment corrected. The rest declined with the reason in the LOG (an open finding reads as waiting, not failed, as RDS-14 specified; `eyebrow` duplicated from `pages` and pinned by a test; a narrower local `Tone`; the inlined fonts and their install path; the retry tests scoped to the table; avatar initials on odd names; hover contrast of a tag on a hovered row).
- **`/security-review`: not run.** No auth, crypto, secrets, token handling, webhooks or sync adapter was touched; no new route or request was added. The one new inline script in `index.html` reads one `localStorage` key and sets one attribute.

## Results
Final `bun run check`: green (5094 API and package tests, 382 web tests, typecheck, lint); it failed once on the identities flake and passed on the next run. Web: 382 tests pass, 0 fail (it was 315 before this feature); `bun run e2e`: 3 passed (the journey and two layout cases). Existing tests were never weakened, skipped or deleted. Two were edited, both logged under RDS-9: the class assertion on a status became the badge contract (`st st-<tone>` with an `aria-hidden` shape), and two button lookups were scoped to the table because the filter chips are buttons.
New dependencies: `@fontsource-variable/plus-jakarta-sans` 5.3.0 and `@fontsource-variable/jetbrains-mono` 5.3.0 (fonts, no code). Migrations: none. API: unchanged.

## Invariants
No screen shows more than before: no secret, token or value reached a new place (the Variables and token screens keep their masking and their one-time panels, and the journey e2e still asserts the page holds neither the secret nor the GitLab token). No request to GitLab or a target was added. The control plane holds no cloud credentials, and nothing here changes that.

## Left out on purpose (also in the ROADMAP backlog)
- Not built, because the API has nothing for them: the design's Overview charts (a run-history API), the Run logs viewer (a job-trace route, masking and a `/security-review`), the Stacks screen (list and plan-diff endpoints), and the design's own navigation names.
- On restyled screens, parts of the design with nothing behind them: a Kpi delta and meter, an open-findings tile, a "follow the system" theme button, environment chips and diff rows on Variables, sync apply and dry run in the page head, a connection-state badge on Projects, an MR-state badge, findings chips, role tags, a state lock badge and its controls.
- Polish: the sidebar is about 400 px tall at phone width; a tag and a hovered row share a tint; a hover contrast pair is not tested.

## Not verified / human gates
- **Judging it against the design in your own browser.** The screens were checked in headless Chromium on a seeded scratch stack; I read about half of the 40 screenshots by eye (home, status, variables, projects, pipeline, state, sync, findings, organisations and settings in dark at 1440, plus state light 1440 and status and variables light 390). The rest were checked by the overflow probe and the console, and contrast by the WCAG pairs in `styles.test.ts`, not on the screenshots. Only the first step of the pipeline wizard was shot; steps 2 to 4 and the result were checked by tests, not by eye.
- A known flake, not caused by this feature: `identities.test.tsx` "giving one up asks first" fails about one run in three on its own, and failed 6 of 12 runs on the committed HEAD before the redesign (a 20 s timeout). It is unfixed. When a full run shows only that failure, run the file alone.
- Real GitLab was never touched. Nothing was committed, pushed or published.
