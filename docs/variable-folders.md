# Variable folders (FLD-1 to FLD-16)

A project can group its variables in **folders**, so the same key can mean different things in different places
(`DATABASE_URL` for `payments` and for `search`) without prefixing every name. Tags find things; folders give a key a place.

The decision behind it is [ADR-0021](adr/0021-variable-folders.md) (D15). **It is Proposed, not accepted**: this was built on
the recommended answers to its five open questions, so a reversal costs rework.

With no folder made, nothing changes. Every variable sits in the **root**, `/`, which is where every variable was before
folders existed.

## The model

- A folder belongs to a **project**. There is one tree per project, **shared by every environment**, so the Compare matrix
  still compares the same folder across environments.
- A folder's **path** is `/payments` or `/payments/eu`. A name is 1 to 32 characters of `a-z 0-9 - _`, and a path goes at
  most **5 deep**. The parent must exist.
- A project-level or environment-level variable sits in a folder or at the root. **Organization-level variables stay at the
  root**: a folder on one is refused (404), and `folder: "/"` on one is fine.
- A variable's identity is **its level's owner, its folder and its key**. `/payments/DATABASE_URL`, `/search/DATABASE_URL` and
  the root's `/DATABASE_URL` are three variables, and each can be set in the project and again in an environment. The most
  specific level still wins an address, as before.
- Roles are the project's. There is no per-folder role: `variable.read`, `variable.create`, `variable.update` and
  `variable.delete` apply to a folder as to a variable, and a protected environment still changes only through a change request.

## The address and the reference forms

A variable's **address** is its folder and key: `/KEY` at the root, `/payments/DATABASE_URL` in `/payments`.

| In a value | Reads |
|---|---|
| `${KEY}` | the variable of that key **in the same folder as the variable that holds it** |
| `${/payments/URL}` | that address, from any folder |
| `$${KEY}` | the text `${KEY}`, not a reference |

- Every existing root variable works unchanged: its `${KEY}` reads the root.
- **There is no fallback to the root.** `${URL}` in `/search` reads `/search/URL` or nothing; if it fell back, adding a `URL` to
  `/search` one day would change what an older value meant.
- A reference to a folder or key that is not there is the `missing` issue, and it names the address (`/payments/URL`; a
  variable at the root is named by its key, as before). Cycles, taint and size limits work across folders.
- `${/…}` written in a value that meant it as literal text is now a reference. Write `$${/…}` to keep the text.
- There is no reference across environments.

## What reads a folder

**One folder, never its subfolders, and the root by default.** An environment variable and a CI variable are flat, so two
`DATABASE_URL`s cannot share one target; a recursive read would have to rename or refuse, and neither is built.

| | Reads | How to choose a folder |
|---|---|---|
| A sync target | the resolved variables of one folder | `config.folder` of the target (a path of the project; `/` is not stored) |
| `orch run`, `pull`, `export`, `push` | one folder | `--folder <path>` (`docs/ci.md`) |
| The values route, Reveal all, Download .env | one folder | `?folder=` / the folder open on the page |
| The list of variables | one folder | `?folder=` |
| Search | every folder | `folder` in the body narrows it; each hit says where it is |

A target's folder is checked when the target is made or changed (422 `unknown_folder`). A plan, an apply and a drift check
**fail closed** if the folder is gone: 409 `target_folder_missing`, before any secret is opened. A target reads its folder's
own variables, but the references of every folder are resolved first, because a `${/a/B}` may need another folder's value.

## What a move can break

Moving a variable to another folder is `PATCH …/variables/:id` with `{ "folder": "/payments" }` (and nothing else; `/` is the
root). It keeps the **same id and the same history** and makes **no new version**, so nothing is re-encrypted.

- The same key already in that folder, at that level, is a 409 `key_taken` and nothing moves.
- A move can stop other variables resolving, because a reader was looking at the old address. The API resolves the chains
  before and after. If some address has an issue after and none before, the move is a **409 `move_breaks_readers`** with
  `breaks` (the addresses, names only) and **is undone**. `{ "folder": …, "force": true }` goes ahead anyway, and the audit row
  says `forced: true`. The page lists the addresses and the button becomes **Move anyway**.
