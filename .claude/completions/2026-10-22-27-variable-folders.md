# 27 variable folders - built 2026-10-21 and 2026-10-22 (ADR-0021 and D15 still Proposed; nothing run against a real GitLab)

A project's variables can now live in **folders**. A variable's identity is its level's owner, its folder and its key, so `DATABASE_URL` can be one thing for `payments` and another for `search`. With no folder made, nothing changes: every variable sits in the root, `/`. A sync target, `orch run` or an export reads exactly one folder, never its subfolders. A move to another folder keeps the id and the history, and says what it would break first.

Everything was built on the recommended answers to the SPEC's five open questions, under your blanket go to finish every open task. Nothing is committed.

## What was built
- **A, the decision and the model (FLD-1..3).** ADR-0021 and decision D15 (**Proposed**, not accepted); `@orch/core/folders` (`ROOT`, `MAX_DEPTH`, `FOLDER_PATTERN`, `address`, `splitAddress`) and a resolver that reads `${KEY}` in the holder's folder, `${/a/b/KEY}` as an address and `$${` as text; the `variable_folders` table (migration 0058) with the tree rules in `packages/db/src/folders.ts` (prefix matching with `starts_with`, so `_` is not a wildcard).
- **B, a variable lives in a folder (FLD-4..8).** Migration 0059 re-creates the three unique indexes on `(owner, folder, key)`; the four folder routes (`GET|POST .../folders`, `PATCH|DELETE .../folders/:folderId`, audit `variable_folder.create|rename|delete`); `folder` on every variable answer and on create and `?folder=` on the list, the resolved set and `values`; import, snapshot, restore, bulk and change requests by address; Move as `PATCH {folder, force?}` (409 `move_breaks_readers` with `breaks`, rolled back unless `force`; 409 `change_request_required` in a protected environment).
- **C, sync and CLI (FLD-9, 10).** A target reads `config.folder` (422 `unknown_folder` at create; 409 `target_folder_missing`, failing closed, at plan, apply and drift); `orch run|pull|export|push --folder` and `orch folders list|create|rm`.
- **D, the page (FLD-11..15).** Breadcrumbs, folder rows with Open, Rename and Delete, Add folder, the open folder acted on by Add variable, Import, Reveal all and Download .env; Move in the details with the list of what would break and **Move anyway**; Compare, search, history, rotation and the changes card in a folder; the demo seed with `/payments` and `/search`, and the happy-path and layout journeys opening a folder at 1280 and 390 in both themes.
- **E, delivery (FLD-16).** `docs/variable-folders.md`, a README line, `docs/openapi.json` current.
- **New routes:** 4 (the route-count pins moved to 182 routes and 178 operations). One API addition beyond the task text: `variableCount` on each folder, for the folder rows.
- **Migrations:** 0058 (additive), 0059 (indexes only, but it changes what makes a row unique; see the follow-ups).
- **No new dependency, no new CSS class.**

## Existing tests that changed (each a finding in LOG.md; none skipped or deleted)
- **FLD-4:** one db test's allow-list of columns (`packages/db/src/variables.test.ts`) gained `folder`.
- **FLD-6:** two tests gained a `folder` because a search with no `folder` means every folder (a deviation from the SPEC).
- **FLD-7:** the bulk and import pins that said a folder is refused (422) now say it is accepted; the snapshot's exact key list gained `folder`.
- **FLD-8:** the pin that a `PATCH {folder}` is a 422 was removed on purpose; the task makes it a move.
- **FLD-11:** the pin on a folder's exact keys gained `variableCount`; `authz.test.ts` and `spec.test.ts` moved for the four routes.
- **FLD-13:** one web pin gained "Move COLOR in dev" in the details' actions.
- **FLD-16:** none. The new Move anyway test and the underscore db test are additions.

## Gate, stated plainly
After the last code change (the Move anyway fix):
- Biome format: no fixes; `bunx biome check .`: clean except the one existing info in `apps/api/src/limits.test.ts:170`; `bun run typecheck`: clean.
- **`bun run check` as one command: exit 0.** Root tests **5785 pass, 5 skip, 0 fail** (237 files). Web **904 pass, 0 fail** (54 files).
- **`bun run e2e`: 9 passed on each of three runs in a row. The first of four runs had 1 failure:** `layout.e2e.ts` "both variables views fit at desktop and phone width, light", the column menu "Options for dev" not opening within 5 s. That run took 37 s (the others 26 s), just after Docker had been restarted with other containers starting. It did not repeat, its trace was overwritten, and **I do not know the cause.**
- **One web test failed once:** `variables.test.tsx` "a plain value may be empty and shows as empty, a masked one may not be" (`expected "(empty)", got "devNot setSet"`). It reads the matrix cell as soon as the row header appears, so it can run ahead of the matrix's second query. It passed 5 of 5 alone and in two full runs. It is an existing test and was not changed; a `waitFor` around the cell would fix it.
- **Docker went down in the middle of the first web run of this task** (its socket vanished): 53 web tests failed with "Postgres is not reachable". I started Docker Desktop and `bun run dev:db` again (the `orch_pgdata` volume kept its data) and reran. That run is counted nowhere above. Starting Docker also started the other containers set to restart on this machine.
- `demo:shots`, `demo:align` and `demo:keys` were last run at FLD-15 (2 passed; 4 passed with 0 findings; passed). FLD-16 changed no page code that they read except `MoveVariable`, which none of them opens, so they were not rerun.
- Mutation checks: every task that added logic has its list in its LOG entry (FLD-14 had 21, all killed; the FLD-16 Move anyway fix 3, all killed; the underscore test 1).

