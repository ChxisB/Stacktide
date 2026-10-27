# 32 UI redesign - done 2026-10-23

**Design:** https://claude.ai/artifact/3uXmNbS92iQiCxu79fJsy6 (Version 24, two pages: style and screens). The boards were read as markup, not rendered.

One standard (tokens, motion, buttons, fields, cards, callouts, tables, drawer, dialog, toast), the shell with a phone menu, and every screen redrawn on it. Built on the go of 2026-10-23: the design approved and all 15 SPEC questions at the recommended answer (so question 5: no eyebrow above a page title). **No API, database, guard or dependency change** in any task.

## What was built
- **A, the standard (UXR-1..6).** Tokens and motion rules (CSS only; a `transition` names only opacity, colours or filter), a reduced-motion guard, buttons, fields, checks and the secret field, cards, KPI, badges and tags, callouts, empty states and skeletons, tables.
- **B, overlays and feedback (UXR-7..10).** Motion for drawer, popover and menu; the dialog; the toaster; the page enter.
- **C, the shell (UXR-11, 12).** Sidebar, top bar, theme toggle; below 900 px the sidebar is a menu (a modal dialog: Tab stays inside, Esc closes, focus returns to the opener).
- **D, the screens (UXR-13..28).** Sign-in, Home, Projects, Pipeline, Status (runs, Retry, approval, jobs panels), State, Sync (plan, apply), Variables (list, matrix, edit, delete, bulk delete), Findings, Organizations, Settings (Connections and Worker pools, Single sign-on, Sign-in methods and API tokens). `ErrorPanel` changed for all 35 call sites and `Callout` gained an `action`.
- **E, checks and delivery (UXR-29..31).** Two tests in `styles.test.ts` (every `animation` has a reduced-motion override; the primary button pair after the filter), no token change was needed; a phone journey in `e2e/journey.e2e.ts` (menu, Settings, back by keyboard, Esc); 390 px pictures of every route plus the open menu in `demo/shots.e2e.ts`; the eyebrow removed (the prop, ten callers, the CSS) after the pictures showed it on every screen; `docs/demo.md` updated.

