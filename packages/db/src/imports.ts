import type { DetectedType } from "@orch/core";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { projects } from "./schema";

/**
 * Brings a GitLab project in as a platform project, or refreshes it when it is already there (the
 * organization links each GitLab project once, so importing twice is the same import). A refresh
 * keeps the name, which may have been changed since, and sets the branch and types from GitLab; an
 * empty repository has no default branch to take. A name another project of the organization
 * already holds is a unique violation (`projects_org_name_key`) for the caller to report.
 */
export async function importProject(
  db: Executor,
  input: {
    organizationId: string;
    gitlabProjectId: number;
    name: string;
    defaultBranch: string | null;
    types: DetectedType[];
  },
) {
  const branch = input.defaultBranch ?? undefined;
  const [row] = await db
    .insert(projects)
    .values({
      organizationId: input.organizationId,
      gitlabProjectId: input.gitlabProjectId,
      name: input.name,
      defaultBranch: branch,
      detectedTypes: input.types,
    })
    .onConflictDoUpdate({
      target: [projects.organizationId, projects.gitlabProjectId],
      targetWhere: sql`${projects.gitlabProjectId} IS NOT NULL`,
      set: { detectedTypes: input.types, ...(branch ? { defaultBranch: branch } : {}) },
    })
    // xmax is 0 on a row this statement inserted, and the updating transaction's id otherwise.
    .returning({ ...getTableColumns(projects), created: sql<boolean>`(xmax = 0)` });
  if (!row) throw new Error("import returned no row");
  const { created, ...project } = row;
  return { project, created };
}

/** The platform project each of these GitLab projects was imported (or linked) as, if any. */
export function linkedProjects(db: Executor, organizationId: string, gitlabProjectIds: number[]) {
  if (gitlabProjectIds.length === 0) return Promise.resolve([]);
  return db
    .select({ id: projects.id, gitlabProjectId: projects.gitlabProjectId })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        inArray(projects.gitlabProjectId, gitlabProjectIds),
      ),
    );
}