## Reviews
- **Code review:** the working tree mixes features 14 to 31, so `/code-review` was read against the files this feature owns, not a diff of 27 alone. It found one bug, fixed test-first (Move anyway hid its own failure), and the follow-ups 4 and 5 below.
- **Security review (by hand):** no gap beyond the stated limits. Reads: the folder list and variable reads are `variable.read` (a Reporter sees paths and counts, writes nothing); folder writes are `variable.create|update|delete` and audited by path; a move needs `variable.update` and is refused in a protected environment. `breaks` and `rotation.failing` name addresses and keys, never values. `/security-review` the skill was not run.

## Not checked
- **Nothing was run against a real GitLab.** The sync adapters write the same variables, flat, as before; a folder only chooses which ones.
- **Any project with thousands of variables or folders:** the folder list is unpaged, and the resolved set and `values` open every folder of the project to answer for one.
- **Migration 0059 on a database that already holds data.** It ran on the per-test databases, which start empty; I did not run it against a populated one.
- A rename or a delete of a folder that a sync target points at, beyond the 409 it gives (follow-up 5).
- A folder opened in a saved demo shot (only the e2e journeys open one); the Download .env file's name when a folder is open.
- Safari and Firefox. Screen readers (the keyboard walk, `demo:keys`, passes; no assistive technology was run).

## Left out, on purpose
Per-folder roles; recursive sync, export or `run`; secret imports between folders; folders on organization variables; cross-environment references; moving a folder under another parent; tags on folders; `orch folders rename`; a folder field on the web sync-target form; a folder in `.orch.json` or `ORCH_*`.

## Follow-ups for your decision
1. **ADR-0021 and D15 are Proposed.** Accept, amend or reverse them in `docs/adr/0021-variable-folders.md`. The five SPEC questions were answered at the recommended options; a reversal costs rework.
2. **Migration 0059** changes the unique indexes (a data-altering step, done on the blanket go). It uses no `NULLS NOT DISTINCT`, so the root is a stored value, not a null.
3. **`${/…}` written as literal text in an old value is now a reference.** Write `$${/…}` to keep the text.
4. **A rename is not judged like a move.** `${/old/KEY}` stops resolving with no check and no `force`. Proposal: resolve before and after, and refuse with the addresses, as a move does.
5. **Sync targets follow neither a rename nor a delete.** The target fails closed (409 `target_folder_missing`), and a new folder at the old path would be read by it.
6. **Auto-sync** is queued by a change in any folder; a target of another folder plans nothing to do.
7. **Search with no `folder` means every folder** (the SPEC said the root); the web search is the client-side filter and does not search folder names.
8. **A restore of a variable moved since** is a delete in the old place and a create in the new (version rows do not record the folder); a restore into a gone folder is `applied: false`; a change-request `set` into a gone folder is a 409 at approval; the change-request page has no diff view of a folder.
9. **A move** is judged after it is done and rolled back if it breaks readers without `force`; `issuesAround` opens every value of the chains twice, in memory, with no reveal audit row.
10. **The pipeline's required-variable check** looks at the root only; `rotation.failing` names the key, not the folder; the Download .env file name has no folder.
11. **The page:** Add folder is a button in the Variables strip and not on the matrix; Rename, Delete and Move are not role-gated (the API refuses and the form says why); a change of another folder in the changes card is plain text.
12. **Keyboard walk:** the Variables page with folders has six more tab stops before the first variable row (`demo:keys` row actions 47 to 53 became 51 to 58). A "skip to variables" link is the fix, and belongs to feature 30's open question.
13. **Three nits from the review, skipped:** the redundant `lockFolderById` then re-select by path; the two non-transactional queries behind a folder row's count; `nameOf` duplicating `splitAddress(...).key`.
14. **The two flaky tests above** (`variables.test.tsx`'s empty plain value; the layout journey's column menu): say if you want the first fixed with a `waitFor` and the second chased down.
