import { DomainError, type Logger, POLICY_RULE, RUN_STATES } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  auditedStacks,
  connectionOfRun,
  createRun,
  getProject,
  getRun,
  listRuns,
  listStacks,
  MAX_RUN_STACKS,
  notifyStackDrift,
  type RunWithStacks,
  recordStackDrift,
  ruleNames,
  storePlanSummary,
  storePolicyVerdict,
} from "@orch/db";
import { GitlabError } from "@orch/gitlab";
import type { Tool } from "@orch/iac";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys, WHY } from "../connections";
import { guardPlugin } from "../guard";
import type { Principal } from "../principal";
import { applyRun } from "../run-apply";
import { gitlabFor } from "./pipeline";
import {
  iso,
  notFound,
  paged,
  pageOf,
  pageQuery,
  problemSchema,
  type RouteDeps,
  readCapped,
  readErrors,
  stamps,
  writeErrors,
} from "./shared";

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });

// the `runs.merge_request_iid` column is a 32-bit integer
const MAX_IID = 2 ** 31 - 1;

const runSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  ref: z.string(),
  /** The commit the plans are made from. */
  sha: z.string(),
  mergeRequestIid: z.number().int().nullable(),
  /** `plan`: a change's plans, which an apply may follow. `drift`: a scheduled check, never applied. */
  kind: z.enum(["plan", "drift"]),
  /** Each stack of the run and where it is; a run has no state of its own. */
  stacks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(RUN_STATES),
      /** Why it failed, in fixed words; empty unless it did. */
      error: z.string().nullable(),
      /** When it last changed state. */
      updatedAt: z.iso.datetime(),
    }),
  ),
  ...stamps,
});

const dto = (r: RunWithStacks): z.infer<typeof runSchema> => ({
  id: r.id,
  organizationId: r.organizationId,
  projectId: r.projectId,
  ref: r.ref,
  sha: r.sha,
  mergeRequestIid: r.mergeRequestIid,
  kind: r.kind as "plan" | "drift",
  stacks: r.stacks.map((s) => ({
    name: s.stack,
    status: s.status as (typeof RUN_STATES)[number],
    error: s.error,
    updatedAt: iso(s.updatedAt),
  })),
  createdAt: iso(r.createdAt),
  // a run has no state of its own, so it last changed when its newest stack did
  updatedAt: iso(r.stacks.reduce((at, s) => (s.updatedAt > at ? s.updatedAt : at), r.updatedAt)),
});

const body = z.strictObject({
  /** The branch the plans are made from. */
  ref: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/, "not a valid ref")
    // what git refuses in a ref name, beyond the characters the pattern leaves out
    .refine(
      (b) =>
        !(b.includes("..") || b.endsWith(".")) &&
        b
          .split("/")
          .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock")),
      "not a valid ref",
    ),
  sha: z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/, "not a full commit id"),
  mergeRequestIid: z.number().int().positive().max(MAX_IID).optional(),
  /** Names of stacks of this project. */
  stacks: z
    .array(z.string().min(1).max(63))
    .min(1)
    .max(MAX_RUN_STACKS)
    .refine((names) => new Set(names).size === names.length, "a stack is named twice"),
});

/** The cap on a summary's body: 500 resources of at most 1024 characters stay below it. */
export const MAX_SUMMARY_BYTES = 1024 * 1024;
// shortcut: a summary lists at most 500 resources (the counts are whole); upgrade when a plan really changes more and a reader needs them all.
const MAX_LISTED = 500;
const count = z.number().int().min(0).max(1_000_000);

const summaryBody = z.strictObject({
  stack: z.string().min(1).max(63),
  add: count,
  change: count,
  destroy: count,
  resources: z
    .array(
      z.strictObject({
        // what terraform prints for a resource; it is shown to people, so nothing that hides or reorders
        // text: control and format characters (bidi overrides, zero-width) and line or paragraph separators
        address: z
          .string()
          .min(1)
          .max(1024)
          .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, "not a resource address"),
        actions: z
          .array(z.string().regex(/^[a-z][a-z-]{0,19}$/, "not an action"))
          .min(1)
          .max(4),
      }),
    )
    .max(MAX_LISTED),
});

