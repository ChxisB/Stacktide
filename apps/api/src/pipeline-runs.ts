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
import type { Forge } from "@orch/forge";
import { type Gitlab, GitlabError, isFinished, type Pipeline } from "@orch/gitlab";
import { z } from "zod";
import { WHY } from "./connections";
import { forgeOf, gitlabFor } from "./routes/pipeline";
import { ingestSecretFindings } from "./secret-scan";
import type { JobHandler } from "./worker";

/** GitLab's words for a failure are stored clipped: job names are free text. */
const MAX_TEXT = 200;
export const clip = (s: string) => s.slice(0, MAX_TEXT);

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

/** A forge's client for one of the organization's connections, whichever forge it is. */
export type ForgeFor = (organizationId: string, connectionId: string) => Promise<Forge>;

/** How the worker opens a connection of any forge (GitLab or GitHub); without keys it cannot, and the job fails. */
export const workerForge =
  (deps: { db: Db; keys?: KeyProvider; logger: Logger }): ForgeFor =>
  (organizationId, connectionId) =>
    forgeOf(deps, organizationId, connectionId, undefined);

/**
 * What reading, retrying and cancelling a run asks of a forge: GitLab's client and the GitHub adapter both have it
 * (FRG-14). Starting a run (plan and apply, FRG-30) and the artifacts of a job still need GitLab's client.
 */
export type RunForge = Pick<Forge, "pipelines">;

/** `RunDeps` for a function that only reads runs: `gitlab` may hand back any forge's client. */
export type ReadDeps = Pick<RunDeps, "db" | "now"> & {
  gitlab: (organizationId: string, connectionId: string) => Promise<RunForge>;
};

/**
 * What the two consumers of a run's events need: GitLab's client for a GitLab event, and `forge` for a GitHub one (FRG-22).
 * Without `forge`, a GitHub event is dropped with a warning, so a worker that cannot open a connection says so.
 */
export type EventDeps = RunDeps & { forge?: ForgeFor };

export interface RunAt {
  organizationId: string;
  projectId: string;
  /** GitLab's id of the project. */
  gitlabProjectId: number;
  connectionId: string;
}

/** The first job that failed and was not allowed to: what a person wants to know first. */
async function firstFailure(gitlab: RunForge, project: number, pipelineId: number) {
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
export async function readPipeline(
  deps: ReadDeps,
  at: RunAt,
  pipelineId: number,
  client?: RunForge,
) {
  const observedAt = await (deps.now ?? (() => databaseTime(deps.db)))();
  const gitlab = client ?? (await deps.gitlab(at.organizationId, at.connectionId));
  const p = await gitlab.pipelines.get(at.gitlabProjectId, pipelineId);
  const failure =
    p.status === "failed" ? await firstFailure(gitlab, at.gitlabProjectId, p.id) : noFailure;
  return row(at, p, observedAt, failure);
}

/**
 * GitLab refusing or failing, as the API reports it; `refused` is what GitLab would not do.
 * shortcut: the sentences say GitLab; the routes that reach a GitHub run (FRG-22) name the forge.
 */
export const retryProblem = (e: unknown, refused = "retry this pipeline") => {
  if (!(e instanceof GitlabError)) return e;
  if (e.kind === "not_found") {
    return new DomainError("gitlab_pipeline_gone", 422, "GitLab no longer has this pipeline.");
  }
  if (e.kind === "forbidden" || e.kind === "invalid") {
    return new DomainError("gitlab_refused", 422, `GitLab would not ${refused}.`);
  }
  return new DomainError("gitlab_failed", 502, WHY[e.kind]);
};

/**
 * Asks GitLab to run the failed jobs of a pipeline again, then reads the pipeline as the other
 * events do (the read begins after the retry, so no earlier read can replace it), and returns what
 * it is now (not yet recorded). If the read fails the retry has still happened.
 */
export async function retryPipeline(deps: ReadDeps, at: RunAt, pipelineId: number) {
  const gitlab = await deps.gitlab(at.organizationId, at.connectionId);
  await gitlab.pipelines.retry(at.gitlabProjectId, pipelineId).catch((e) => {
    throw retryProblem(e);
  });
  return readPipeline(deps, at, pipelineId, gitlab).catch((e) => {
    throw retryProblem(e);
  });
}

/** Why an event cannot be handled now or later, when it cannot: the job is dropped, not retried. */
export const hopeless = (e: unknown, what = "the pipeline", forge = "GitLab") => {
  if (e instanceof GitlabError) {
    if (e.kind === "not_found") return `${forge} no longer has ${what}`;
    if (e.kind === "unauthorized" || e.kind === "forbidden") return `${forge} refuses the token`;
  }
  // the connection was deleted or is not a GitLab one: nothing a retry could change
  if (e instanceof DomainError && (e.status === 404 || e.status === 422)) {
    return "the connection is gone";
  }
  return undefined;
};

export const pipelineEvent = z.looseObject({
  event: z.literal("pipeline"),
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  projectId: z.number().int().positive(),
  pipelineId: z.number().int().positive(),
});

/** GitHub's events about a workflow run, as the receiver queued them (FRG-21): `projectId` is the repository's id. */
export const githubRunEvent = z.looseObject({
  event: z.enum(["workflow_run", "workflow_job", "deployment_review"]),
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
 * the queue retries it. Needs the master keys, to open the connection's token. A pipeline that has
 * finished is then read for secret findings (`ingestSecretFindings`, SCAN-3).
 */
export const pipelineEventHandler =
  (deps: EventDeps): JobHandler =>
  async (ctx) => {
    const github = githubRunEvent.safeParse(ctx.payload);
    const parsed = github.success ? github : pipelineEvent.safeParse(ctx.payload);
    if (!parsed.success) return;
    const e = parsed.data;
    const open = github.success ? deps.forge : deps.gitlab;
    if (!open) {
      ctx.log.warn("run event dropped", { reason: "no way to open the connection" });
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
      ctx.log.debug("pipeline event for a project that is not linked");
      return;
    }
    const at = {
      organizationId: e.organizationId,
      projectId: project.id,
      gitlabProjectId: e.projectId,
      connectionId: e.connectionId,
    };
    let client: RunForge;
    let seen: Awaited<ReturnType<typeof readPipeline>>;
    try {
      client = await open(at.organizationId, at.connectionId);
      seen = await readPipeline(deps, at, e.pipelineId, client);
    } catch (error) {
      const why = hopeless(error);
      if (!why) throw error;
      ctx.log.warn("pipeline event dropped", { reason: why, connection: e.connectionId });
      return;
    }
    const { stored } = await recordPipelineRun(deps.db, seen);
    ctx.log.debug("pipeline event handled", { status: seen.status, stored });
    // a secret report is a GitLab job's artifact; GitHub has none to read
    if (github.success || !isFinished(seen.status)) return;
    // the run is stored; a failure below fails the job, and the retry stores it again, unchanged
    try {
      await ingestSecretFindings(
        deps,
        at,
        client as Gitlab,
        { id: e.pipelineId, ref: seen.ref },
        ctx.log,
      );
    } catch (error) {
      const why = hopeless(error, "the job");
      if (!why) throw error;
      ctx.log.warn("secret report dropped", { reason: why, connection: e.connectionId });
    }
  };
