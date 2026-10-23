import { DomainError, FOLDER_PATTERN, isFolderPath, MAX_DEPTH } from "@orch/core";
import {
  createFolder,
  deleteFolder,
  type Folder,
  folderVariableCounts,
  getProject,
  listFolders,
  lockFolderById,
  renameFolder,
} from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import {
  deleteResponses,
  iso,
  mapDbError,
  notFound,
  pageOf,
  type RouteDeps,
  readErrors,
  stamps,
  taken,
  writeErrors,
} from "./shared";

const folderSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  /** `/db/primary`: the names from the root down. The root itself is no folder. */
  path: z.string(),
  ...stamps,
});
/** The list says what each folder holds, so a screen can show it without a call per folder. */
const listedSchema = folderSchema.extend({
  /** Live variables directly in the folder, at the project and in every environment. */
  variableCount: z.number().int(),
});
const dto = (f: Folder): z.infer<typeof folderSchema> => ({
  id: f.id,
  organizationId: f.organizationId,
  projectId: f.projectId,
  path: f.path,
  createdAt: iso(f.createdAt),
  updatedAt: iso(f.updatedAt),
});

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });
const itemParams = params.extend({ folderId: z.uuid() });
const folderName = z.string().regex(FOLDER_PATTERN, "lower-case letters, digits, - and _, 1 to 32");
const create = z.strictObject({
  parent: z.string().refine(isFolderPath, "/ or the path of a folder").optional(),
  name: folderName,
});
// A rename stays in the same parent (ADR-0021): moving a folder is not built.
const patch = z.strictObject({ name: folderName });

const badName = () => new DomainError("validation_failed", 422, "Not a folder name");
const audited = (action: string, f: Folder, metadata: Record<string, unknown>) => ({
  action,
  resourceType: "variable_folder",
  resourceId: f.id,
  organizationId: f.organizationId,
  projectId: f.projectId,
  metadata: { path: f.path, ...metadata },
});

export const folderRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/folders" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId, projectId } }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        // shortcut: the list is not paged (a project's tree is small), so `nextCursor` is always
        // null; page it with the db's listFolders when a project holds thousands.
        const [folders, counts] = await Promise.all([
          listFolders(db, projectId),
          folderVariableCounts(db, projectId),
        ]);
        return {
          items: folders.map((f) => ({ ...dto(f), variableCount: counts.get(f.id) ?? 0 })),
          nextCursor: null,
        };
      },
      {
        params,
        response: { 200: pageOf(listedSchema), ...readErrors },
        guard: "variable.read",
      },
    )
    .post(
      "",
      async ({ params: { orgId, projectId }, body, audit, set }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        const folder = await db
          .transaction(async (tx) => {
            const made = await createFolder(tx, {
              organizationId: orgId,
              projectId,
              parent: body.parent ?? "/",
              name: body.name,
            });
            if ("error" in made)
              throw made.error === "no_parent" ? notFound("Parent folder") : badName();
            await audit(tx, audited("variable_folder.create", made.row, {}));
            return made.row;
          })
          .catch(
            mapDbError({
              variable_folders_project_path: taken("folder_taken", "The folder name"),
              variable_folders_path_check: new DomainError(
                "folder_too_deep",
                422,
                `A folder can be at most ${MAX_DEPTH} levels deep`,
              ),
            }),
          );
        set.status = 201;
        return dto(folder);
      },
      {
        params,
        body: create,
        parse: "json",
        response: { 201: folderSchema, ...writeErrors },
        audit: "variable_folder.create",
        guard: "variable.create",
      },
    )
    .patch(
      "/:folderId",
      async ({ params: { orgId, projectId, folderId }, body, audit }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        return db
          .transaction(async (tx) => {
            const was = await lockFolderById(tx, projectId, folderId);
            if (!was) throw notFound("Folder");
            const renamed = await renameFolder(tx, { projectId, path: was.path, name: body.name });
            if ("error" in renamed)
              throw renamed.error === "not_found" ? notFound("Folder") : badName();
            await audit(
              tx,
              audited("variable_folder.rename", renamed.row, { previousPath: was.path }),
            );
            return dto(renamed.row);
          })
          .catch(
            mapDbError({ variable_folders_project_path: taken("folder_taken", "The folder name") }),
          );
      },
      {
        params: itemParams,
        body: patch,
        parse: "json",
        response: { 200: folderSchema, ...writeErrors },
        audit: "variable_folder.rename",
        guard: "variable.update",
      },
    )
    .delete(
      "/:folderId",
      async ({ params: { orgId, projectId, folderId }, audit, set }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        await db.transaction(async (tx) => {
          const folder = await lockFolderById(tx, projectId, folderId);
          if (!folder) throw notFound("Folder");
          const deleted = await deleteFolder(tx, { projectId, path: folder.path });
          if ("error" in deleted) {
            throw deleted.error === "not_found"
              ? notFound("Folder")
              : new DomainError(
                  "folder_not_empty",
                  409,
                  "A folder with variables or folders in it cannot be deleted: empty it first",
                );
          }
          await audit(tx, audited("variable_folder.delete", deleted.row, {}));
        });
        set.status = 204;
      },
      {
        params: itemParams,
        response: deleteResponses,
        audit: "variable_folder.delete",
        guard: "variable.delete",
      },
    );
