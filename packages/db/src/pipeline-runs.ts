import { and, desc, eq, lt, lte, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { pipelineRuns } from "./schema";

export type PipelineRun = typeof pipelineRuns.$inferSelect;
export type NewPipelineRun = Omit<
  typeof pipelineRuns.$inferInsert,
  "id" | "createdAt" | "updatedAt"
>;

/**
 * Stores what GitLab said about a pipeline when the read that began at `observedAt` was made. A
 * row already holding a newer read is left as it is (`stored: false`): a late or repeated event
 * can never turn a finished pipeline back into a running one. Equal times replace.
 */
export async function recordPipelineRun(
  db: Executor,
  input: NewPipelineRun,
): Promise<{ run: PipelineRun; stored: boolean }> {
  const { organizationId, projectId, gitlabPipelineId, ...rest } = input;
  const [row] = await db
    .insert(pipelineRuns)
    .values(input)
    .onConflictDoUpdate({
      target: [pipelineRuns.projectId, pipelineRuns.gitlabPipelineId],
      set: rest,
      // a row of the project in another organization is not ours to replace
      setWhere: and(
        eq(pipelineRuns.organizationId, organizationId),
        lte(pipelineRuns.observedAt, input.observedAt),
      ),
    })
    .returning();
  if (row) return { run: row, stored: true };
  const [current] = await db
    .select()
    .from(pipelineRuns)
    .where(
      and(
        eq(pipelineRuns.organizationId, organizationId),
        eq(pipelineRuns.projectId, projectId),
        eq(pipelineRuns.gitlabPipelineId, gitlabPipelineId),
      ),
    );
  if (!current) throw new Error("pipeline run was not saved");
  return { run: current, stored: false };
}

const projectIs = (organizationId: string, projectId: string) =>
  and(eq(pipelineRuns.projectId, projectId), eq(pipelineRuns.organizationId, organizationId));

export async function getPipelineRun(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
) {
  return (
    await db
      .select()
      .from(pipelineRuns)
      .where(and(projectIs(organizationId, projectId), eq(pipelineRuns.id, id)))
  )[0];
}

/** A project's runs, newest first (GitLab's pipeline ids only grow), after the cursor `before`. */
export async function listPipelineRuns(
  db: Executor,
  organizationId: string,
  projectId: string,
  o: { ref?: string; status?: string; before?: number; limit: number },
) {
  return db
    .select()
    .from(pipelineRuns)
    .where(
      and(
        projectIs(organizationId, projectId),
        o.ref === undefined ? undefined : eq(pipelineRuns.ref, o.ref),
        o.status === undefined ? undefined : eq(pipelineRuns.status, o.status),
        o.before === undefined ? undefined : lt(pipelineRuns.gitlabPipelineId, o.before),
      ),
    )
    .orderBy(desc(pipelineRuns.gitlabPipelineId))
    .limit(o.limit);
}

/** The newest run of each ref of the project, newest first. */
export async function latestPipelineRuns(
  db: Executor,
  organizationId: string,
  projectId: string,
  limit: number,
) {
  const newest = db
    .selectDistinctOn([pipelineRuns.ref])
    .from(pipelineRuns)
    .where(projectIs(organizationId, projectId))
    .orderBy(pipelineRuns.ref, desc(pipelineRuns.gitlabPipelineId))
    .as("newest");
  return db.select().from(newest).orderBy(desc(newest.gitlabPipelineId)).limit(limit);
}

/**
 * The database's clock, read now. Every reader of a pipeline takes its `observedAt` from here, so
 * that two workers whose own clocks differ still agree which read began later.
 */
export async function databaseTime(db: Executor): Promise<Date> {
  const [row] = await db.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  if (!row) throw new Error("clock_timestamp() returned no row");
  return new Date(row.now);
}
