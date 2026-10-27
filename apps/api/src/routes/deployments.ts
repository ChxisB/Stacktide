import { DomainError, deploymentStats, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  type AuditEvent,
  consumeDeployApproval,
  currentDeployments,
  type Deployment,
  databaseTime,
  deploymentOutcomes,
  getPipelineConfig,
  getProject,
  listDeployments,
  listEnvironments,
  type NewDeployment,
  previousSuccess,
  recordSeenDeployment,
  type Tx,
} from "@orch/db";
import { GitlabError } from "@orch/gitlab";
import { deployRunName } from "@orch/pipelines";
import { Elysia } from "elysia";
import { z } from "zod";
import { approvalRequired } from "../apply-approval";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { deploymentProblem, deploymentRow } from "../deployments";
import { guardPlugin } from "../guard";
import { pipelineFileOf } from "../pipeline-apply";
import { type PromotionPlan, planPromotion, planRollback, promotionVariables } from "../promotion";
import { forgeOf } from "./pipeline";
import { iso, notFound, type RouteDeps, readErrors, writeErrors } from "./shared";

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });
/** The most one refresh reads: GitLab's newest changes, which is all a hook missed. */
const REFRESH_READS = 100;
const sealed = { 500: z.any(), 502: z.any(), 503: z.any() } as const;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;
const DAY_MS = 86_400_000;
/** The most outcomes the numbers read (see `deploymentOutcomes`). */
const STATS_ROWS = 10_000;

/** What an answer says of a deployment: ids, an environment's name, a commit's sha, a status and times, and nothing else a row holds. */
const deploymentSchema = z.object({
  id: z.uuid(),
  gitlabDeploymentId: z.number().int(),
  environment: z.string(),
  sha: z.string(),
  ref: z.string(),
  status: z.string(),
  jobId: z.number().int().nullable(),
  pipelineId: z.number().int().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  observedAt: z.iso.datetime(),
});
const dto = (d: Deployment): z.infer<typeof deploymentSchema> => ({
  id: d.id,
  gitlabDeploymentId: d.gitlabDeploymentId,
  environment: d.environment,
  sha: d.sha,
  ref: d.ref,
  status: d.status,
  jobId: d.jobId,
  pipelineId: d.pipelineId,
  finishedAt: d.finishedAt ? iso(d.finishedAt) : null,
  observedAt: iso(d.observedAt),
});
const planSchema = z.object({
  environment: z.string(),
  /** A protected environment is entered with an approved request for this build (change requests). */
  protected: z.boolean(),
  from: z.object({ sha: z.string(), finishedAt: z.iso.datetime().nullable() }).nullable(),
  to: z.string(),
  previous: z.string().nullable(),
  defaultBranch: z.string(),
  /** The names of the variables the pipeline is started with, never their values. */
  variables: z.array(z.string()),
});
const planDto = ({ environmentId: _, ...p }: PromotionPlan): z.infer<typeof planSchema> => ({
  ...p,
  from: p.from && { sha: p.from.sha, finishedAt: p.from.finishedAt && iso(p.from.finishedAt) },
});
const promotedSchema = z.object({
  dryRun: z.boolean(),
  plan: planSchema,
  /** The pipeline GitLab started; null for a dry run. */
  pipeline: z.object({ id: z.number().int(), webUrl: z.string() }).nullable(),
});
const statsSchema = z.object({
  environment: z.string(),
  /** successful deployments in the window */
  deployments: z.number().int(),
  failed: z.number().int(),
  perWeek: z.number().nullable(),
  failureRate: z.number().nullable(),
  medianRestoreSeconds: z.number().int().nullable(),
});
const environmentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  protected: z.boolean(),
  current: deploymentSchema.nullable(),
  lastAttempt: deploymentSchema.nullable(),
  /** The build a rollback of this environment would deploy; null when there is none, so the page offers none. */
  rollbackTo: z.string().nullable(),
});

/** The deploy workflow's file name below `.github/workflows/`: the one the onboarding commits (`pipelineFileOf`). */
const DEPLOY_WORKFLOW = pipelineFileOf("github").slice(
  pipelineFileOf("github").lastIndexOf("/") + 1,
);

