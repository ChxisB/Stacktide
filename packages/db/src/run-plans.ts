import { and, eq } from "drizzle-orm";
import type { Executor } from "./repo";
import { runPlans } from "./schema";

export type PlanAction = "plan" | "apply";

/**
 * Keeps the plan of a run for an action, replacing an earlier one (an apply may be asked for again). The caller has
 * checked that the run is the project's: the key names the run's own organization and project, so a plan cannot be
 * kept under another's (a foreign key on a new plan, a check on a replaced one). `plan` is data the platform built (`runPlan` of `@orch/iac`); it is stored as it is given.
 */
export async function storeRunPlan(
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
  action: PlanAction,
  plan: object,
): Promise<void> {
  // an update skips the foreign key, so it names the run's scope itself: a plan is never replaced through another project
  const [row] = await db
    .insert(runPlans)
    .values({ runId, organizationId, projectId, action, plan })
    .onConflictDoUpdate({
      target: [runPlans.runId, runPlans.action],
      set: { plan },
      setWhere: and(eq(runPlans.organizationId, organizationId), eq(runPlans.projectId, projectId)),
    })
    .returning({ runId: runPlans.runId });
  if (!row) throw new Error("the run is not the project's");
}

/** The plan of a run for an action, or `undefined` when none was kept (or the run is not the project's). */
export async function getRunPlan(
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
  action: PlanAction,
): Promise<unknown> {
  const [row] = await db
    .select({ plan: runPlans.plan })
    .from(runPlans)
    .where(
      and(
        eq(runPlans.organizationId, organizationId),
        eq(runPlans.projectId, projectId),
        eq(runPlans.runId, runId),
        eq(runPlans.action, action),
      ),
    );
  return row?.plan;
}
