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
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { guardPlugin } from "../guard";
import { type RunDeps, retryPipeline } from "../pipeline-runs";
import { gitlabFor } from "./pipeline";
import { iso, notFound, type RouteDeps, readErrors, stamps, writeErrors } from "./shared";

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });
const MAX_RUNS = 100;
const DEFAULT_RUNS = 20;
const MAX_LATEST = 50;

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