// A rule name is the one thing of a policy's finding that travels (never its message, which may quote
// the plan); the filter of the generated job and this pattern are one contract (POL-3).
const rule = z.string().regex(POLICY_RULE, "not a rule name");
const policyBody = z.discriminatedUnion("evaluated", [
  z.strictObject({
    stack: z.string().min(1).max(63),
    evaluated: z.literal(true),
    denied: z.array(rule).max(50),
    warned: z.array(rule).max(50),
  }),
  // the evaluator ran and gave no answer that could be read: not a pass, so it judges as a deny
  z.strictObject({ stack: z.string().min(1).max(63), evaluated: z.literal(false) }),
]);
/** The cap on a verdict's body: 100 rule names of at most 200 characters stay far below it. */
const MAX_POLICY_BYTES = 64 * 1024;

const applyBody = z.strictObject({
  /** Names of stacks of the run; the stacks that are planned when left out. */
  stacks: z
    .array(z.string().min(1).max(63))
    .min(1)
    .max(MAX_RUN_STACKS)
    .refine((names) => new Set(names).size === names.length, "a stack is named twice")
    .optional(),
});
const sealed = { 500: z.any(), 502: z.any(), 503: z.any() } as const;

/** What GitLab's refusal of the apply is to the caller: fixed words, never GitLab's own text. */
const applyProblem = (e: unknown) => {
  if (!(e instanceof GitlabError)) return e;
  if (e.kind === "not_found") {
    return new DomainError(
      "gitlab_gone",
      422,
      "GitLab no longer has this merge request or its repository",
    );
  }
  if (e.kind === "forbidden" || e.kind === "invalid") {
    return new DomainError("gitlab_refused", 422, "GitLab refused the connection's request");
  }
  return new DomainError("gitlab_failed", 502, WHY[e.kind]);
};

// One message for every way the caller can fail to be the stack's summary job: which of them it was says too much.
const notTheJob = () =>
  new DomainError("forbidden", 403, "Not allowed: only the summary job of this stack may post it");

const cappedJson =
  (max: number, what: string) =>
  async ({ request }: { request: Request }) => {
    const text = await readCapped(request, max);
    if (text === undefined) {
      throw new DomainError("payload_too_large", 413, `The ${what} is too large`);
    }
    return JSON.parse(text);
  };

/**
 * The runs of a project's IaC stacks (IAC-5): which stacks, on which commit, and where each one is.
 * Creating one only records it, with every stack `queued`; the states move as the pipeline's events
 * arrive (`run-ingest.ts`). Starting one takes `run.create`, reading `run.read`. A plan job posts its
 * stack's counts and resource addresses to `/:runId/plan-summary` (`run.summary`): only the job that
 * ingest recorded as that stack's summary job, which a CI token's scope alone does not make it.
 */