/** The project, and the id its forge knows it by: a project that is not linked to a repository cannot deploy. */
async function linkedProject(db: RouteDeps["db"], orgId: string, projectId: string) {
  const project = await getProject(db, orgId, projectId);
  if (!project) throw notFound("Project");
  if (project.gitlabProjectId === null)
    throw new DomainError("not_linked", 422, "This project is not linked to a repository");
  return { project, gitlabProjectId: project.gitlabProjectId };
}

/**
 * What a promotion and a rollback share once the plan is made: a dry run is recorded and answered; applying
 * starts the pipeline on the default branch with the plan's variables, then records that. `action` is the
 * route's audit action. The plan came from the database alone, so every refusal has happened before this.
 */
async function startDeployment(
  deps: { db: RouteDeps["db"]; keys?: KeyProvider; logger: Logger },
  run: {
    orgId: string;
    projectId: string;
    gitlabProjectId: number;
    plan: PromotionPlan;
    action: string;
    dryRun: boolean | undefined;
    audit: (tx: Tx, event: AuditEvent) => Promise<void>;
    requestId: unknown;
  },
): Promise<z.infer<typeof promotedSchema>> {
  const { db, keys, logger } = deps;
  const { orgId, projectId, plan } = run;
  const event = (
    pipelineId: number | null,
    dryRun: boolean,
    changeRequestId?: string,
    unknownOutcome?: boolean,
  ): AuditEvent => ({
    action: run.action,
    resourceType: "project",
    resourceId: projectId,
    organizationId: orgId,
    projectId,
    metadata: {
      environment: plan.environment,
      sha: plan.to,
      previous: plan.previous,
      pipelineId,
      dryRun,
      ...(changeRequestId ? { changeRequestId } : {}),
      ...(unknownOutcome ? { outcome: "unknown" } : {}),
    },
  });
  // a success must write an audit row, so a dry run writes one too (as a variable import does)
  if (run.dryRun) {
    await db.transaction((tx) => run.audit(tx, event(null, true)));
    return { dryRun: true, plan: planDto(plan), pipeline: null };
  }
  if (!keys) throw noKeys();
  // the plan found the config: it is the connection the project's pipeline was set up with
  const connectionId = (await getPipelineConfig(db, orgId, projectId))?.connectionId;
  if (!connectionId)
    throw new DomainError(
      "no_connection",
      409,
      "No connection is known for this project: set up its pipeline first",
    );
  const forge = await forgeOf({ db, keys, logger }, orgId, connectionId, run.requestId);
  const forgeName = forge.kind === "github" ? "GitHub" : "GitLab";
  // GitLab starts a pipeline with variables; GitHub dispatches the deploy workflow, which takes inputs and is found by its name (CLD-11)
  const start = () =>
    forge.kind === "github" && forge.startRun
      ? forge.startRun(run.gitlabProjectId, {
          workflow: DEPLOY_WORKFLOW,
          ref: plan.defaultBranch,
          inputs: {
            environment: plan.environment,
            sha: plan.to,
            ...(plan.previous ? { previous_sha: plan.previous } : {}),
          },
          name: deployRunName(plan.environment, plan.to),
        })
      : forge.pipelines.trigger(run.gitlabProjectId, plan.defaultBranch, promotionVariables(plan));
  // shortcut: two requests within seconds both pass the plan's "in progress" check, because the
  // table only knows what GitLab has reported; the resource group makes the second deploy wait and
  // run the same build again, which the script must tolerate (docs/deployments.md). Upgrade when
  // a lock per environment is wanted. The approval of a protected environment is taken in the same
  // transaction as the start and the audit row, so a refused start leaves it for the next try; a
  // commit that fails after GitLab accepted the pipeline leaves it unspent beside a started pipeline.
  const started = await db.transaction(async (tx) => {
    const approval = plan.protected
      ? await consumeDeployApproval(
          tx,
          { organizationId: orgId, projectId, environmentId: plan.environmentId },
          plan.to,
        )
      : undefined;
    if (plan.protected && !approval)
      throw approvalRequired(`Deploying ${plan.to.slice(0, 12)}`, [plan.environment]);
    const pipeline = await start().catch((e) => {
      // shortcut: a timeout or a conflict from `startRun` is taken as "GitHub accepted the dispatch", though a timeout of
      // the first look is not; the approval is spent either way and the person checks Actions. Upgrade when startRun says which.
      if (
        forge.kind === "github" &&
        e instanceof GitlabError &&
        ["timeout", "conflict"].includes(e.kind)
      )
        return null;
      throw deploymentProblem(e, "start the deployment", forgeName);
    });
    await run.audit(tx, event(pipeline?.id ?? null, false, approval?.id, !pipeline));
    return pipeline;
  });
  if (!started)
    throw new DomainError(
      "deployment_outcome_unknown",
      502,
      "GitHub accepted the start, but the run could not be found. Check the repository's Actions before starting it again.",
    );
  return {
    dryRun: false,
    plan: planDto(plan),
    pipeline: { id: started.id, webUrl: started.webUrl },
  };
}

