import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  getPipelineRun,
  getProject,
  latestPipelineRuns,
  listPipelineRuns,
  type PipelineRun,
  recordPipelineRun,
} from "@orch/db";
import { GitlabError, type Job } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { guardPlugin } from "../guard";
import { clip, type RunDeps, type RunForge, retryPipeline, retryProblem } from "../pipeline-runs";
import { gitlabFor } from "./pipeline";
import { iso, notFound, type RouteDeps, readErrors, stamps, writeErrors } from "./shared";

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });
const MAX_RUNS = 100;
const DEFAULT_RUNS = 20;
const MAX_LATEST = 50;
/** Jobs in all: the pipeline's own first, then each child's from what is left. */
const MAX_JOBS = 200;
const MAX_TRIGGERS = 20;
const MAX_CHILDREN = 5;

const runSchema = z.object({
  id: z.uuid(),
  /** GitLab's id of the pipeline. */
  gitlabPipelineId: z.number().int(),
  iid: z.number().int(),
  /** GitLab's status (`running`, `success`, `failed`...); `unknown` for one this version does not know. */
  status: z.string(),
  ref: z.string(),
  sha: z.string(),
  webUrl: z.string(),
  /** GitLab's `failure_reason` of the first job that failed and was not allowed to; null otherwise. */
  failureReason: z.string().nullable(),
  failedJob: z.string().nullable(),
  /** When the platform last asked GitLab about it. */
  observedAt: z.iso.datetime(),
  ...stamps,
});
const dto = (r: PipelineRun): z.infer<typeof runSchema> => ({
  id: r.id,
  gitlabPipelineId: r.gitlabPipelineId,
  iid: r.iid,
  status: r.status,
  ref: r.ref,
  sha: r.sha,
  webUrl: r.webUrl,
  failureReason: r.failureReason,
  failedJob: r.failedJob,
  observedAt: iso(r.observedAt),
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});
/** A job as a page needs it: never GitLab's other fields (a trace, variables, a runner, a user). */
const jobSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  stage: z.string(),
  /** GitLab's status (`running`, `success`, `failed`, `manual`...). */
  status: z.string(),
  allowFailure: z.boolean(),
  /** GitLab's `failure_reason`, only on a failed job. */
  failureReason: z.string().nullable(),
  /** Seconds; null until the job has finished. */
  duration: z.number().nullable(),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  webUrl: z.string(),
});
/**
 * A trigger job: what it started, in this project or another. For another project only GitLab's number
 * of it and the pipeline's, never its name, path or address: this route reads nothing of that project.
 */
const triggerSchema = z.object({
  /** GitLab's number of the trigger job, from the sequence the jobs' are from. */
  id: z.number().int(),
  name: z.string(),
  stage: z.string(),
  status: z.string(),
  /** Empty for a trigger into another project (the address could name it). */
  webUrl: z.string(),
  downstream: z
    .object({
      pipelineId: z.number().int(),
      status: z.string(),
      /** False for another project's pipeline, and for one whose project GitLab does not name. */
      sameProject: z.boolean(),
      /** GitLab's number of the other project; null for this project's own. */
      projectId: z.number().int().nullable(),
      /** This project's child pipeline that GitLab no longer has. */
      gone: z.boolean(),
    })
    .nullable(),
});
/** A child pipeline of this project and its jobs, as the pipeline's own are. */
const childSchema = z.object({
  pipelineId: z.number().int(),
  status: z.string(),
  jobs: z.array(jobSchema),
  truncated: z.boolean(),
});
const jobOf = (j: Job): z.infer<typeof jobSchema> => ({
  id: j.id,
  name: clip(j.name),
  stage: clip(j.stage),
  status: j.status,
  allowFailure: j.allowFailure,
  failureReason: j.failureReason === null ? null : clip(j.failureReason),
  duration: j.duration,
  startedAt: j.startedAt,
  finishedAt: j.finishedAt,
  webUrl: j.webUrl,
});
/** The first `limit` jobs of a pipeline, oldest first (the 201st is read only to know there is one). */
export async function readJobs(
  gitlab: RunForge,
  project: number,
  pipelineId: number,
  limit: number,
) {
  const jobs: z.infer<typeof jobSchema>[] = [];
  let truncated = false;
  for await (const j of gitlab.pipelines.jobs(project, pipelineId)) {
    if (jobs.length === limit) {
      truncated = true;
      break;
    }
    jobs.push(jobOf(j));
  }
  // GitLab lists newest first and names no stage order; ids rise stage by stage, so oldest first reads as the pipeline runs
  // shortcut: a job made again by a retry has a newer id and sorts after the later stages' jobs, when a stage list is added to the API use it
  // shortcut: the cut keeps the first jobs GitLab lists, on a real GitLab the newest, so a pipeline of over 200 jobs shows its latest stages; read every page and sort before the cut to show the first
  jobs.sort((a, b) => a.id - b.id);
  return { jobs, truncated };
}
const sealed = { 500: z.any(), 502: z.any(), 503: z.any() } as const;

