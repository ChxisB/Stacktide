import { FOLDER_PATTERN, ROOT } from "@orch/core";
import { and, count, eq, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { variableFolders, variables } from "./schema";

export type Folder = typeof variableFolders.$inferSelect;

/** A variable named a folder that is not there: not made, deleted, another project's, or the organization's (which has none). */
export class FolderNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`folder ${path} not found`);
    this.name = "FolderNotFoundError";
  }
}

const live = (projectId: string) =>
  and(eq(variableFolders.projectId, projectId), isNull(variableFolders.deletedAt));

/** The folder at `path` and everything under it. `starts_with`, not LIKE: `_` is a wildcard there. */
const subtree = (projectId: string, path: string): SQL | undefined =>
  and(
    live(projectId),
    or(eq(variableFolders.path, path), sql`starts_with(${variableFolders.path}, ${`${path}/`})`),
  );

/**
 * Makes the folder `name` under `parent` (the root `/` or the path of a live folder). The database
 * refuses a path that is held already (`variable_folders_project_path`), one that is deeper than
 * five names (`variable_folders_path_check`) and a project of another organization
 * (`variable_folders_project_org_fk`); the route turns each into its answer. A `name` that is not a
 * folder name is refused here, since `a/b` would pass the path check as two levels.
 */
export async function createFolder(
  db: Executor,
  input: { organizationId: string; projectId: string; parent: string; name: string },
): Promise<{ row: Folder } | { error: "no_parent" | "bad_name" }> {
  if (!FOLDER_PATTERN.test(input.name)) return { error: "bad_name" };
  return db.transaction(async (tx) => {
    if (input.parent !== ROOT) {
      // The lock keeps the parent from being renamed or deleted between this read and the insert.
      const [parent] = await tx
        .select({ id: variableFolders.id })
        .from(variableFolders)
        .where(and(live(input.projectId), eq(variableFolders.path, input.parent)))
        .for("share");
      if (!parent) return { error: "no_parent" };
    }
    const path = `${input.parent === ROOT ? "" : input.parent}/${input.name}`;
    const [row] = await tx
      .insert(variableFolders)
      .values({ organizationId: input.organizationId, projectId: input.projectId, path })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return { row };
  });
}

/**
 * The live folders of a project, a folder before what is under it.
 * shortcut: unpaged, a project's tree is small by use and nothing caps it, so page it (keyset on
 * path) when a project holds thousands.
 */
export function listFolders(db: Executor, projectId: string): Promise<Folder[]> {
  return db.select().from(variableFolders).where(live(projectId)).orderBy(variableFolders.path);
}

/**
 * How many live variables sit directly in each folder of the project, across the project and all
 * its environments: the same thing that keeps `deleteFolder` from deleting it. A folder with none
 * is not in the map.
 */
export async function folderVariableCounts(
  db: Executor,
  projectId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ folderId: variables.folderId, n: count() })
    .from(variables)
    .where(
      and(
        eq(variables.projectId, projectId),
        isNull(variables.deletedAt),
        isNotNull(variables.folderId),
      ),
    )
    .groupBy(variables.folderId);
  return new Map(rows.flatMap((r) => (r.folderId ? [[r.folderId, r.n] as const] : [])));
}

/** The live folder at `path` of the project, unlocked: for a read that only asks whether it is there. */
export async function getFolderByPath(
  db: Executor,
  projectId: string,
  path: string,
): Promise<Folder | undefined> {
  const [row] = await db
    .select()
    .from(variableFolders)
    .where(and(live(projectId), eq(variableFolders.path, path)));
  return row;
}

/**
 * The live folder `id` of the project, locked against a rename or delete until the transaction
 * ends (the routes name a folder by id, and the functions here by path). Undefined when it is not
 * there: deleted, another project's, or never made.
 */
export async function lockFolderById(
  db: Executor,
  projectId: string,
  id: string,
): Promise<Folder | undefined> {
  const [row] = await db
    .select()
    .from(variableFolders)
    .where(and(live(projectId), eq(variableFolders.id, id)))
    .for("update");
  return row;
}

/**
 * Gives the folder at `path` a new `name`, in the same parent, and every folder under it the new
 * path, in one transaction. A live sibling that holds the name stops it
 * (`variable_folders_project_path`).
 */
export async function renameFolder(
  db: Executor,
  input: { projectId: string; path: string; name: string },
): Promise<{ row: Folder } | { error: "not_found" | "bad_name" }> {
  if (!FOLDER_PATTERN.test(input.name)) return { error: "bad_name" };
  return db.transaction(async (tx) => {
    // The whole subtree is locked first: a folder made under it meanwhile waits here, and then
    // finds its parent gone, instead of being missed by the update below and left on the old path.
    const held = await tx
      .select({ path: variableFolders.path })
      .from(variableFolders)
      .where(subtree(input.projectId, input.path))
      .orderBy(variableFolders.path)
      .for("update");
    if (!held.some((f) => f.path === input.path)) return { error: "not_found" };
    const to = `${input.path.slice(0, input.path.lastIndexOf("/"))}/${input.name}`;
    await tx
      .update(variableFolders)
      .set({ path: sql`${to} || substr(${variableFolders.path}, ${input.path.length + 1})` })
      .where(subtree(input.projectId, input.path));
    const [row] = await tx
      .select()
      .from(variableFolders)
      .where(and(live(input.projectId), eq(variableFolders.path, to)));
    if (!row) throw new Error("renamed folder vanished");
    return { row };
  });
}

/**
 * Deletes the folder at `path`, as a soft delete so its place in the history stays, only when it
 * holds nothing live: no sub-folder and no variable (`not_empty` otherwise).
 */
export async function deleteFolder(
  db: Executor,
  input: { projectId: string; path: string },
): Promise<{ row: Folder } | { error: "not_found" | "not_empty" }> {
  return db.transaction(async (tx) => {
    // The lock makes a folder being made inside this one wait, and then find it deleted.
    const [folder] = await tx
      .select()
      .from(variableFolders)
      .where(and(live(input.projectId), eq(variableFolders.path, input.path)))
      .for("update");
    if (!folder) return { error: "not_found" };
    const [inside] = await tx
      .select({ id: variableFolders.id })
      .from(variableFolders)
      .where(
        and(live(input.projectId), sql`starts_with(${variableFolders.path}, ${`${input.path}/`})`),
      )
      .limit(1);
    if (inside) return { error: "not_empty" };
    // A variable being made here holds a share lock on this row, so it has landed or waits for this.
    const [held] = await tx
      .select({ id: variables.id })
      .from(variables)
      .where(and(eq(variables.folderId, folder.id), isNull(variables.deletedAt)))
      .limit(1);
    if (held) return { error: "not_empty" };
    const [row] = await tx
      .update(variableFolders)
      .set({ deletedAt: new Date() })
      .where(eq(variableFolders.id, folder.id))
      .returning();
    if (!row) throw new Error("update returned no row");
    return { row };
  });
}