- In a **protected environment** a variable of the environment cannot be moved directly: 409 `change_request_required`. Change
  requests carry no move.
- A move changes the digest a sync plan was made from, so a plan made before it is `plan_stale`.

A folder **rename** stays within the same parent (`PATCH …/folders/:folderId` with `{ "name": … }`): the folder, what is in it
and its subfolders go with it, and no variable row changes. A rename writes no variable version and no row in the changes feed,
so an older row there shows the folder's new path.

A folder is **deleted only when it is empty** (no variable, no subfolder): a soft delete, so history keeps its place. Anything
else is 409 `folder_not_empty` and nothing changes.

**A rename or a delete does not follow a sync target.** The target keeps the old path and its next plan fails closed with 409
`target_folder_missing`. Point it at the new path.

## The API

| | |
|---|---|
| `GET /organizations/:orgId/projects/:projectId/folders` | the folders, each with `variableCount` (variables directly in it, at the project level and in every environment); unpaged |
| `POST` the same path | `{ parent?, name }`; 201 |
| `PATCH …/folders/:folderId` | `{ name }` |
| `DELETE …/folders/:folderId` | 204 |

Variable routes take `folder` on create (and on import and bulk edits, per entry) and `?folder=` on the list, the resolved
set and `values`; every variable an answer carries has `folder` (`/` at the root). A missing or deleted folder is a **404
`Folder`**, a malformed path is a 422. Audit actions: `variable_folder.create`, `variable_folder.rename`,
`variable_folder.delete`; a variable's audit rows name `folder` when it is not the root.

- **Restore and import match by address.** A snapshot carries the folder a variable has *now* (version rows do not record it),
  so a variable moved since the chosen time restores as a delete in its old place and a create in its new, and the plan says
  so. A restore into a folder that is gone is `applied: false`.
- **Change requests** carry a folder on each edit (the root when absent), so one sealed before folders means the root. A `set`
  in a folder that has gone by the time it is approved is a 409.
- The resolved set resolves every folder of the project and returns the one asked for.

## The page

On **Variables**, the path reads project, environment, then each folder down; every part above the last goes back to it.
Folder rows (name, how many variables, Open, Rename, Delete) sit above the variables, **Add folder** is in the strip, and Add
variable, Import, Reveal all and Download .env act on the open folder. The details have **Move**. Choosing another environment
keeps the open folder. **Compare environments** shows the open folder across the environments, with the same path. Search is
over the open folder's rows. A folder deleted or renamed elsewhere while it is open sends the page up to the nearest folder
that is still there. History, rotation and the changes card name the folder of a variable that is not at the root.

## The CLI

`orch run|pull|export|push --folder <path>` and `orch folders list|create|rm [<path>]`: see [ci.md](ci.md#options).

## Limits

- Per project: a tree at most 5 deep; names `^[a-z0-9_-]{1,32}$`. The folder list and the folder route are **not paged**, and the
  resolved set and `values` open every folder of the project to answer for one (a project with thousands of variables is the
  point to narrow them).
- Not built: per-folder roles; recursive sync, export or `run`; secret imports between folders; folders at the organization
  level; cross-environment references; moving a folder under another parent; tags on folders; `orch folders rename`.
- The sync target form on the page has no folder field: set `config.folder` through the API.
- A folder **rename** is not judged the way a move is: `${/old/KEY}` written in a value stops resolving, and nothing checks first
  or offers `force`. Look for the old path before renaming; judging a rename like a move is the follow-up.
- A sync target follows neither a rename nor a delete of its folder (above). A new folder made later at the old path would be
  read by that target.
- A pipeline's required-variable check (`pipeline-validate`) looks for variables at the root only.
- An auto-sync target is queued by a change in **any** folder; a target of another folder plans nothing to do.
- The `rotation.failing` notification names the key only, not the folder.
- The Download .env file name does not carry the folder.
