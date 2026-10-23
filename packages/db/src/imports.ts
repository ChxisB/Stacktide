import type { DetectedType } from "@orch/core";
import { and, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { ownedBy } from "./project-connection";
import type { Executor } from "./repo";
import { connections, projects } from "./schema";

/**
 * Brings a GitLab project in as a platform project, or refreshes it when it is already there (the
 * organization links each GitLab project once, so importing twice is the same import). A refresh
 * keeps the name, which may have been changed since, and sets the branch and types from GitLab; an
 * empty repository has no default branch to take. A name another project of the organization
 * already holds is a unique violation (`projects_org_name_key`) for the caller to report.
 *
 * With a connection the project is bound to it. A project from before connections was recorded
 * (unbound) is adopted when this is the organization's only GitLab connection; with two, it is not
 * known which one it came from, so this imports a project of its own.
 */
export async function importProject(
  db: Executor,
  input: {
    organizationId: string;
    connectionId?: string;
    gitlabProjectId: number;
    name: string;
    defaultBranch: string | null;
    types: DetectedType[];
  },
) {
  const branch = input.defaultBranch ?? undefined;
  const { connectionId } = input;
  if (connectionId) {
    // An unbound row owned by this connection is the only kind `ownedBy` yields besides its own.
    await db
      .update(projects)
      .set({ connectionId })
      .where(
        and(
          eq(projects.organizationId, input.organizationId),
          eq(projects.gitlabProjectId, input.gitlabProjectId),
          isNull(projects.connectionId),
          await ownedBy(db, connectionId),
        ),
      );
  }
  const [row] = await db
    .insert(projects)
    .values({
      organizationId: input.organizationId,
      connectionId,
      gitlabProjectId: input.gitlabProjectId,
      name: input.name,
      defaultBranch: branch,
      detectedTypes: input.types,
    })
    .onConflictDoUpdate({
      ...(connectionId
        ? {
            target: [projects.connectionId, projects.gitlabProjectId],
            targetWhere: sql`${projects.gitlabProjectId} IS NOT NULL AND ${projects.connectionId} IS NOT NULL`,
          }
        : {
            target: [projects.organizationId, projects.gitlabProjectId],
            targetWhere: sql`${projects.gitlabProjectId} IS NOT NULL AND ${projects.connectionId} IS NULL`,
          }),
      set: { detectedTypes: input.types, ...(branch ? { defaultBranch: branch } : {}) },
    })
    // xmax is 0 on a row this statement inserted, and the updating transaction's id otherwise.
    .returning({ ...getTableColumns(projects), created: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error("import returned no row");
  const { created, ...project } = row;
  return { project, created };
}

/**
 * The platform project each of these GitLab projects was imported (or linked) as, if any; of one connection when given
 * (see `ownedBy`). With none, GitLab's only: unbound, or bound to a GitLab connection, since a GitHub repository's
 * number is not a GitLab project's and the callers without a connection are GitLab's webhook events.
 */
export async function linkedProjects(
  db: Executor,
  organizationId: string,
  gitlabProjectIds: number[],
  connectionId?: string,
) {
  if (gitlabProjectIds.length === 0) return [];
  return db
    .select({ id: projects.id, gitlabProjectId: projects.gitlabProjectId })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        inArray(projects.gitlabProjectId, gitlabProjectIds),
        connectionId
          ? await ownedBy(db, connectionId)
          : sql`(${projects.connectionId} IS NULL OR EXISTS (SELECT 1 FROM ${connections} WHERE ${connections.id} = ${projects.connectionId} AND ${connections.type} = 'gitlab'))`,
      ),
    );
}
