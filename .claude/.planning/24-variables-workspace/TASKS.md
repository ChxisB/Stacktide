# 24 Variables workspace - Tasks

Gate for every task, from the repo root: `bunx biome format --write apps/web/src`, `bunx biome check apps/web`, `bun run typecheck`, then `cd apps/web && bun test --env-file=../../.env.example` (needs Postgres: `bun run dev:db`). Tasks that touch the API or `packages/` run `bun run check`. The last task runs `bun run check` and `bun run e2e`.

Each task leaves the app working: the matrix stays the default view until VWS-6.

### VWS-1 - The Secrets view  `[x]` M - deps: none
Do: the Variables page gets a view switch, "Secrets" and "Compare environments" (the matrix, unchanged, still the default). Secrets has an "Environment" select and a table of Name / Value / Source for that environment from `resolved-variables` (same query key as the matrix). Plain values show; secret and file values show the fixed mask and "Hidden value" for assistive technology; Source is the Organization / Project / Environment badge. A project with no environment says so and offers the existing "Add an environment" form.
Done when: `variables.list.test.tsx` shows one row per resolved variable by role and name, the secret fixture value is nowhere in the document, choosing another environment shows that environment's rows, and the existing Variables tests pass unchanged.

### VWS-2 - Search  `[x]` S - deps: VWS-1
Do: a "Search variables" box over the table that keeps rows whose name (case-insensitive) or plain value contains the text; a secret's value is never searched (it is not in the page). "No variables match" when nothing does.
Done when: a test types a part of a name, a part of a plain value and a part of the secret fixture value, and sees the first two narrow the table and the third match nothing.

### VWS-3 - Keys that do not resolve  `[x]` S - deps: VWS-1
Do: (revised 2026-10-20, see LOG: `resolved-variables` returns each value with its references already filled in, so a `${KEY}` never shows in it; marking references in the value as written moves to VWS-4, where the row is read by id.) A key the resolver could not fill in (missing reference, loop, depends on one that cannot) has no variable in the resolved set, so it gets a row from the `issues`: its name, "Does not resolve: ..." with the reference named in a `mark`, and source "Unknown". Every key of a loop gets a row. The `mark` sets its own colours from existing tokens.
Done when: tests find the row of a key with a missing reference with the `mark` text `${NOT_THERE}` and source "Unknown", and a row for each key of a loop, found by search; `styles.test.ts` pins the `mark` rule's colour pair at 4.5:1 in the light and the dark set (seen failing first).

### VWS-4 - Details of a row  `[x]` M - deps: VWS-1
Do: a row's name is a button that opens its details beside the table (below it on a narrow screen), in a region named by its card title: kind, source, version, last updated, the description (read by id, "No description" when empty), a plain variable's value as written with each `${KEY}` in a `mark` (the by-id read returns the template, not the filled-in text), and where a lower level holds the same key, "Overrides the Project value". The existing Edit, Override, History, Rotation and Delete components sit in it as visible buttons, named as in the matrix. Closing returns focus to the row's name.
Done when: `variables.details.test.tsx` opens a row and edits its description, deletes it, and opens its history and rotation, each through the same components (the matrix tests for those still pass); the secret fixture value is not in the details until Reveal is pressed there; a plain value written `${DB_HOST}:5432` shows `${DB_HOST}` in a `mark`.

### VWS-5 - Add and Import in the toolbar  `[x]` S - deps: VWS-1
Do: next to the search, two visible buttons, "Add variable" and "Import", opening the existing add form (with the chosen environment preselected) and the existing import.
Done when: a test adds a variable from the toolbar and sees it in the table after the refresh, and opens Import; the add form's tests still pass.

### VWS-6 - Secrets is the default view  `[x]` S - deps: VWS-1..5
Do: the page opens on "Secrets"; "Compare environments" keeps the matrix. One helper in `variables.fixture.tsx` opens "Compare environments" for the existing matrix tests; the e2e journey gets the same step; `e2e/layout.e2e.ts` shoots both views at 1280 and 390 px with no sideways scroll.
Done when: the existing Variables tests pass with only the helper changed (no test body weakened), `bun run e2e` passes, and a shot of each view was read at 1280 and 390 px.

### VWS-7 - Reveal all  `[x]` M - deps: VWS-1 - gate: `/security-review`
Do: a "Reveal all" button on the Secrets view, shown only to a person who may reveal (a 403 shows "You cannot reveal values here" and nothing else), that calls `resolved-variables/values` for the chosen environment and shows every value for `REVEAL_MS`, then hides them; "Hide all" hides at once. The answer is held in component state only (not the query cache), and is cleared on timeout, on a change of environment, on a change of project and on unmount.
Done when: tests prove that no value is in the document before the click, all are after it, none after the time, after Hide all, after changing environment and after unmount; that only the `/values` route was called; and that the 403 message appears with no value anywhere. The API tests that already cover the route's guard, rate limit and audit rows still pass.