## Existing tests that moved (each a finding in `32-ui-redesign/LOG.md`; no assertion weakened, none skipped or deleted)
Controls that moved into a dialog, drawer or toast changed how their tests reach them (UXR-14 to UXR-28, each entry lists them). The Cut D gate also moved e2e and demo reaches (`journey.e2e.ts`, `keyboard.e2e.ts`, `shots.e2e.ts`) and three instruments of `align.e2e.ts`. In Cut E: `pages.test.tsx` (now asserts for each of the ten routes one `h1`, no `.eyebrow`, a lede, and the section as the breadcrumb's first item) and `components.test.tsx` (`PageHead` without `eyebrow`).

## Gate, stated plainly
- `bunx biome check .`: clean apart from one old info (`apps/api/src/limits.test.ts`, useTemplate). `bun run typecheck`: clean.
- Root suite **6689 pass, 11 skip, 0 fail**. `apps/web` suite **1131 pass, 0 fail**. `bun run e2e` **13 passed**.
- `bun run demo:keys` 1 passed (the phone menu in 6 presses). `bun run demo:align` 4 passed, 0 findings at 1280 and 390 in both themes. `bun run demo:shots` ran after the eyebrow change (76 pictures, 2 tests).
- **`bun run check` as one command was not run at the end.** An outside SIGTERM stopped its test step twice during this feature, so its parts were run one after another, as above.
- Known load-flaky tests failed at times under load and passed alone: `projects.test.tsx` "set up is not said before the connections arrive", `variables.folderviews` "inside /payments", `variables.details` description edit, `variables.test` "adding" tests, `apps/cli/src/auth.test.ts`, `packages/db/src/stacks.test.ts`, the worker entrypoint tests, `createTestDb > drop`. A real race in `variables.matrix` was found and fixed.

## Checks beyond the tests
- **`web-design-guidelines`** (rules fetched fresh): Cut A none; Cut B one finding, fixed (`overscroll-behavior: contain` on `.dialog-body` and `.drawer-body`); Cut C none; Cut D no new defect. **Not repeated in Cut E** (the UI files changed there only by deletion). Items not taken: `touch-action`, `theme-color`, input `name`s, a `…` in placeholders.
- **`accesslint` scan** on the running demo: ten routes, nine clean; **Variables has one critical finding** (`accessible-authentication`: the quick-add value field has `autocomplete="off"` on a password-type input). It is feature 30's field, left as your call. The audit Chrome's viewport was not set, so the 390 px pages were checked by `layout.e2e.ts` (no sideways scroll, both themes), not by the scan. The tool's text waits time out on a signed-in page; a selector wait was used.
- **`accessibility-inspect` (the manual tier) was not run** for any of: the dialog, toast, phone menu, the State form, the Sync disclosure and dialog, the UXR-22 to UXR-28 drawers and dialogs. Names, roles, Esc and focus return are asserted in tests and the phone menu is driven by keyboard in `demo:keys` and the journey; that is evidence, not the manual tier. Do not read this feature as audited by hand for a screen reader.
- **`/code-review`** ran at the Cut gates up to D, with fixes made and some items declined (reasons in the LOG). For Cut E it was a hand review (see UXR-31 LOG). **`/security-review`** (Cut D, token handling and SSO count): nothing at 8 of 10 or above; one informational item (the SSO save lacks `gcTime: 0`); the server-side SSO link was not reviewed. Not run for Cut E.
- **Pictures:** every route at 1280 and 390, both themes, was taken; each task's own pictures were read when it landed, and UXR-30 read the light set and most of the dark set. Not re-read at the end: every other dark 390 and the Variables overlays add-env, changes, column menu, envs, history, new menu and select.

## Left as it is, on purpose
- `--radius`, `--radius-field`, `--radius-tile`, `--radius-pill` stay: 14 rules still use them (UXR-31 deletes only unused tokens). `Drawer centered` and `Popover` stay for the same reason. `docs/` has no style page.
- Maximum of four rules in the SSO role-rules form (`MAX_RULES = 4`), deliberate.
- UXR-10's "no animation on first paint of cached data" is built as no animation on the first page the app opens on, and none from a refetch or a cache hit (if you meant that a cached page should not enter-animate when you return to it, say so; the LOG entry has the detail). `shots.e2e.ts` forces end-state animations so a picture is not taken mid-motion.

## Follow-ups for your decision
1. **Variables quick-add `autocomplete="off"`** (the accesslint critical above): remove it, or keep it so a password manager does not offer to save a variable value.
2. **Phone, Variables folder rows** wrap "1 variable" onto two lines and stack Open, Rename and Delete in three rows at 390. Not on any board; a one-line count and a row of actions would fix it.
3. **Phone tables scroll inside their cards** (the page does not scroll sideways). `div.scroll` is not a tab stop; whether a keyboard user can scroll a wide table depends on the browser, and this was not tested. Wanted as it is, or make it focusable.
4. **"Import 0 selected"** still reads at zero (UXR-26).
5. **The phone menu button's tint** in two 390 pictures looks like the pointer's hover; not verified.
6. **Focus** after a Dialog and a Drawer close together, after the first connection from the empty state and after a Findings dismissal: the `useModal` fallback to `#main` may cover it; only the phone menu's focus return is asserted end to end.
7. **Mid-save dismissal** of `AddConnection` and of the Variables drawers was not checked.
8. **Toast under a drawer** (Cut B, left as a choice you may want to change): the toast's z-index (20) is under the drawer's scrim (40) so it never sits over a dialog's buttons. A toast made while a drawer stays open is behind it (a screen reader still hears it). Screens report from inside a drawer by closing it first or keeping an inline status.
9. Small ones: `Empty` has a fixed `h3`; screens with their own error treatment may replace `ErrorPanel`'s callout; `.center` is used only by `AuthGate`'s pending line; the "Role rules" legend in the SSO drawer; `.detail-actions` is reused by SSO and could be renamed.
