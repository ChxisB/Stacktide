# 27 Variable folders - Spec
Prefix: FLD · Milestone: M5 · Status: building from 2026-10-21 on the blanket go (ADR-0021 Proposed, not accepted) · Needs: 04, 05, 24 · Came from: feature 24's Q2, asked for as "build it similar to how Infisical"

## Goal
Let a project group its variables in **folders** inside an environment's list, the way Infisical's secrets screen does (MICROSERVICE #1, #2, #3 in the screenshot): open a folder from the list, see a breadcrumb, add secrets and sub-folders there, and point a sync target, `orch run` or a `${REF}` at one folder. Tags (feature 24, built) cover finding things; folders cover **the same key meaning different things in different places** (`DATABASE_URL` for each microservice) without prefixing every name.

## Why it is a feature and not a task
A folder changes what a variable's identity is. Today it is the key, within one of three levels (organization, project, environment); the most specific level wins a key. Everything that addresses a variable by key has to learn a second part. Found by reading (2026-10-20; **not exhaustive**, FLD-1 makes it so):

| Place | Reads or writes a variable by key | What changes |
|---|---|---|
| `packages/core/src/variables.ts` `resolveVariables` | the one resolver; groups candidates by `key`, `${KEY}` refs | identity becomes an address (`/db/URL`); refs get a path form |
| `packages/db/src/schema/variables.ts` | unique indexes on `(org, key)`, `(project, key)`, `(environment, key)` for live rows | each gains the folder; a migration |
| `packages/db/src/variables.ts` | create, set, list, `openChain`, `snapshotLevel`, `restorePlan`/`restoreLevel`, `importPlan`/`importLevel`, `bulkPlan`/`bulkLevel`, `searchVariables` | take and return a folder |
| `packages/core/src/variables.ts` `planRestore`, `planImport`, `planBulk` | match by key | match by address |
| `apps/api/src/routes/variables.ts` | `levelRoutes` (built once for each of the three levels: list, create, by id, patch, delete, versions, snapshot, restore, import, bulk, reveal), plus the resolved set and its `values`, export, changes and search routes | a `folder` field and query parameter |
| `apps/api/src/sync-plan.ts` | `resolveVariables` per scope, then one item per key | a target says which folder it syncs (a field of its `config` jsonb, so no column) |
| `packages/sync` | targets are flat key spaces (a CI variable is `KEY`; SSM, Secrets Manager, Kubernetes and Vault keep a key or a path) | decided in the ADR; none changes in the first cut |
| `apps/cli/src/vars.ts` | `export`, `run`, `pull`, `push` read the resolved set; `push` imports | a `--folder` flag |
| `apps/web` (Secrets, Compare environments, details, add, import, history, rotation, changes) | rows keyed by `key` | a folder in state, a breadcrumb, folder rows |
| Rotation, leases, secret gates, change requests, scanning, policy (not read in this plan) | by variable id, or maybe by key | **FLD-1 checks each** |

## How Infisical does it, and what this takes
| Infisical | Here | Note |
|---|---|---|
| Folder rows above the secrets, a breadcrumb, "Add Folder" | the same in the Secrets view | FLD-11..13 |
| A folder tree per environment | **one tree per project, shared by every environment** (recommended, question 1) | the Compare matrix stays meaningful: the same folder across environments |
| `${KEY}` same folder, `${folder.KEY}`, `${env.folder.KEY}` | `${KEY}` same folder, `${/a/b/KEY}` absolute path; no cross-environment form | question 2 |
| An integration syncs one "secret path" (optionally recursive) | a target syncs **one folder**, default `/`, not recursive | question 3 |
| Folder-level permissions | the project's roles and guards apply; no per-folder role | question 5 |
| Secret imports between folders | not built | non-goal |
| Move a secret to another folder | "Move" in the details (same id, no new version) | FLD-8 |

## Scope
- **The model.** A project owns a tree of folders (`/db`, `/db/replica`). Project-level and environment-level variables sit in a folder or at the root; **organization-level variables stay at the root** (question 4). A variable's **address** is its folder and key: `/KEY` at the root, `/db/URL` in `/db`. The most specific level still wins an address.
- **Resolution.** `resolveVariables` takes a `folder` on each input (root by default) and resolves addresses. `${KEY}` reads the same folder as the variable that holds it (so every existing root variable works unchanged); `${/db/URL}` reads that address; a reference to a missing folder or key is the existing `missing` issue, naming the address. Taint, cycles, duplicates and size limits work across folders. `file` variables are still taken as written.
- **Folder rules.** A folder name is 1 to 32 characters of `a-z 0-9 - _`, at most 5 deep. A parent must exist. Rename moves the folder and what is in it (one `UPDATE` on the path; variables hold the folder's id, so no variable row changes). **Delete is only for an empty folder** (no live variable, no sub-folder), a soft delete like a variable's, so history keeps its place (invariant 5: no silent cascade).
- **API.** `folder` on every variable the API returns (`"/"` at the root); on create, import and bulk; `?folder=` on the list, the resolved set, `values` and export (default `/`, not recursive); a move (a patch of `folder` alone makes no version, like tags); folder routes: list, create (`parent` + `name`), rename, delete. Guards reuse `variable.read`, `variable.create`, `variable.update`, `variable.delete`; audit `variable_folder.create|rename|delete`.
- **Sync.** A target gets an optional `folder` (default `/`): it syncs the resolved variables of that folder only. Existing targets are root targets and do not change. Folders map to hierarchical paths on AWS SSM and Vault later (non-goal now).
- **CLI.** `--folder <path>` on `export`, `run`, `pull`, `push`; `orch folders list|create|rm`.
- **Web.** The Secrets view holds a folder path with the environment: a breadcrumb (`Project / dev / db`), folder rows above the variables (name, count, Open), "Add folder", Rename and Delete on a folder row, Add variable, Import, Reveal all and Download .env act on the open folder, the details gain "Move to folder". Compare environments shows the open folder. Search covers the open folder.
- **Demo.** The demo project gets two folders so the shot shows them.

## Non-goals
Per-folder roles; recursive sync, export or `run` (keys would collide in a flat target; a prefix or path mapping is a follow-up); secret imports between folders; folders at the organization level; cross-environment references; moving a whole folder under another parent (rename is within the same parent in the first cut); folders in snapshots of the past (see Risks); tags on folders; building anything before you approve.

## Proposed decision (ADR written in FLD-1; adds a D-row to the ROADMAP once accepted)
The next free ADR number was 0019, but feature 25's FRG-2 also names 0019 and D14 for itself. **Checked at FLD-1 (2026-10-21):** feature 31 took 0020 and D14 first and left 0019 held for FRG-2, so this is **ADR-0021 and D15**; FRG-2 keeps 0019 and takes the next free decision number after D15.
1. A folder is a project-level namespace shared by all environments; it is a row (`variable_folders`: id, organization, project, `path`, soft delete), and a variable points at it by id, so a rename touches one row and its descendants' paths.
2. A variable's identity is `(level owner, folder, key)`. The unique indexes gain the folder and read a null folder as one value (`coalesce(folder_id, nil uuid)`: drizzle has no `NULLS NOT DISTINCT` on a partial index) so the root still holds one live row per key.
3. References are relative to the holder's folder; the path form is absolute. There is no fallback to the root, because a quiet fallback makes `${URL}` mean different things when a folder gains a key.
4. A sync target, `orch run` and an export read exactly one folder.
5. Rejected: a path prefix in the key (`db/URL`), which breaks `KEY_PATTERN`, every target and `.env` (a key is an environment variable name); a tree per environment, which makes the matrix compare nothing; recursive reads with flattened names, which hide collisions.

## Acceptance
- With no folder created, **every existing test passes unchanged** (the root is the old world), and `docs/openapi.json` differs only by additions.
- In one environment, `/payments/DATABASE_URL` and `/search/DATABASE_URL` coexist; the root's `DATABASE_URL` is a third; each resolves alone; `${/payments/DATABASE_URL}` in a root variable reads the first; `${DATABASE_URL}` in `/search` reads the second.
- A sync target set to `/payments` plans only that folder's variables; a root target plans only the root's.
- `orch run --folder /payments -- env` shows that folder's variables; with no flag, the root's.
- A folder with a variable or a sub-folder cannot be deleted (409, nothing changes); an empty one can, and its variables' history stays readable.
- No secret value appears in a folder route's answer, an audit row, or an error (leak tests).
- Web: open a folder from the list, see the breadcrumb, add a secret there, go up, see it is not in the parent; the layout journey passes at 1280 and 390 in both themes; a shot is read.

## Risks / human gates
- **ADR and a new decision row** (FLD-1): changes what identity means. Human gate.
- **Migration FLD-4** drops and re-creates three unique indexes on `variables` and adds a column. No data is rewritten and no row is lost, but the indexes are the guarantee that a key is unique, so it is the riskiest step and gets a constraint test per level. Reviewed as a data-altering migration.
- **Snapshots, restore, bulk and history of the past.** Snapshots are computed from version rows at a time (`rowsAt`), not stored. A variable moved after `at` would restore to its folder **now**. FLD-7 decides and tests this; the safe default is that restore matches by address and a moved variable reads as a delete plus a create, and the plan says so.
- **Secret gates, change requests, leases, rotation, scanning** may address a variable by key. Not read for this plan. FLD-1 lists them; any that does gets a task here or a stated limit, not a silent gap.
- **A reference that used to resolve** can stop resolving only if a variable moves out of the folder its readers sit in. Move says so before it acts (a preview of references that would break, as import and restore previews do).
- **Size.** About 16 tasks; the web part is the largest. It ships in two cuts if you prefer: FLD-1 to FLD-10 (model, API, sync, CLI; folders usable through the API and CLI) and FLD-11 onward (the page).

## Open questions (answer at approval)
1. One folder tree per project shared by all environments (recommended), or one per environment as Infisical does?
2. `${KEY}` reads the same folder only, with `${/path/KEY}` for anything else (recommended), or `${KEY}` falls back to the root?
3. A sync target, `run` and export read exactly one folder, not recursive (recommended), or also a recursive mode with a refusal on a name collision?
4. Organization-level variables stay at the root (recommended), or organizations get folders too?
5. Folders inherit the project's roles (recommended), or per-folder roles (an authorization-model change, a human gate and a few more tasks)?

## FLD-1 audit of callers (2026-10-21)
Every place that reads or writes a variable by key, found by searching the code (`variables` tables, `resolveVariables`, `openChain`, the bulk and pending-edit types) and reading each hit. "By id" means a variable is found by its id and a folder changes nothing. Leases (GitLab tokens with read scopes), secret gates and scanning (open findings from a pipeline's report) and policy (reports on plans) do not touch variables at all.

| Place | Addresses a variable by | What it needs | Handled by |
|---|---|---|---|
| `packages/core/src/variables.ts`: `resolveVariables`, `planRestore`, `planImport`, `planBulk`, `BulkOp`, `bulkKeys` | key | an address (folder and key); `${KEY}` relative, `${/a/KEY}` absolute; `BulkOp` gains an optional `folder` | FLD-2 |
| `packages/db/src/schema/variables.ts`: three unique indexes | key | the folder in each, the root as one value | FLD-4 |
| `packages/db/src/variables.ts`: `createVariable`, `listVariables`, `chainKeys`, `openChain`, `searchVariables` | key | take and return the folder; a folder filter | FLD-4 |
| same file: `setVariable`, `deleteVariable`, `describeVariable`, `getVariable`, `listVersions`, `revealVariable` | id | nothing (the ciphertext is bound to id and version, not key or folder); `getVariable` returns the folder | FLD-4 |
| same file: `listVariableChanges` (the changes feed) | key beside id | the folder on each row | FLD-6 |
| same file: `snapshotLevel`, `restorePlan`, `restoreLevel`, `importPlan`, `importLevel`, `bulkPlan`, `bulkLevel` | key | match by address; restore of a moved variable is a delete plus a create | FLD-7 |
| **Change requests** (`sealPending` and `openPending`, `createChangeRequest`, `diffOf`, approve and apply through `bulkLevel`, `routes/change-requests.ts`) | key, inside a sealed `BulkOp[]` | each edit carries an optional `folder`; a request sealed before folders has none and means the root; the stored diff names the folder. **Not in the first plan: added to FLD-7.** | FLD-2, FLD-7 |
| `apps/api/src/routes/variables.ts`: `levelRoutes` (three levels), the resolved set, `values`, export, changes, search, import, bulk, restore | key | `folder` on bodies and answers, `?folder=` on reads; `writable` (a protected environment refuses direct writes) already runs first in each write, so folder writes need nothing more | FLD-6, FLD-7, FLD-8 |
| `apps/api/src/variable-import.ts` (a GitLab project's variables as import entries) | key, flat | the import route's `folder` says where they land | FLD-7 |
| `apps/api/src/sync-plan.ts` (`assemble`, `digestOf`), `sync-apply.ts`, `routes/sync-runs.ts`, drift | the resolved set, one item per key | read the target's folder only; `target.config` is already in the digest, so a change of folder changes it | FLD-9 |
| `packages/db/src/auto-sync.ts` | owner (level) | none: a change in any folder queues the level's auto-sync targets; a target of another folder plans nothing to do. Limit stated in the ADR | none |
| `packages/db/src/rotations.ts`, `packages/rotation` | id (the key is read for the name) | behaviour unchanged (it follows the id, also after a move); answers that show a key beside an id gain the folder. The `rotation.failing` notification names the key only: **limit, kept** | FLD-6 (answers) |
| `packages/db/src/rewrap.ts` (re-wrapping data keys) | owner | none | none |
| `packages/gitlab/src/variables.ts`, `packages/sync` | GitLab's flat CI variables and the other targets' key spaces | none: a target holds one folder's resolved set (ADR point 4) | none |
| Audit rows of variable writes | key | name `folder` too | FLD-6 |
| `apps/cli/src/vars.ts` (`export`, `run`, `pull`, `push`, `import`) and `orch folders` | the resolved set, by key | `--folder`; a `folders` command | FLD-10 |
| `apps/web` (Secrets, Compare environments, details, add, import, history, rotation, changes, search) | rows keyed by `key` | folder in state, breadcrumb, folder rows, move | FLD-11..14 |
| `docs/openapi.json`, `packages/api-client` | generated | regenerated with each route task | FLD-5..8 |

No row above is left "not read". Two changes to the task list follow: change requests join FLD-2 and FLD-7 (above), and the migrations are numbered 0058 and 0059 (0055 to 0057 are feature 31's).

