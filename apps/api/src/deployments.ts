import { DomainError } from "@orch/core";
import { databaseTime, linkedProjects, type NewDeployment, recordSeenDeployment } from "@orch/db";
import { type Deployment, type Gitlab, GitlabError } from "@orch/gitlab";
import { z } from "zod";
import { WHY } from "./connections";
import { hopeless, type RunAt, type RunDeps } from "./pipeline-runs";
import type { JobHandler } from "./worker";

/** A deployment as GitLab answered, as a row to store; `observedAt` is when the asking began. */
export const deploymentRow = (at: RunAt, d: Deployment, observedAt: Date): NewDeployment => ({
  organizationId: at.organizationId,
  projectId: at.projectId,
  connectionId: at.connectionId,
  gitlabDeploymentId: d.id,
  environment: d.environment,
  sha: d.sha,
  ref: d.ref,
  status: d.status,
  jobId: d.jobId,
  pipelineId: d.pipelineId,
  finishedAt: d.finishedAt === null ? null : new Date(d.finishedAt),
  observedAt,
});

/** What GitLab says a deployment is now, as a row to store, and the address of its pipeline (told, not stored). */
export async function readDeployment(
  deps: RunDeps,
  at: RunAt,
  deploymentId: number,
  client?: Gitlab,
): Promise<{ row: NewDeployment; pipelineUrl: string | null }> {
  const observedAt = await (deps.now ?? (() => databaseTime(deps.db)))();
  const gitlab = client ?? (await deps.gitlab(at.organizationId, at.connectionId));
  const d = await gitlab.deployments.get(at.gitlabProjectId, deploymentId);
  return { row: deploymentRow(at, d, observedAt), pipelineUrl: d.pipelineUrl };
}

/** GitLab refusing or failing, as the API reports it; `refused` is what GitLab would not do. */
export const deploymentProblem = (e: unknown, refused: string) => {
  if (!(e instanceof GitlabError)) return e;
  if (e.kind === "not_found") {
    return new DomainError(
      "gitlab_not_found",
      422,
      "GitLab does not have the project, or what was asked of it.",
    );
  }
  if (e.kind === "forbidden" || e.kind === "invalid") {
    return new DomainError("gitlab_refused", 422, `GitLab would not ${refused}.`);
  }
  return new DomainError("gitlab_failed", 502, WHY[e.kind]);
};

export const deploymentEvent = z.looseObject({
  event: z.literal("deployment"),
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  projectId: z.number().int().positive(),
  deploymentId: z.number().int().positive(),
});

/**
 * The `gitlab.event` consumer for deployments (DEP-4). A deployment event only says that a deployment
 * changed, so the job reads it from GitLab and stores that: a repeated event reads the same thing, a late
 * one reads the present, and of two reads the one that began later wins. A read that turns a deployment
 * `failed` tells the project's `deployment.failed` subscribers (DEP-19). An event for a project that is not
 * linked is dropped, and so is one that no retry could serve (the deployment or the connection is gone,
 * GitLab refuses the token); any other failure fails the job so the queue retries it. Needs the master keys,
 * to open the connection's token.
 */
export const deploymentEventHandler =
  (deps: RunDeps): JobHandler =>
  async (ctx) => {
    const parsed = deploymentEvent.safeParse(ctx.payload);
    if (!parsed.success) return;
    const e = parsed.data;
    const [project] = await linkedProjects(deps.db, e.organizationId, [e.projectId]);
    if (!project) {
      ctx.log.debug("deployment event for a project that is not linked");
      return;
    }
    const at = {
      organizationId: e.organizationId,
      projectId: project.id,
      gitlabProjectId: e.projectId,
      connectionId: e.connectionId,
    };
    let seen: Awaited<ReturnType<typeof readDeployment>>;
    try {
      seen = await readDeployment(deps, at, e.deploymentId);
    } catch (error) {
      const why = hopeless(error, "the deployment");
      if (!why) throw error;
      ctx.log.warn("deployment event dropped", { reason: why, connection: e.connectionId });
      return;
    }
    const { stored } = await deps.db.transaction((tx) =>
      recordSeenDeployment(tx, seen.row, seen.pipelineUrl),
    );
    ctx.log.debug("deployment event handled", { status: seen.row.status, stored });
  };
