import { and, eq } from "drizzle-orm";
import type { Executor } from "./repo";
import { pipelineConfigs } from "./schema";

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
