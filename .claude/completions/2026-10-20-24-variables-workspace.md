# 24 variables-workspace - done 2026-10-20

An Infisical-style Variables page: a Secrets view that is the default (a list for one environment, search, a row's details beside it, Add and Import in the toolbar), "Reveal all" and "Download .env" on the existing audited export route, keys that do not resolve shown as rows, and a Changes card fed by a new project-wide changes route. Compare environments stays as the second view. Tags (Q1) were added afterwards as VWS-12 to VWS-14 (see "Tags" below). Folders (Q2) change how a key resolves, so they are planned as feature 27 and not built. Nothing is committed.

## What was built
- **VWS-1..2** The Secrets view (one environment: name, value, source) and a search box (names, and plain values; a secret's value is not in the page, so it is not searched).
- **VWS-3** Keys that do not resolve (a `${REF}` to nothing, a loop) are rows with their reason. *Scope changed from the SPEC:* its premise (a mark on the existing matrix cell) was wrong; the marks moved into VWS-4 and no new token pair was added.
- **VWS-4** A row's details (value, description, kind, source, version, last updated) with every action the matrix offers: edit, describe, override, history, rotation, delete.
- **VWS-5** Add and Import in the toolbar (wording differs from the SPEC's).
- **VWS-6** Secrets is the default view; Compare environments is the switch's other side. The view is held above the project (not in the SPEC) so a change of project keeps it. *The SPEC said "only the helper changes"; that was impossible:* 76 setup lines (`await showCompare();`) were added across 5 test files, no assertion changed.
- **VWS-7** Reveal all / Hide all: reads `.../resolved-variables/values` (audited, `secret.reveal`, rate limited, `no-store`), holds the answer in component state only (not the query cache), hides on a timer, Hide all, another environment, another project, unmount, and (from the review below) after any write.
- **VWS-8** Download .env: the same route, one `dotenvLine` per variable, a Blob in memory, a file named `<project>-<environment>.env`, the address revoked at once. `dotenvLine` moved to `packages/core/src/dotenv.ts` (subpath export `@orch/core/dotenv` so the browser bundle does not pull core's barrel); `@orch/core` moved to the web's dependencies. `shellLine` was **not** moved.
- **VWS-9** `GET /organizations/:orgId/projects/:projectId/variable-changes` (guard `variable.read`, `environmentId?`, paged by the version row's uuidv7): one row per version written, newest first, no value. `listVariableChanges` in `packages/db`.
- **VWS-10** The "Changes in <environment>" card under the list: who, key, version, time, level, reason; Load more; a key with a row opens its details; its own error with "Try again".
- **VWS-11** This delivery.
- **VWS-12..14 Tags** (asked for after delivery: "build it similar to how Infisical"). A `variables.tags text[]` column with a check (at most 8 tags of up to 24 characters, `a-z 0-9 -`; migration 0054, additive); `tags` on create, patch and every variable the API returns, and on the resolved set (the winner's tags, never a value); the page shows chips beside each name, a Tag filter, search by tag, a Tags row in the details and one form for description and tags; the demo's variables are tagged. A tag is a label, read with `variable.read` like a description; the `variable.update` audit row lists `tags` among its fields and holds no tag text. Tags are not in snapshots, restore, import or the bulk routes (a decision), the tag filter is in the browser, and the Compare environments matrix shows no chips. Mutation checks: VWS-12 9, VWS-13 9, VWS-14 15 (all killed). Web suite then 492 pass with the same one known failure; e2e 5 of 5; the Variables shot was read at 1280, light and dark.

## Results (this machine, 2026-10-20)
- Typecheck clean; Biome clean except one info in `apps/api/src/limits.test.ts` (existing).
- Root suite (`packages apps/api apps/cli`): 5301 pass, 5 skip, **2 fail**: CLI `auth` "answers once: a second request with the right state is too late" and db `stacks` "a stack that is still there keeps its id…" (strict `updatedAt >`). Neither is from this feature.
- Web suite: 479 pass, **1 fail**: `identities`/settings "giving one up asks first…" (about 19 s). Not from this feature.
- e2e (Playwright, Chromium): 5 of 5, including a real download of `acme-web-dev.env`, and the layout journey (both views, with details open, at 1280 and 390, both themes).
- `bun run demo:shots` passes; I looked at the Variables shots (light and dark, 1280): the card reads as a sentence, a time and a tag.
- **`bun run check` was not seen green end to end** (it runs the suites above, which carry the three known failures).
- Mutation checks per task: VWS-7 7, VWS-8 10, VWS-9 12, VWS-10 11 (all killed).

## Reviews
- **`/code-review`** over the whole uncommitted tree (it cannot be limited to this feature: nothing is committed). Feature 24 findings:
  - *Fixed:* after Reveal all, an edit, rotation or delete refreshed the data but left the old revealed secret on screen as if current. `refresh` now hides the values (test first, seen failing; `variables.revealall.test.tsx`).
  - *Not fixed, a decision for you:* the changes feed hides deleted variables, so a deleted key's earlier versions leave the feed while the delete dialog says "Its history is kept". A deletion itself is not a version row (it is the `variable.delete` audit event), so dropping the filter would show the earlier versions but still not the delete. Options: keep as is and say so in the dialog, or show them with a "deleted" marker (an API field, a test, an openapi regeneration).
- **`/security-review`** (by hand: this session has no sub-task tool, and the diff the skill injected was empty). VWS-7..10 code re-read: the reveal and download paths, `dotenvLine`, the changes route and card. No finding at 8/10 or above. Not covered: a browser extension or screenshot reading the page while values are shown; what a person does with a downloaded file.
- **The same code review found problems in other features' code**, none touched here. Triage, for you to decide:
  1. *Feature 21, fails open on a push to live DNS:* the apply's `DNS_CHANGE_SET` (`packages/iac/src/pipeline-gen.ts:260`) compares only `correction_details`. A zone whose report has `corrections > 0` and no details would compare equal to an empty plan, and the summary filter (line 232) drops it. DNSControl 5.5.0's reports always carry details (all fixtures do), so this is a different-version risk, not seen. Fix: fail the job when `corrections > 0` and the details are empty.
  2. *Feature 21:* `orch dns lint … || rm -f lint.json` skips the lint silently, and `dnsVerdict` allows when the summary has no `lint` block. A helper image older than the API would apply zones with lint errors. Fix: deny an apply of a zone whose lint is missing, as a missing `policyVerdict` is.
  3. *Feature 21:* drift runs (`stack-drift.ts:159`) pass no `uncosted` or `dnsPrune`, so a zone in a drift run reads as costed and not a zone; `routes/runs.ts:401` hard-codes `dnsPrune: false` for a run made by hand; `run-apply.ts:274` decides "has a cost limit" from the apply commit's tool, the run view from the stored `costed`.
  4. *Feature 21:* `ttl-range` warns on TTL 1 (Cloudflare's "automatic" for proxied records), so every proxied record warns.
  5. *Feature 23/22 code:* `theme.ts` with storage blocked leaves the toggle and the page disagreeing after an OS change; `organizations.tsx` copies the zone and stack name rules instead of importing `@orch/iac`'s; `runs.tsx` restates the run schema by hand and annotates over the typed client; a comment in `mr-note.ts` sits above the wrong helper.

## Open and not checked
- Folders (Q2) were not built: planned as feature 27. Tags were built (VWS-12..14); they are not in snapshots, restore, import or the bulk routes, the Compare matrix shows no chips, and a tagged row at 390 wide was not looked at by eye.
- The demo's Variables picture is the Secrets view; there is no demo shot of Compare, of a row's details, of Reveal all, or of the Changes card's Load more and error states.
- Seen by eye in a browser: the Secrets list, toolbar and Changes card at 1280 in the demo shots. Not seen: 390 wide (the layout journey shows no sideways scroll), the Reveal-all refusal line, a multi-line file value in the table, the Download status line, the Load more button.
- Download is proven in Chromium only (Firefox and Safari not run). A value holding a NUL is refused by the page (the API accepts it). Keys are not re-checked against the key pattern in the browser.
- The Reveal-all unmount test cannot see a value held outside the DOM and the query cache; the code keeps it in `useState` only.
- The environment filter of the feed includes project-level variables and leaves out the organization's (`variable.org.read` is a different permission). The feed is live variables only. Secrets is never shown without an environment, so the route's whole-project form is unused by the web.
- A GET route has no `noAudit` marker (the SPEC copied it from a POST route). The task text's "role below reporter gets 403" did not exist: reporter is the lowest project role; the guard gives 404 for no role and 403 for a token's scopes.
- `docs/openapi.json` regenerated; its diff against HEAD is large because it also holds the DNS and earlier routes that were never committed. Spec operation count 166 to 167, authz route count 170 to 171.
- Focus after a delete is not placed anywhere.
- Test-suite notes: the layout journey depends on the project the journey test makes (files run in order, one worker); in happy-dom a named role query inside `waitFor` can stall for seconds (use an unnamed one).
- The scratch Postgres on port 5433 (a native Postgres 18, because Docker is wedged on this machine) is still running; stop it before `bun run dev:db`.
