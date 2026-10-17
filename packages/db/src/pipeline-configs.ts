import { and, asc, eq, gt, ne } from "drizzle-orm";
import type { Executor } from "./repo";
import { pipelineConfigs, projects } from "./schema";

export type PipelineConfig = typeof pipelineConfigs.$inferSelect;
export type NewPipelineConfig = Pick<
  typeof pipelineConfigs.$inferInsert,
  | "organizationId"
  | "projectId"
  | "connectionId"
  | "template"
  | "version"
  | "params"
  | "overrides"
  | "renderedHash"
  | "mode"
  | "includeProject"
  | "includeRef"
  | "mrIid"
  | "mrUrl"
>;

const projectIs = (organizationId: string, projectId: string) =>
  and(eq(pipelineConfigs.projectId, projectId), eq(pipelineConfigs.organizationId, organizationId));

/** What the project was last set up with, or undefined. */
export async function getPipelineConfig(db: Executor, organizationId: string, projectId: string) {
  return (await db.select().from(pipelineConfigs).where(projectIs(organizationId, projectId)))[0];
}

/** Replaces the project's pipeline configuration (one row per project). */
export async function savePipelineConfig(
  db: Executor,
  input: NewPipelineConfig,
): Promise<PipelineConfig> {
  const { organizationId, projectId, ...rest } = input;
  const row = (
    await db
      .insert(pipelineConfigs)
      .values(input)
      .onConflictDoUpdate({
        target: pipelineConfigs.projectId,
        set: rest,
        // a row of the project in another organization is not ours to replace
        setWhere: eq(pipelineConfigs.organizationId, organizationId),
      })
      .returning()
  )[0];
  if (!row) throw new Error("pipeline configuration was not saved");
  return row;
}

/**
 * The organization's projects set up from `template` at any version but `notVersion`, by project id
 * after `after` (a keyset cursor), with the project's name. The fleet upgrade (PIPE-7) walks these.
 */
export async function listPinnedPipelines(
  db: Executor,
  organizationId: string,
  input: { template: string; notVersion: string; after?: string; limit: number },
) {
  return db
    .select({ config: pipelineConfigs, projectName: projects.name })
    .from(pipelineConfigs)
    .innerJoin(
      projects,
      and(
        eq(projects.id, pipelineConfigs.projectId),
        eq(projects.organizationId, pipelineConfigs.organizationId),
      ),
    )
    .where(
      and(
        eq(pipelineConfigs.organizationId, organizationId),
        eq(pipelineConfigs.template, input.template),
        ne(pipelineConfigs.version, input.notVersion),
        input.after === undefined ? undefined : gt(pipelineConfigs.projectId, input.after),
      ),
    )
    .orderBy(asc(pipelineConfigs.projectId))
    .limit(input.limit);
}