/**
 * What GitLab's pipelines of a project are doing (PIPE-8): the runs the webhooks told the platform
 * about, read from GitLab by the worker. Reading takes `pipeline.read`; retrying a failed pipeline
 * asks GitLab to run its failed jobs again with the connection that last read it (`pipeline.retry`).
 */
export const pipelineRunRoutes = ({
  db,
  principal,
  keys,
  logger,
}: RouteDeps & { keys?: KeyProvider; logger: Logger }) =>
  new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/pipeline-runs" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId, projectId }, query }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        const rows = await listPipelineRuns(db, orgId, projectId, {
          ...query,
          limit: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        return {
          runs: page.map(dto),
          next: rows.length > page.length ? (page.at(-1)?.gitlabPipelineId ?? null) : null,
        };
      },
      {
        params,
        query: z.object({
          ref: z.string().min(1).max(255).optional(),
          status: z
            .string()
            .regex(/^[a-z_]{1,32}$/)
            .optional(),
          /** The `next` of the page before: runs with a smaller GitLab pipeline id. */
          before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
          /** GitLab's number of one pipeline: the run of it in this project, if there is one. */
          pipelineId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
          limit: z.coerce.number().int().min(1).max(MAX_RUNS).default(DEFAULT_RUNS),
        }),
        response: {
          200: z.object({ runs: z.array(runSchema), next: z.number().int().nullable() }),
          ...readErrors,
        },
        guard: "pipeline.read",
      },
    )
    .get(
      "/latest",
      async ({ params: { orgId, projectId }, query }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        return { runs: (await latestPipelineRuns(db, orgId, projectId, query.limit)).map(dto) };
      },
      {
        params,
        query: z.object({
          limit: z.coerce.number().int().min(1).max(MAX_LATEST).default(MAX_LATEST),
        }),
        response: { 200: z.object({ runs: z.array(runSchema) }), ...readErrors },
        guard: "pipeline.read",
      },
    )
    .get(
      "/:runId/jobs",
      async ({ params: { orgId, projectId, runId }, set }) => {
        if (!keys) throw noKeys();
        const project = await getProject(db, orgId, projectId);
        if (!project) throw notFound("Project");
        const run = await getPipelineRun(db, orgId, projectId, runId);
        if (!run) throw notFound("Pipeline run");
        if (project.gitlabProjectId === null) {
          throw new DomainError("not_linked", 422, "This project was not imported from GitLab");
        }
        if (run.connectionId === null) {
          throw new DomainError(
            "no_connection",
            409,
            "The connection that read this pipeline has been deleted",
          );
        }
        const gitlab = await gitlabFor(
          { db, keys, logger },
          orgId,
          run.connectionId,
          set.headers["x-request-id"],
        );
        const triggers: z.infer<typeof triggerSchema>[] = [];
        const children: z.infer<typeof childSchema>[] = [];
        let triggersTruncated = false;
        try {
          // read live, never stored
          const own = await readJobs(
            gitlab,
            project.gitlabProjectId,
            run.gitlabPipelineId,
            MAX_JOBS,
          );
          let room = MAX_JOBS - own.jobs.length;
          for await (const b of gitlab.pipelines.bridges(
            project.gitlabProjectId,
            run.gitlabPipelineId,
          )) {
            if (triggers.length === MAX_TRIGGERS) {
              triggersTruncated = true;
              break;
            }
            const d = b.downstream;
            // shortcut: a trigger's own trigger is not followed (one level), nor another project's pipeline read; see NOD-11 for the latter
            const same = d !== null && d.projectId === project.gitlabProjectId;
            let gone = false;
            if (d !== null && same && children.length < MAX_CHILDREN) {
              try {
                const child = await readJobs(gitlab, project.gitlabProjectId, d.pipelineId, room);
                room -= child.jobs.length;
                children.push({
                  pipelineId: d.pipelineId,
                  status: d.status ?? "unknown",
                  ...child,
                });
              } catch (e) {
                if (!(e instanceof GitlabError && e.kind === "not_found")) throw e;
                gone = true;
              }
            }
            triggers.push({
              id: b.id,
              name: clip(b.name),
              stage: clip(b.stage),
              status: b.status,
              webUrl: d !== null && !same ? "" : b.webUrl,
              downstream:
                d === null
                  ? null
                  : {
                      pipelineId: d.pipelineId,
                      status: d.status ?? "unknown",
                      sameProject: same,
                      projectId: same ? null : d.projectId,
                      gone,
                    },
            });
          }
          return { ...own, triggers, triggersTruncated, children };
        } catch (e) {
          throw retryProblem(e, "show these jobs");
        }
      },
      {
        params: params.extend({ runId: z.uuid() }),
        response: {
          200: z.object({
            jobs: z.array(jobSchema),
            truncated: z.boolean(),
            triggers: z.array(triggerSchema),
            /** More triggers than are listed (at most 20 are). */
            triggersTruncated: z.boolean(),
            /** Children of this project, at most 5, one level; the jobs of all the pipelines are 200 at most. */
            children: z.array(childSchema),
          }),
          ...writeErrors,
          ...sealed,
        },
        guard: "pipeline.read",
      },
    )
    .post(
      "/:runId/retry",
      async ({ params: { orgId, projectId, runId }, audit, set }) => {
        if (!keys) throw noKeys();
        const project = await getProject(db, orgId, projectId);
        if (!project) throw notFound("Project");
        const run = await getPipelineRun(db, orgId, projectId, runId);
        if (!run) throw notFound("Pipeline run");
        if (run.status !== "failed" && run.status !== "canceled") {
          throw new DomainError(
            "not_retryable",
            409,
            "Only a failed or canceled pipeline can be retried",
          );
        }
        if (project.gitlabProjectId === null) {
          throw new DomainError("not_linked", 422, "This project was not imported from GitLab");
        }
        if (run.connectionId === null) {
          throw new DomainError(
            "no_connection",
            409,
            "The connection that read this pipeline has been deleted",
          );
        }
        const deps: RunDeps = {
          db,
          gitlab: (org, connectionId) =>
            gitlabFor({ db, keys, logger }, org, connectionId, set.headers["x-request-id"]),
        };
        const seen = await retryPipeline(
          deps,
          {
            organizationId: orgId,
            projectId,
            gitlabProjectId: project.gitlabProjectId,
            connectionId: run.connectionId,
          },
          run.gitlabPipelineId,
        );
        const saved = await db.transaction(async (tx) => {
          const { run: now } = await recordPipelineRun(tx, seen);
          await audit(tx, {
            action: "pipeline.retry",
            resourceType: "pipeline_run",
            resourceId: run.id,
            organizationId: orgId,
            projectId,
            metadata: { gitlabPipelineId: run.gitlabPipelineId, from: run.status, to: now.status },
          });
          return now;
        });
        return dto(saved);
      },
      {
        params: params.extend({ runId: z.uuid() }),
        response: { 200: runSchema, ...writeErrors, ...sealed },
        audit: "pipeline.retry",
        guard: "pipeline.retry",
      },
    );
