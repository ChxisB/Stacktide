import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { projects } from "./projects";

/**
 * A folder of a project's variables (ADR-0021): one tree per project, shared by every environment.
 * The root is no row; a folder is its `path` (`/db`, `/db/primary`), at most five names deep.
 * Deleting sets `deleted_at` (the path is then free again, the history stays); a folder is deleted
 * only when it holds nothing live. The check repeats `FOLDER_PATTERN` and `MAX_DEPTH` of
 * `@orch/core` for a writer other than `folders.ts`: change them together.
 */
export const variableFolders = pgTable(
  "variable_folders",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    path: text().notNull(),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // The target of `variables`' composite key: a variable stays in a folder of its own project.
    unique("variable_folders_id_project_key").on(t.id, t.projectId),
    // Live rows only: a deleted folder does not hold its path.
    uniqueIndex("variable_folders_project_path")
      .on(t.projectId, t.path)
      .where(sql`${t.deletedAt} IS NULL`),
    // For the cascade from a project (the partial index above only holds live rows).
    index("variable_folders_project_idx").on(t.projectId),
    // CASCADE: a folder is configuration and goes with its project. The pair also makes the project
    // one of the organization's.
    foreignKey({
      name: "variable_folders_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check("variable_folders_path_check", sql`${t.path} ~ '^(/[a-z0-9_-]{1,32}){1,5}$'`),
  ],
);
