# ADR-0021: A variable's identity is its folder and key
Status: **Proposed** (the recommended answers to the SPEC's five open questions, taken on your blanket go of 2026-10-21 to finish every open task. Building proceeds on them, so a reversal costs rework; **accept, amend or reverse it here**. Not accepted by anyone yet) · Roadmap: FLD-1, adds D15 · Builds on: ADR-0007 (variable keys), ADR-0020 (D14) · 0019 stays held for multi-forge (feature 25, FRG-2), which now takes the next free decision number after D15

## Context
A project's variables are a flat list per level (organization, project, environment); the most specific level wins a key. Infisical's secrets screen groups them in folders, and the person who asked for feature 24 asked for that. Tags (feature 24) find things; they do not let `DATABASE_URL` mean one thing for `payments` and another for `search` in the same environment without prefixing every name. A folder changes what a variable *is*: today its identity is its key within a level, and every place that addresses a variable by key (the resolver, three unique indexes, import, restore, bulk edits, change requests, sync targets, `orch run`, the page) has to learn a second part. That is why this is a decision and not a task.

## Decision
1. **A folder is a project-level namespace shared by every environment.** It is a row (`variable_folders`: id, organization, project, `path`, soft delete). A variable points at it by id (`variables.folder_id`, null for the root), so renaming a folder touches the folder row and its descendants' paths and no variable row.
2. **A variable's identity is `(level owner, folder, key)`.** The three unique indexes gain the folder and treat the root, a null, as one value, so the root still holds one live row per key. Organization-level variables stay at the root (a check refuses a folder on one).
3. **A reference is relative to the holder's folder; the path form is absolute.** `${KEY}` reads the folder of the variable that holds it, so every existing root variable works unchanged. `${/db/URL}` reads that address. There is **no fallback to the root**: a quiet fallback would make `${URL}` mean something else the day a folder gains a key. A reference to a missing folder or key is the existing `missing` issue, naming the address.
4. **A sync target, `orch run` and an export read exactly one folder,** default the root, never recursive. A flat target (a CI variable is `KEY`) cannot hold two `DATABASE_URL`s, so a recursive read would have to rename or refuse; neither is built.
5. **Folders inherit the project's roles.** No per-folder role: the guards `variable.read`, `variable.create`, `variable.update` and `variable.delete` apply to a folder as to a variable. A protected environment's variables still change only through a change request.
6. **A folder is deleted only when empty** (no live variable, no live sub-folder), as a soft delete, so history keeps its place. Rename stays within the same parent in the first cut.
7. **Moving a variable keeps its id and makes no version.** The ciphertext is bound to the variable's id and version, not to its key or folder, so a move re-encrypts nothing. A move that would stop a reference resolving needs `force`.
8. **Restore matches by address.** Version rows do not record the folder, so a snapshot carries the folder a variable has *now*; a variable moved since the chosen time restores as a delete in its old place and a create in its new, and the plan says so.

## Why this, and what was left out
- **A path prefix in the key** (`db/URL`) was rejected: a key is an environment variable name, and a slash breaks the key pattern, every target and `.env`.
- **One tree per environment** (as Infisical does) was rejected: the Compare matrix would compare nothing, because the same folder would not exist across environments.
- **Recursive reads with flattened names** were rejected: they hide collisions.
- **Per-folder roles** change the authorization model (a human gate of its own) and were not asked for.
- **Secret imports between folders**, folders at the organization level, cross-environment references and tags on folders are not built.

## Consequences
- The migration (FLD-4) drops and re-creates three unique indexes on `variables`. No row is rewritten or lost, but those indexes are the guarantee that a key is unique, so each level gets a constraint test, and the migration is applied to rows made before it in a test.
- A change request's sealed edits (`BulkOp[]`) name keys; each edit gains an optional `folder` (the root when absent), so a request sealed before folders opens and means the root.
- An auto-sync target is queued when any variable of its level changes, whichever folder; the plan reads the target's folder only, so the cost of a change elsewhere is a plan with nothing to do.
- A rotation's failing notification and the changes feed name a key; they gain the folder where they show a key beside an id, and a notification's text that names only the key is a stated limit.
- Rotation, leases, secret gates, scanning and policy do not address a variable by key (the SPEC's table says how each was checked), so they need no change.