### VWS-8 - Download .env  `[x]` M - deps: VWS-7 - gate: `/security-review`
Do: move `dotenvLine` (and `shellLine`) from `apps/cli/src/format.ts` to `packages/core` (the CLI imports it back, its tests move with it unchanged). A "Download .env" button on the Secrets view reads the same `/values` route, builds the file in memory (a `Blob`, named `<project>-<environment>.env`), starts the download and drops the text. A line above the button says the file holds secret values.
Done when: a core test round-trips values with quotes, newlines, `$` and `#` through `dotenvLine` and `parseDotenv`; a web test checks the file text for a plain and a secret value, that the file name holds no value, that nothing is left in the document or query cache afterwards, and that a 403 downloads nothing.

### VWS-9 - A changes feed (API)  `[x]` M - deps: none
Do: `GET /organizations/:orgId/projects/:projectId/variable-changes` (query: `environmentId?`, cursor and limit as `audit-events`), newest first, from `variable_versions` joined to `variables`: key, kind, level, environmentId, version, actor kind and id, reason, time. Guard `variable.read`; `noAudit` with the reason. No value in any field.
Done when: API tests show the order and paging, the environment filter, that a variable of another project or organization never appears, the deny-by-default case in the authz matrix (a role below reporter gets 403, as for the list), and a leak test: the secret fixture value is in no response body and no log line. `bun run check` passes.

### VWS-10 - The Changes card  `[x]` S - deps: VWS-4, VWS-9
Do: a "Changes" card under the Secrets list for the chosen environment (or the whole project when none is chosen): a row per change, "<who> changed <KEY> to version N", the time, the reason when there is one; "Load more" pages it. A key opens its row details.
Done when: a test renders the rows from a fixture response and pages once; the card has no value (leak test with the secret fixture value).

### VWS-11 - Delivery  `[x]` S - deps: VWS-6..10
Do: `bun run check` and `bun run e2e`, `/code-review` of the diff, `/security-review` of VWS-7..9 (already run per task, run once more over the whole diff), the completion file `.claude/completions/YYYY-MM-DD-24-variables-workspace.md`, ROADMAP row 24 set to done.
Done when: both gates are green, the reviews' findings are fixed or logged, and the completion file exists.

## Tags (Q1 answered yes on 2026-10-20: "build it similar to how Infisical")

### VWS-12 - Tags in the database  `[x]` S - deps: none
Do: `packages/core/src/tags.ts` (no imports, also the `@orch/core/tags` subpath for the web): the tag pattern (`[a-z0-9-]`, 1 to 24 characters), at most 8 a variable, and `parseTags(text)` (split on commas and spaces, lowercase, no repeats, sorted). A forward-only, additive migration: `variables.tags text[] NOT NULL DEFAULT '{}'` with a check that holds the same limits. `createVariable` takes `tags`, `setVariable` takes `tags` (a patch of tags alone is a change), the row carries them.
Done when: a core test for `parseTags` and the limits; db tests that tags are stored on create, replaced by a patch (and a patch of tags alone makes no new version), come back from the reads that return a variable, and that the check refuses a ninth tag, a 25-character tag and an upper-case one; the migration is additive (a row made before it reads as no tags).

### VWS-13 - Tags in the API  `[x]` S - deps: VWS-12
Do: create and patch bodies take `tags` (at most 8, each matching the pattern, repeats dropped, sorted); the patch needs a value, a description or tags; every variable the API returns (list, by id, resolved set) carries `tags`; a change of tags is audited as part of `variable.update` (the fields list). No new route, no new guard: the same permission that edits a description edits tags.
Done when: API tests for create with tags, patch of tags alone, an invalid tag and a ninth tag (422), tags in the list, the by-id read and `resolved-variables`, the audit row naming `tags` among the fields (and holding no value), a reporter refused (the existing guard), and a variable of another project never changed; `docs/openapi.json` regenerated; the operation count in `spec.test.ts` unchanged (no route added).

### VWS-14 - Tags in the Secrets view  `[x]` M - deps: VWS-13
Do: chips next to the name in each row; a "Tag" select above the table that narrows it to one tag (all of them when "All tags"); search also matches a tag; the details show the tags; "Edit description" becomes a form with the description and a "Tags" field (comma or space separated, `parseTags`) so one Save patches both; the Add form has the same "Tags" field. Chips use the existing `tag` class; no new colour.
Done when: web tests for chips on the right rows, the filter, search by tag, editing tags from the details (and the chips change without a reload), adding with tags, an invalid tag showing the API's message, and the matrix tests unchanged; `styles.test.ts` rule if a class is added; the layout journey still passes and a shot is read at 1280.

## Folders (Q2)
Not tasked here: a folder changes how a key resolves, syncs, imports and addresses, so it is planned as its own feature with an ADR (27-variable-folders), for approval.