/**
 * Deployments (ADR-0020): what the forge says was deployed where. The worker stores them from GitLab's
 * Deployment Hook or GitHub's `deployment_status`; refresh reads the newest from the forge for a project whose hook
 * is not set up, or has missed some. A row is what GitLab answered, never what an event said, and holds no user or commit text.
 */
export const deploymentRoutes = ({
  db,
  principal,
  keys,
  logger,
}: RouteDeps & { keys?: KeyProvider; logger: Logger }) =>
  new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/deployments" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId, projectId }, query }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        const rows = await listDeployments(db, orgId, projectId, {
          ...query,
          limit: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        return {
          deployments: page.map(dto),
          next: rows.length > page.length ? (page.at(-1)?.gitlabDeploymentId ?? null) : null,
        };
      },
      {
        params,
        query: z.object({
          /** The name GitLab gives the environment, which is the platform environment's slug. */
          environment: z.string().min(1).max(255).optional(),
          status: z
            .string()
            .regex(/^[a-z_]{1,32}$/)
            .optional(),
          /** The `next` of the page before: deployments with a smaller GitLab id. */
          before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
          limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE),
        }),
        response: {
          200: z.object({
            deployments: z.array(deploymentSchema),
            next: z.number().int().nullable(),
          }),
          ...readErrors,
        },
        guard: "deployment.read",
      },
    )
    .get(
      "/environments",
      async ({ params: { orgId, projectId } }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        const seen = new Map(
          (await currentDeployments(db, orgId, projectId)).map((e) => [e.environment, e]),
        );
        // shortcut: all of a project's environments in one answer (a project has a handful), page it if one ever has hundreds
        const platform = await listEnvironments(db, orgId, projectId);
        const known = new Set(platform.map((e) => e.slug));
        return {
          // shortcut: one query a environment for its rollback target; fold into one when a project has dozens
          environments: await Promise.all(
            platform.map(async (e) => {
              const current = seen.get(e.slug)?.current;
              return {
                id: e.id,
                name: e.name,
                slug: e.slug,
                protected: e.protected,
                current: current ? dto(current) : null,
                lastAttempt: seen.has(e.slug)
                  ? dto(seen.get(e.slug)?.lastAttempt as Deployment)
                  : null,
                rollbackTo: current
                  ? ((await previousSuccess(db, orgId, projectId, e.slug, current.sha))?.sha ??
                    null)
                  : null,
              };
            }),
          ),
          unmatched: [...seen.keys()].filter((name) => !known.has(name)),
        };
      },
      {
        params,
        response: {
          200: z.object({
            environments: z.array(environmentSchema),
            unmatched: z.array(z.string()),
          }),
          ...readErrors,
        },
        guard: "deployment.read",
      },
    )
    .get(
      "/stats",
      async ({ params: { orgId, projectId }, query }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        const now = await databaseTime(db);
        const rows = await deploymentOutcomes(db, orgId, projectId, {
          since: new Date(now.getTime() - query.days * DAY_MS),
          ...(query.environment === undefined ? {} : { environment: query.environment }),
          limit: STATS_ROWS,
        });
        const environments =
          query.environment === undefined
            ? (await listEnvironments(db, orgId, projectId)).map((e) => e.slug)
            : [query.environment];
        return {
          days: query.days,
          environments: deploymentStats(rows, { now, days: query.days, environments }),
        };
      },
      {
        params,
        query: z.object({
          /** How far back to look, counted in days before now. */
          days: z.coerce.number().int().min(1).max(365).default(30),
          /** The name GitLab gives the environment, which is the platform environment's slug. */
          environment: z.string().min(1).max(255).optional(),
        }),
        response: {
          200: z.object({ days: z.number().int(), environments: z.array(statsSchema) }),
          ...readErrors,
        },
        guard: "deployment.read",
      },
    )
    .post(
      "/refresh",
      async ({ params: { orgId, projectId }, audit, set }) => {
        if (!keys) throw noKeys();
        const project = await getProject(db, orgId, projectId);
        if (!project) throw notFound("Project");
        if (project.gitlabProjectId === null) {
          throw new DomainError("not_linked", 422, "This project is not linked to a repository");
        }
        // the connection the project's pipeline was set up with, else the one that last read a deployment of it
        const connectionId =
          (await getPipelineConfig(db, orgId, projectId))?.connectionId ??
          (await listDeployments(db, orgId, projectId, { limit: 1 }))[0]?.connectionId;
        if (!connectionId) {
          throw new DomainError(
            "no_connection",
            409,
            "No connection is known for this project: set up its pipeline first",
          );
        }
        const at = {
          organizationId: orgId,
          projectId,
          gitlabProjectId: project.gitlabProjectId,
          connectionId,
        };
        const forge = await forgeOf(
          { db, keys, logger },
          orgId,
          connectionId,
          set.headers["x-request-id"],
        );
        const forgeName = forge.kind === "github" ? "GitHub" : "GitLab";
        // taken before asking: of two reads the one that began later wins, whatever order they finish in
        const observedAt = await databaseTime(db);
        const seen: { row: NewDeployment; pipelineUrl: string | null }[] = [];
        try {
          for await (const d of forge.deployments.list(project.gitlabProjectId, {
            orderBy: "updated_at",
            sort: "desc",
          })) {
            if (seen.length === REFRESH_READS) break;
            seen.push({ row: deploymentRow(at, d, observedAt), pipelineUrl: d.pipelineUrl });
          }
        } catch (e) {
          throw deploymentProblem(e, "list its deployments", forgeName);
        }
        const recorded = await db.transaction(async (tx) => {
          let stored = 0;
          for (const { row, pipelineUrl } of seen) {
            if ((await recordSeenDeployment(tx, row, pipelineUrl)).stored) stored++;
          }
          await audit(tx, {
            action: "deployment.refresh",
            resourceType: "project",
            resourceId: projectId,
            organizationId: orgId,
            projectId,
            metadata: { recorded: stored },
          });
          return stored;
        });
        return { recorded };
      },
      {
        params,
        response: { 200: z.object({ recorded: z.number().int() }), ...writeErrors, ...sealed },
        audit: "deployment.refresh",
        guard: "deployment.refresh",
      },
    )
    .post(
      "/promote",
      async ({ params: { orgId, projectId }, body, audit, set }) => {
        const { project, gitlabProjectId } = await linkedProject(db, orgId, projectId);
        const plan = await planPromotion(db, {
          project,
          environment: body.environment,
          sha: body.sha,
        });
        const answer = await startDeployment(
          { db, keys, logger },
          {
            orgId,
            projectId,
            gitlabProjectId,
            plan,
            action: "deployment.promote",
            dryRun: body.dryRun,
            audit,
            requestId: set.headers["x-request-id"],
          },
        );
        if (!answer.dryRun) set.status = 202;
        return answer;
      },
      {
        params,
        body: z.strictObject({
          environment: z.string().max(255),
          sha: z.string().max(255),
          /** Answers what would happen and starts nothing. */
          dryRun: z.boolean().optional(),
        }),
        response: { 200: promotedSchema, 202: promotedSchema, ...writeErrors, ...sealed },
        audit: "deployment.promote",
        guard: "deployment.promote",
      },
    )
    .post(
      "/rollback",
      async ({ params: { orgId, projectId }, body, audit, set }) => {
        const { project, gitlabProjectId } = await linkedProject(db, orgId, projectId);
        const plan = await planRollback(db, { project, environment: body.environment });
        const answer = await startDeployment(
          { db, keys, logger },
          {
            orgId,
            projectId,
            gitlabProjectId,
            plan,
            action: "deployment.rollback",
            dryRun: body.dryRun,
            audit,
            requestId: set.headers["x-request-id"],
          },
        );
        if (!answer.dryRun) set.status = 202;
        return answer;
      },
      {
        params,
        // no sha: the platform picks the build, the one that was there before
        body: z.strictObject({
          environment: z.string().max(255),
          /** Answers which build it would go back to and starts nothing. */
          dryRun: z.boolean().optional(),
        }),
        response: { 200: promotedSchema, 202: promotedSchema, ...writeErrors, ...sealed },
        audit: "deployment.rollback",
        guard: "deployment.rollback",
      },
    );
