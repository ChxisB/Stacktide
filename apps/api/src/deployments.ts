import { DomainError } from "@orch/core";
import { databaseTime, linkedProjects, type NewDeployment, recordSeenDeployment } from "@orch/db";
import { type Deployment, type Gitlab, GitlabError } from "@orch/gitlab";
import { z } from "zod";
import { WHY } from "./connections";
import { type EventDeps, hopeless, type RunAt, type RunDeps } from "./pipeline-runs";
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

/** What the forge says a deployment is now, as a row to store, and the address of its pipeline (told, not stored). */
export async function readDeployment(
  deps: Pick<RunDeps, "db" | "now">,
  at: RunAt,
  deploymentId: number,
  client: Pick<Gitlab, "deployments">,
): Promise<{ row: NewDeployment; pipelineUrl: string | null }> {
  const observedAt = await (deps.now ?? (() => databaseTime(deps.db)))();
  const d = await client.deployments.get(at.gitlabProjectId, deploymentId);
  return { row: deploymentRow(at, d, observedAt), pipelineUrl: d.pipelineUrl };
}

/**
 * The forge refusing or failing, as the API reports it; `refused` is what it would not do. The error codes keep
 * their `gitlab_` names (clients match them); the sentences name the forge (CLD-10). Only the 502 text is still
 * GitLab's words (shortcut: `WHY`; reword it when a GitHub connection test is worded the same way).
 */
export const deploymentProblem = (e: unknown, refused: string, forge = "GitLab") => {
  if (!(e instanceof GitlabError)) return e;
  if (e.kind === "not_found") {
    return new DomainError(
      "gitlab_not_found",
      422,
      `${forge} does not have the project, or what was asked of it.`,
    );
  }
  if (e.kind === "forbidden" || e.kind === "invalid") {
    return new DomainError("gitlab_refused", 422, `${forge} would not ${refused}.`);
  }
  return new DomainError(
    "gitlab_failed",
    502,
    forge === "GitLab"
      ? WHY[e.kind]
      : `${forge} could not be reached, or did not answer well. Try again.`,
  );
};

export const deploymentEvent = z.looseObject({
  event: z.literal("deployment"),
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  projectId: z.number().int().positive(),
  deploymentId: z.number().int().positive(),
});

/** GitHub's `deployment_status` event as the receiver queued it (CLD-10): `projectId` is the repository's id. */
export const githubDeploymentEvent = z.looseObject({
  event: z.literal("deployment_status"),
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  projectId: z.number().int().positive(),
  deploymentId: z.number().int().positive(),
});

/**
 * The `gitlab.event` consumer for deployments (DEP-4, and GitHub's `deployment_status`, CLD-10). A deployment event only says that a deployment
 * changed, so the job reads it from GitLab and stores that: a repeated event reads the same thing, a late
 * one reads the present, and of two reads the one that began later wins. A read that turns a deployment
 * `failed` tells the project's `deployment.failed` subscribers (DEP-19). An event for a project that is not
 * linked is dropped, and so is one that no retry could serve (the deployment or the connection is gone,
 * GitLab refuses the token); any other failure fails the job so the queue retries it. Needs the master keys,
 * to open the connection's token.
 */
export const deploymentEventHandler =
  (deps: EventDeps): JobHandler =>
  async (ctx) => {
    const github = githubDeploymentEvent.safeParse(ctx.payload);
    const parsed = github.success ? github : deploymentEvent.safeParse(ctx.payload);
    if (!parsed.success) return;
    const e = parsed.data;
    const forge = github.success ? "GitHub" : "GitLab";
    const open = github.success ? deps.forge : deps.gitlab;
    if (!open) {
      ctx.log.warn("deployment event dropped", { reason: "no way to open the connection" });
      return;
    }
    // a GitHub event is about the repository of that connection; a GitLab one is about a GitLab project of the organization
    const [project] = await linkedProjects(
      deps.db,
      e.organizationId,
      [e.projectId],
      github.success ? e.connectionId : undefined,
    );
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
      seen = await readDeployment(
        deps,
        at,
        e.deploymentId,
        await open(at.organizationId, at.connectionId),
      );
    } catch (error) {
      const why = hopeless(error, "the deployment", forge);
      if (!why) throw error;
      ctx.log.warn("deployment event dropped", { reason: why, connection: e.connectionId });
      return;
    }
    const { stored } = await deps.db.transaction((tx) =>
      recordSeenDeployment(tx, seen.row, seen.pipelineUrl),
    );
    ctx.log.debug("deployment event handled", { status: seen.row.status, stored });
  };
