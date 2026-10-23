import { and, desc, eq, gte, inArray, lt, lte, ne } from "drizzle-orm";
import { notifyDeploymentFailed } from "./notifications";
import type { Executor } from "./repo";
import { deployments } from "./schema";

export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = Omit<typeof deployments.$inferInsert, "id" | "createdAt" | "updatedAt">;

/**
 * Stores what GitLab said about a deployment when the read that began at `observedAt` was made. A row
 * already holding a newer read is left as it is (`stored: false`): a late or repeated hook can never turn a
 * finished deployment back into a running one. Equal times replace.
 */
export async function recordDeployment(
  db: Executor,
  input: NewDeployment,
): Promise<{ deployment: Deployment; stored: boolean }> {
  const { organizationId, projectId, gitlabDeploymentId, ...rest } = input;
  const [row] = await db
    .insert(deployments)
    .values(input)
    .onConflictDoUpdate({
      target: [deployments.projectId, deployments.gitlabDeploymentId],
      set: rest,
      // a row of the project in another organization is not ours to replace
      setWhere: and(
        eq(deployments.organizationId, organizationId),
        lte(deployments.observedAt, input.observedAt),
      ),
    })
    .returning();
  if (row) return { deployment: row, stored: true };
  const [current] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.organizationId, organizationId),
        eq(deployments.projectId, projectId),
        eq(deployments.gitlabDeploymentId, gitlabDeploymentId),
      ),
    );
  if (!current) throw new Error("deployment was not saved");
  return { deployment: current, stored: false };
}

/**
 * `recordDeployment` for a read GitLab has just made (the hook, Refresh), which also tells the project's
 * `deployment.failed` subscribers when this read is what turned the deployment `failed`: not one that was
 * already failed, and not a read an earlier one has overtaken. Run it in a transaction, so a notification is
 * queued with the row that caused it and never without it.
 * shortcut: the row is locked only when it exists, so two first reads of one failed deployment at the same
 * instant, the later-started one finishing second, both tell; upgrade with an insert that reports whether it
 * created the row.
 */
export async function recordSeenDeployment(
  db: Executor,
  input: NewDeployment,
  pipelineUrl: string | null,
): Promise<{ deployment: Deployment; stored: boolean }> {
  const [before] = await db
    .select({ status: deployments.status })
    .from(deployments)
    .where(
      and(
        eq(deployments.organizationId, input.organizationId),
        eq(deployments.projectId, input.projectId),
        eq(deployments.gitlabDeploymentId, input.gitlabDeploymentId),
      ),
    )
    .for("update");
  const recorded = await recordDeployment(db, input);
  const { deployment } = recorded;
  if (recorded.stored && deployment.status === "failed" && before?.status !== "failed") {
    await notifyDeploymentFailed(db, {
      organizationId: deployment.organizationId,
      projectId: deployment.projectId,
      environment: deployment.environment,
      sha: deployment.sha,
      pipelineUrl,
      at: deployment.finishedAt ?? deployment.observedAt,
    });
  }
  return recorded;
}

/**
 * How a project's deployments ended since `since`: environment, status and the time (when it finished, else when
 * it was read), newest first, for the numbers (DEP-20). Only `success` and `failed`; `environment` keeps one.
 * shortcut: the newest `limit` of them, so a window holding more is under-counted; upgrade with SQL aggregation.
 */
export async function deploymentOutcomes(
  db: Executor,
  organizationId: string,
  projectId: string,
  o: { since: Date; environment?: string; limit: number },
): Promise<{ environment: string; status: string; at: Date }[]> {
  const rows = await db
    .select({
      environment: deployments.environment,
      status: deployments.status,
      finishedAt: deployments.finishedAt,
      observedAt: deployments.observedAt,
    })
    .from(deployments)
    .where(
      and(
        projectIs(organizationId, projectId),
        inArray(deployments.status, ["success", "failed"]),
        // read after it began: a finished deployment was read after it finished, so this only drops what is too old
        gte(deployments.observedAt, o.since),
        o.environment === undefined ? undefined : eq(deployments.environment, o.environment),
      ),
    )
    .orderBy(desc(deployments.gitlabDeploymentId))
    .limit(o.limit);
  return rows.map((r) => ({
    environment: r.environment,
    status: r.status,
    at: r.finishedAt ?? r.observedAt,
  }));
}

const projectIs = (organizationId: string, projectId: string) =>
  and(eq(deployments.projectId, projectId), eq(deployments.organizationId, organizationId));

/**
 * A project's deployments, newest first (GitLab's ids only grow), after the cursor `before`; `environment`
 * and `status` keep only that environment's or that status's.
 */
export async function listDeployments(
  db: Executor,
  organizationId: string,
  projectId: string,
  o: { environment?: string; status?: string; before?: number; limit: number },
) {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        projectIs(organizationId, projectId),
        o.environment === undefined ? undefined : eq(deployments.environment, o.environment),
        o.status === undefined ? undefined : eq(deployments.status, o.status),
        o.before === undefined ? undefined : lt(deployments.gitlabDeploymentId, o.before),
      ),
    )
    .orderBy(desc(deployments.gitlabDeploymentId))
    .limit(o.limit);
}

export type EnvironmentDeployments = {
  environment: string;
  /** the newest `success`: what runs there now; null when none ever succeeded */
  current: Deployment | null;
  /** the newest of any status: what was tried last */
  lastAttempt: Deployment;
};

/**
 * Each environment that has a deployment, by name: its newest success and its newest attempt of any status.
 * shortcut: reads all of the project's rows and picks in memory, which is right for hundreds of deployments;
 * move to `distinct on` per status when a project keeps tens of thousands.
 */
export async function currentDeployments(
  db: Executor,
  organizationId: string,
  projectId: string,
): Promise<EnvironmentDeployments[]> {
  const rows = await db
    .select()
    .from(deployments)
    .where(projectIs(organizationId, projectId))
    .orderBy(desc(deployments.gitlabDeploymentId));
  const byEnvironment = new Map<string, EnvironmentDeployments>();
  for (const d of rows) {
    const seen = byEnvironment.get(d.environment);
    if (!seen) {
      byEnvironment.set(d.environment, {
        environment: d.environment,
        current: d.status === "success" ? d : null,
        lastAttempt: d,
      });
    } else if (!seen.current && d.status === "success") seen.current = d;
  }
  return [...byEnvironment.values()].sort((a, b) => a.environment.localeCompare(b.environment));
}

/** Whether any deployment of the project, to any environment, finished `success` with this commit. */
export async function hasSucceeded(
  db: Executor,
  organizationId: string,
  projectId: string,
  sha: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        projectIs(organizationId, projectId),
        eq(deployments.sha, sha),
        eq(deployments.status, "success"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The newest deployment to `environment` that finished `success` with a commit other than `notSha`: what a
 * rollback goes back to. Failed attempts and redeploys of `notSha` are skipped.
 */
export async function previousSuccess(
  db: Executor,
  organizationId: string,
  projectId: string,
  environment: string,
  notSha: string,
): Promise<Deployment | undefined> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(
      and(
        projectIs(organizationId, projectId),
        eq(deployments.environment, environment),
        eq(deployments.status, "success"),
        ne(deployments.sha, notSha),
      ),
    )
    .orderBy(desc(deployments.gitlabDeploymentId))
    .limit(1);
  return row;
}
