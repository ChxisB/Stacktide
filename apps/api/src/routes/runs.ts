import { DomainError, RUN_STATES } from "@orch/core";
import { createRun, getProject, getRun, listRuns, listStacks, type RunWithStacks } from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import {
  iso,
  notFound,
  paged,
  pageOf,
  pageQuery,
  type RouteDeps,
  readErrors,
  stamps,
  writeErrors,
} from "./shared";

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });

// shortcut: one request names at most 100 stacks; upgrade when a repository really has more than that to plan at once.
const MAX_STACKS = 100;
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
    .max(MAX_STACKS)
    .refine((names) => new Set(names).size === names.length, "a stack is named twice"),
});

/**
 * The runs of a project's IaC stacks (IAC-5): which stacks, on which commit, and where each one is.
 * Creating one only records it, with every stack `queued`; the states move as the pipeline does
 * (IAC-6 on). Starting one takes `run.create`, reading `run.read`.
 */
export const runRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/runs" })
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
              stacks: body.stacks,
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
    );