export const runRoutes = ({
  db,
  principal,
  logger,
  keys,
  images,
}: RouteDeps & {
  logger: Logger;
  keys?: KeyProvider;
  images?: Partial<Record<Tool, string>> | undefined;
}) => {
  // Only the CI job the platform recorded as this stack's summary job (from the pipeline's events),
  // on the run's own ref. A token holds `run.summary` for every job without an environment, so the
  // scope alone would let any job of the project post any stack's summary, or its policy verdict.
  const onlyTheSummaryJob = (
    run: RunWithStacks,
    caller: Principal | undefined,
    stack: string,
    what: string,
    requestId: unknown,
  ) => {
    const job = caller?.kind === "ci" ? caller.job : undefined;
    const mine = run.stacks.find((s) => s.stack === stack);
    const why = !job
      ? "the caller is not a CI job"
      : !mine
        ? "the stack is not in the run"
        : job.ref !== run.ref
          ? "the job's ref is not the run's"
          : mine.summaryJobId === null
            ? "no summary job is recorded for the stack yet"
            : job.gitlabJobId !== mine.summaryJobId
              ? "the job is not the stack's summary job"
              : undefined;
    if (why) {
      // the caller gets one message; the log says which, for whoever finds a real job refused
      logger.warn(`${what} refused`, { request_id: requestId, reason: why });
      throw notTheJob();
    }
  };
  return new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/runs" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .post(
      "",
      async ({ params: { orgId, projectId }, body, audit, set }) => {
        // shortcut: these checks and the insert are not one snapshot; a project deleted between them
        // fails the insert (a 500), and a stack a rescan just removed is recorded; upgrade with IAC-6, which fails a stack it cannot find.
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        const known = new Set((await listStacks(db, orgId, projectId)).map((s) => s.name));
        const unknown = body.stacks.filter((n) => !known.has(n));
        if (unknown.length > 0) {
          throw new DomainError(
            "unknown_stack",
            422,
            `This project has no stack named ${unknown
              .slice(0, 5)
              .map((n) => JSON.stringify(n))
              .join(", ")}${unknown.length > 5 ? " or others" : ""}`,
          );
        }
        const run = await db.transaction(async (tx) => {
          const run = await createRun(tx, { ...body, organizationId: orgId, projectId });
          await audit(tx, {
            action: "run.create",
            resourceType: "run",
            resourceId: run.id,
            organizationId: orgId,
            projectId,
            metadata: {
              ref: run.ref,
              sha: run.sha,
              mergeRequestIid: run.mergeRequestIid,
              // the run lists them all
              ...auditedStacks(body.stacks),
            },
          });
          return run;
        });
        set.status = 201;
        return dto(run);
      },
      {
        params,
        body,
        parse: "json",
        response: { 201: runSchema, ...writeErrors },
        audit: "run.create",
        guard: "run.create",
      },
    )
    .get(
      "",
      async ({ params: { orgId, projectId }, query }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (r: RunWithStacks) => [r.id],
          fetch: (after, limit) => listRuns(db, orgId, projectId, { before: after?.[0], limit }),
          dto,
        });
      },
      {
        params,
        query: pageQuery,
        response: { 200: pageOf(runSchema), ...readErrors },
        guard: "run.read",
      },
    )
    .get(
      "/:runId",
      async ({ params: { orgId, projectId, runId } }) => {
        const run = await getRun(db, orgId, projectId, runId);
        if (!run) throw notFound("Run");
        return dto(run);
      },
      {
        params: params.extend({ runId: z.uuid() }),
        response: { 200: runSchema, ...readErrors },
        guard: "run.read",
      },
    )
    .post(
      "/:runId/plan-summary",
      async ({ params: { orgId, projectId, runId }, body, principal, audit, set }) => {
        const run = await getRun(db, orgId, projectId, runId);
        if (!run) throw notFound("Run");
        onlyTheSummaryJob(run, principal, body.stack, "plan summary", set.headers["x-request-id"]);
        await db.transaction(async (tx) => {
          const stored = await storePlanSummary(tx, orgId, projectId, runId, body.stack, body);
          if (!stored) {
            throw new DomainError(
              "stack_closed",
              409,
              "This stack's plan is no longer open to a summary",
            );
          }
          await audit(tx, {
            action: "run.summary",
            resourceType: "run",
            resourceId: runId,
            organizationId: orgId,
            projectId,
            // counts only: which resources a plan touches is for the run's readers, not the audit trail
            metadata: {
              stack: body.stack,
              add: body.add,
              change: body.change,
              destroy: body.destroy,
              resources: body.resources.length,
            },
          });
          // A drift run's plan is the finding; an episode's start and end are the only news.
          if (run.kind === "drift") {
            const counts = { add: body.add, change: body.change, destroy: body.destroy };
            const news = await recordStackDrift(
              tx,
              { organizationId: orgId, projectId, stack: body.stack },
              counts,
              // when the plan was asked for, so a run that finishes late cannot undo a newer one's finding
              run.createdAt,
            );
            if (news) {
              await audit(tx, {
                action: "stack.drift",
                resourceType: "stack",
                resourceId: body.stack,
                organizationId: orgId,
                projectId,
                metadata: {
                  stack: body.stack,
                  status: news === "detected" ? "drifted" : "clean",
                  ...counts,
                },
              });
              // Queued with the finding it reports, so each one exists exactly when the other does.
              await notifyStackDrift(tx, {
                organizationId: orgId,
                projectId,
                stack: body.stack,
                status: news === "detected" ? "drifted" : "clean",
                ...counts,
                at: run.createdAt,
              });
            }
          }
        });
        set.status = 204;
      },
      {
        params: params.extend({ runId: z.uuid() }),
        body: summaryBody,
        // The body is read in full before the guard runs (Elysia parses first), so it is capped here.
        parse: cappedJson(MAX_SUMMARY_BYTES, "summary"),
        response: { 204: z.undefined(), ...writeErrors, 413: problemSchema },
        audit: ["run.summary", "stack.drift"],
        guard: "run.summary",
      },
    )
    .post(
      "/:runId/policy-verdict",
      async ({ params: { orgId, projectId, runId }, body, principal, audit, set }) => {
        const run = await getRun(db, orgId, projectId, runId);
        if (!run) throw notFound("Run");
        onlyTheSummaryJob(
          run,
          principal,
          body.stack,
          "policy verdict",
          set.headers["x-request-id"],
        );
        await db.transaction(async (tx) => {
          const stored = await storePolicyVerdict(tx, orgId, projectId, runId, body.stack, {
            evaluated: body.evaluated,
            denied: body.evaluated ? body.denied : [],
            warned: body.evaluated ? body.warned : [],
          });
          if (!stored) {
            throw new DomainError(
              "stack_closed",
              409,
              "This stack's plan is no longer open to a policy verdict",
            );
          }
          await audit(tx, {
            action: "run.policy",
            resourceType: "run",
            resourceId: runId,
            organizationId: orgId,
            projectId,
            // the verdict and how many rules; the names are on the stack, the messages in the job's log only
            metadata: {
              stack: body.stack,
              verdict: stored.policyVerdict,
              denied: ruleNames(stored.policyDenied).length,
              warned: ruleNames(stored.policyWarned).length,
              evaluated: body.evaluated,
            },
          });
        });
        set.status = 204;
      },
      {
        params: params.extend({ runId: z.uuid() }),
        body: policyBody,
        parse: cappedJson(MAX_POLICY_BYTES, "verdict"),
        response: { 204: z.undefined(), ...writeErrors, 413: problemSchema },
        audit: "run.policy",
        // the summary job's own scope: the job that judges the plan is the job that summarizes it
        guard: "run.summary",
      },
    )
    .post(
      "/:runId/apply",
      async ({ params: { orgId, projectId, runId }, body, audit, set }) => {
        if (!keys) throw noKeys();
        const project = await getProject(db, orgId, projectId);
        if (!project) throw notFound("Project");
        if (project.gitlabProjectId === null) {
          throw new DomainError("not_linked", 422, "This project was not imported from GitLab");
        }
        const run = await getRun(db, orgId, projectId, runId);
        if (!run) throw notFound("Run");
        const connectionId = await connectionOfRun(db, orgId, projectId, runId);
        if (connectionId === undefined) {
          throw new DomainError(
            "no_connection",
            409,
            "The connection that read this run's pipelines is not known",
          );
        }
        try {
          const gitlab = await gitlabFor(
            { db, keys, logger },
            orgId,
            connectionId,
            set.headers["x-request-id"],
          );
          await applyRun({ db, log: logger, images }, gitlab, {
            at: { organizationId: orgId, projectId, gitlabProjectId: project.gitlabProjectId },
            run,
            stacks: body.stacks,
            when: "command",
            audit: (tx, event) => audit(tx, event),
          });
        } catch (error) {
          throw applyProblem(error);
        }
        set.status = 202;
        return dto((await getRun(db, orgId, projectId, runId)) ?? run);
      },
      {
        params: params.extend({ runId: z.uuid() }),
        body: applyBody,
        parse: "json",
        response: { 202: runSchema, ...writeErrors, ...sealed },
        audit: "run.apply",
        guard: "run.apply",
      },
    );
};
