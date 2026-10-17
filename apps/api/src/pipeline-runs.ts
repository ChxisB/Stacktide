import type { Logger } from "@orch/core";
import { DomainError } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  type Db,
  databaseTime,
  linkedProjects,
  type NewPipelineRun,
  recordPipelineRun,
} from "@orch/db";
import { type Gitlab, GitlabError, type Pipeline } from "@orch/gitlab";
import { z } from "zod";
import { WHY } from "./connections";
import { gitlabFor } from "./routes/pipeline";
import type { JobHandler } from "./worker";

/** GitLab's words for a failure are stored clipped: job names are free text. */
const MAX_TEXT = 200;
const clip = (s: string) => s.slice(0, MAX_TEXT);

export interface RunDeps {
  db: Db;
  /** A client for one of the organization's connections (the token is opened there and goes no further). */
  gitlab: (organizationId: string, connectionId: string) => Promise<Gitlab>;
  /** Test seam: when a read began. Left out, the database's clock decides. */
  now?: () => Date | Promise<Date>;
}

/** How the worker opens a connection's GitLab client; without keys it cannot, and the job fails. */
export const workerGitlab =
  (deps: { db: Db; keys?: KeyProvider; logger: Logger }): RunDeps["gitlab"] =>
  (organizationId, connectionId) =>
    gitlabFor(deps, organizationId, connectionId, undefined);

export interface RunAt {
  organizationId: string;
  projectId: string;
  /** GitLab's id of the project. */
  gitlabProjectId: number;
  connectionId: string;
}

/** The first job that failed and was not allowed to: what a person wants to know first. */
async function firstFailure(gitlab: Gitlab, project: number, pipelineId: number) {
  for await (const job of gitlab.pipelines.jobs(project, pipelineId)) {
    if (job.status === "failed" && !job.allowFailure) {
      return {
        failedJob: clip(job.name),
        failureReason: job.failureReason === null ? null : clip(job.failureReason),
      };
    }
  }
  return { failedJob: null, failureReason: null };
}

const row = (
  at: RunAt,
  p: Pipeline,
  observedAt: Date,
  failure: Awaited<ReturnType<typeof firstFailure>>,
) =>
  ({
    organizationId: at.organizationId,
    projectId: at.projectId,
    connectionId: at.connectionId,
    gitlabPipelineId: p.id,
    iid: p.iid,
    status: p.status,
    ref: p.ref,
    sha: p.sha,
    webUrl: p.webUrl,
    ...failure,
    observedAt,
  }) satisfies NewPipelineRun;

const noFailure = { failedJob: null, failureReason: null };

/**
 * Asks GitLab what a pipeline is now. The answer, not the event that prompted the question, is
 * what is stored, and `observedAt` is taken before asking: of two reads the one that began later
 * wins, however the events or the jobs handling them were ordered.
 */
export async function readPipeline(deps: RunDeps, at: RunAt, pipelineId: number, client?: Gitlab) {
  const observedAt = await (deps.now ?? (() => databaseTime(deps.db)))();
  const gitlab = client ?? (await deps.gitlab(at.organizationId, at.connectionId));
  const p = await gitlab.pipelines.get(at.gitlabProjectId, pipelineId);
  const failure =
    p.status === "failed" ? await firstFailure(gitlab, at.gitlabProjectId, p.id) : noFailure;
  return row(at, p, observedAt, failure);
}

/** GitLab refusing or failing, as the API reports it. */
export const retryProblem = (e: unknown) => {
  if (!(e instanceof GitlabError)) return e;
  if (e.kind === "not_found") {
    return new DomainError("gitlab_pipeline_gone", 422, "GitLab no longer has this pipeline.");
  }
  if (e.kind === "forbidden" || e.kind === "invalid") {
    return new DomainError("gitlab_refused", 422, "GitLab would not retry this pipeline.");
  }
  return new DomainError("gitlab_failed", 502, WHY[e.kind]);
};

/**
 * Asks GitLab to run the failed jobs of a pipeline again, then reads the pipeline as the other
 * events do (the read begins after the retry, so no earlier read can replace it), and returns what
 * it is now (not yet recorded). If the read fails the retry has still happened.
 */
export async function retryPipeline(deps: RunDeps, at: RunAt, pipelineId: number) {
  const gitlab = await deps.gitlab(at.organizationId, at.connectionId);
  await gitlab.pipelines.retry(at.gitlabProjectId, pipelineId).catch((e) => {
    throw retryProblem(e);
  });
  return readPipeline(deps, at, pipelineId, gitlab).catch((e) => {
    throw retryProblem(e);
  });
}

/** Why an event cannot be handled now or later, when it cannot: the job is dropped, not retried. */
const hopeless = (e: unknown) => {
  if (e instanceof GitlabError) {
    if (e.kind === "not_found") return "GitLab no longer has the pipeline";
    if (e.kind === "unauthorized" || e.kind === "forbidden") return "GitLab refuses the token";
  }
  // the connection was deleted or is not a GitLab one: nothing a retry could change
  if (e instanceof DomainError && (e.status === 404 || e.status === 422)) {
    return "the connection is gone";
  }
  return undefined;
};

const pipelineEvent = z.looseObject({
  event: z.literal("pipeline"),
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  projectId: z.number().int().positive(),
  pipelineId: z.number().int().positive(),
});

/**
 * The `gitlab.event` consumer (PIPE-8). A pipeline event only says that a pipeline changed, so
 * the job reads the pipeline from GitLab and stores that: a repeated event reads the same thing, a
 * late one reads the present, and a retried pipeline simply reads as running again. Job events and
 * the other kinds are not used (a pipeline event follows every change of a pipeline's status). An
 * event for a project that is not linked is dropped, and so is one that no retry could serve (the
 * pipeline or the connection is gone, GitLab refuses the token); any other failure fails the job so
 * the queue retries it. Needs the master keys, to open the connection's token.
 */
export const pipelineEventHandler =
  (deps: RunDeps): JobHandler =>
  async (ctx) => {
    const parsed = pipelineEvent.safeParse(ctx.payload);
    if (!parsed.success) return;
    const e = parsed.data;
    const [project] = await linkedProjects(deps.db, e.organizationId, [e.projectId]);
    if (!project) {
      ctx.log.debug("pipeline event for a project that is not linked");
      return;
    }
    const at = {
      organizationId: e.organizationId,
      projectId: project.id,
      gitlabProjectId: e.projectId,
      connectionId: e.connectionId,
    };
    let seen: Awaited<ReturnType<typeof readPipeline>>;
    try {
      seen = await readPipeline(deps, at, e.pipelineId);
    } catch (error) {
      const why = hopeless(error);
      if (!why) throw error;
      ctx.log.warn("pipeline event dropped", { reason: why, connection: e.connectionId });
      return;
    }
    const { stored } = await recordPipelineRun(deps.db, seen);
    ctx.log.debug("pipeline event handled", { status: seen.status, stored });
  };
