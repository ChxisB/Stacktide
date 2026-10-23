import {
  type ApplyKind,
  type ApplySubject,
  CHANGE_REQUEST_KINDS,
  CHANGE_REQUEST_MAX_OPEN,
  CHANGE_REQUEST_STATUSES,
  CHANGE_REQUEST_TTL_DAYS,
  type DiffEntry,
  DomainError,
  type Logger,
} from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  approveChangeRequest,
  type ChangeRequest,
  createApplyRequest,
  createChangeRequest,
  createDeployRequest,
  getChangeRequest,
  getEnvironment,
  getRun,
  getSyncRun,
  getSyncTarget,
  listChangeRequests,
  MAX_RUN_STACKS,
  rejectChangeRequest,
} from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { guardPlugin, unauthenticated } from "../guard";
import { type Principal, personOf } from "../principal";
import { assertKnownBuild, assertSha } from "../promotion";
import {
  iso,
  mapDbError,
  notFound,
  paged,
  pageOf,
  pageQuery,
  problemSchema,
  type RouteDeps,
  readErrors,
  stamps,
  writeErrors,
} from "./shared";
import { bulkEvents, bulkOps, failing, foldersNamed } from "./variables";

const person = z.object({ kind: z.string(), id: z.string() });
const requestSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  environmentId: z.uuid(),
  kind: z.enum(CHANGE_REQUEST_KINDS),
  status: z.enum(CHANGE_REQUEST_STATUSES),
  /** What it would do, by key name: never a value. */
  diff: z.array(
    z.object({
      action: z.enum(["set", "rename", "delete", "apply"]),
      key: z.string(),
      /** Where the variable is; left out at the root. */
      folder: z.string().optional(),
      kind: z.string().optional(),
      to: z.string().optional(),
    }),
  ),
  /** What an approval to apply is for: the run, and its target or its stacks at their plan jobs; for a deploy, the commit. */
  subject: z
    .object({
      runId: z.uuid().optional(),
      targetId: z.uuid().optional(),
      stacks: z.record(z.string(), z.number().int()).optional(),
      sha: z.string().optional(),
    })
    .nullable(),
  author: person,
  decidedBy: person.nullable(),
  decidedAt: z.iso.datetime().nullable(),
  appliedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  ...stamps,
});
const requestDto = (r: ChangeRequest): z.infer<typeof requestSchema> => ({
  id: r.id,
  organizationId: r.organizationId,
  projectId: r.projectId,
  environmentId: r.environmentId,
  kind: z.enum(CHANGE_REQUEST_KINDS).parse(r.kind),
  status: z.enum(CHANGE_REQUEST_STATUSES).parse(r.status),
  diff: r.diff,
  subject: r.subjectId ? { runId: r.subjectId, ...r.subject } : r.subject,
  author: { kind: r.authorKind, id: r.authorId },
  decidedBy: r.decidedById && r.decidedByKind ? { kind: r.decidedByKind, id: r.decidedById } : null,
  decidedAt: r.decidedAt ? iso(r.decidedAt) : null,
  appliedAt: r.appliedAt ? iso(r.appliedAt) : null,
  expiresAt: iso(r.expiresAt),
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const params = z.object({ orgId: z.uuid(), projectId: z.uuid(), envId: z.uuid() });
const itemParams = params.extend({ crId: z.uuid() });
const listQuery = pageQuery.extend({ status: z.enum(CHANGE_REQUEST_STATUSES).optional() });
const edits = z.strictObject({ ops: bulkOps });
const syncAsk = z.strictObject({
  kind: z.literal("sync_apply"),
  targetId: z.uuid(),
  planId: z.uuid(),
});
const iacAsk = z.strictObject({
  kind: z.literal("iac_apply"),
  runId: z.uuid(),
  /** Names of stacks of the run; the stacks that are planned when left out. */
  stacks: z
    .array(z.string().min(1).max(63))
    .min(1)
    .max(MAX_RUN_STACKS)
    .refine((names) => new Set(names).size === names.length, "a stack is named twice")
    .optional(),
});
const deployAsk = z.strictObject({ kind: z.literal("deploy"), sha: z.string().max(255) });
const create = z.union([edits, syncAsk, iacAsk, deployAsk]);
const unavailable = { ...writeErrors, 500: problemSchema, 503: problemSchema } as const;

type Params = z.infer<typeof params>;
const atOf = (p: Params) => ({
  organizationId: p.orgId,
  projectId: p.projectId,
  environmentId: p.envId,
});

const audited = (action: string, p: Params, crId: string, metadata: Record<string, unknown>) => ({
  action,
  resourceType: "change_request",
  resourceId: crId,
  organizationId: p.orgId,
  projectId: p.projectId,
  metadata: { environmentId: p.envId, ...metadata },
});

const closed = (status: string) =>
  new DomainError("change_request_closed", 409, `This change request is already ${status}`);
const conflict = (code: string, message: string) => new DomainError(code, 409, message);

/**
 * Changes to the variables of an environment that wait for a second person (GOV-2). Anyone who
 * may develop in the project proposes; a maintainer other than the author approves, which applies
 * the changes as them in the same transaction, or rejects. The request holds its values sealed and
 * shows only key names and actions: reading one, listing them or the audit trail never shows a value.
 *
 * The same requests carry leave to apply a sync plan or the stacks of an IaC run that a protected
 * environment guards (GOV-3). Approving one applies nothing: it stays approved until the apply, by
 * plan id as ever, uses it up. So does leave to deploy a commit to a protected environment (DEP-16).
 */
export const changeRequestRoutes = ({
  db,
  principal,
  keys,
  logger,
}: RouteDeps & { keys?: KeyProvider; logger: Logger }) => {
  const sealing = () => {
    if (!keys) throw noKeys();
    return keys;
  };
  const failingWith = failing(logger);
  // asked where the approvers will look: the environment that guards the apply
  const guarding = (env: { protected: boolean }) => {
    if (!env.protected) {
      throw conflict(
        "environment_not_protected",
        "A request to apply is made in a protected environment",
      );
    }
  };
  /** What a request to deploy is for: a build that exists, into the environment it is made in. */
  const deploying = async (
    p: Params,
    env: { slug: string; protected: boolean },
    body: z.infer<typeof deployAsk>,
  ) => {
    guarding(env);
    assertSha(body.sha);
    await assertKnownBuild(db, { id: p.projectId, organizationId: p.orgId }, body.sha);
    return { sha: body.sha, diff: [{ action: "apply", key: env.slug }] satisfies DiffEntry[] };
  };
  /** What a request to apply is for and what its approver is shown. It must name a plan that could still be applied. */
  const applying = async (
    p: Params,
    env: { slug: string; protected: boolean },
    body: z.infer<typeof syncAsk> | z.infer<typeof iacAsk>,
  ): Promise<{ kind: ApplyKind; subject: ApplySubject; diff: DiffEntry[] }> => {
    guarding(env);
    if (body.kind === "sync_apply") {
      const target = await getSyncTarget(db, p.orgId, p.projectId, body.targetId);
      if (!target) throw notFound("Sync target");
      if (!Object.hasOwn(target.environmentMapping, env.slug)) {
        throw conflict("target_not_mapped", "This target does not map this environment");
      }
      const run = await getSyncRun(db, p.orgId, p.projectId, target.id, body.planId);
      if (!run) throw notFound("Plan");
      if (run.status !== "planned") {
        throw conflict("plan_not_applicable", "This plan was already applied or is being applied");
      }
      if (run.expiresAt.getTime() <= Date.now()) {
        throw conflict("plan_expired", "This plan has expired: plan again");
      }
      return {
        kind: "sync_apply",
        subject: { runId: run.id, targetId: target.id },
        diff: [{ action: "apply", key: target.name }],
      };
    }
    const run = await getRun(db, p.orgId, p.projectId, body.runId);
    if (!run) throw notFound("Run");
    if (run.kind === "drift")
      throw conflict("drift_run", "A drift check only plans: it is never applied");
    const byName = new Map(run.stacks.map((s) => [s.stack, s]));
    const names =
      body.stacks ?? run.stacks.filter((s) => s.status === "planned").map((s) => s.stack);
    const stacks: Record<string, number> = {};
    for (const name of [...new Set(names)].sort()) {
      const s = byName.get(name);
      if (!s) {
        throw new DomainError(
          "unknown_stack",
          422,
          `This run has no stack named ${JSON.stringify(name)}`,
        );
      }
      if (s.status !== "planned" || s.planJobId === null) {
        throw conflict("not_planned", `Stack ${JSON.stringify(name)} is not planned`);
      }
      stacks[name] = s.planJobId;
    }
    const named = Object.keys(stacks);
    if (named.length === 0) throw conflict("not_planned", "No stack of this run is planned");
    return {
      kind: "iac_apply",
      subject: { runId: run.id, stacks },
      diff: named.map((key) => ({ action: "apply", key })),
    };
  };
  const who = (caller: Principal | undefined) => {
    if (!caller) throw unauthenticated();
    return personOf(caller);
  };
  return new Elysia({
    prefix: "/organizations/:orgId/projects/:projectId/environments/:envId/change-requests",
  })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: p, query }) => {
        if (!(await getEnvironment(db, p.orgId, p.projectId, p.envId))) {
          throw notFound("Environment");
        }
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (r: ChangeRequest): [string] => [r.id],
          fetch: (after, limit) =>
            listChangeRequests(db, atOf(p), { status: query.status }, { after, limit }),
          dto: requestDto,
        });
      },
      {
        params,
        query: listQuery,
        response: { 200: pageOf(requestSchema), ...readErrors },
        guard: "change_request.read",
      },
    )
    .get(
      "/:crId",
      async ({ params: p }) => {
        const found = await getChangeRequest(db, atOf(p), p.crId);
        if (!found) throw notFound("Change request");
        return requestDto(found);
      },
      {
        params: itemParams,
        response: { 200: requestSchema, ...readErrors },
        guard: "change_request.read",
      },
    )
    .post(
      "",
      async ({ params: p, body, audit, set, principal: caller }) => {
        const k = "ops" in body ? sealing() : undefined;
        const author = who(caller);
        const env = await getEnvironment(db, p.orgId, p.projectId, p.envId);
        if (!env) throw notFound("Environment");
        if ("ops" in body) await foldersNamed(db, p.projectId, body.ops);
        const deploy =
          "ops" in body || body.kind !== "deploy" ? undefined : await deploying(p, env, body);
        const ask =
          "ops" in body || body.kind === "deploy" ? undefined : await applying(p, env, body);
        const expiresAt = new Date(Date.now() + CHANGE_REQUEST_TTL_DAYS * 86_400_000);
        const made = await db
          .transaction(async (tx) => {
            // shortcut: counted without a lock, so concurrent proposals can pass the limit by a few; a hard cap needs the environment row locked
            const open = await listChangeRequests(
              tx,
              atOf(p),
              { status: "open" },
              { limit: CHANGE_REQUEST_MAX_OPEN },
            );
            if (open.length >= CHANGE_REQUEST_MAX_OPEN) {
              throw new DomainError(
                "too_many_change_requests",
                409,
                `This environment already has ${CHANGE_REQUEST_MAX_OPEN} open change requests: decide some first`,
              );
            }
            if (deploy) {
              const r = await createDeployRequest(tx, { ...atOf(p), ...deploy, author, expiresAt });
              await audit(
                tx,
                audited("change_request.create", p, r.id, {
                  kind: "deploy",
                  count: deploy.diff.length,
                  sha: deploy.sha,
                }),
              );
              return r;
            }
            if (ask) {
              const r = await createApplyRequest(tx, { ...atOf(p), ...ask, author, expiresAt });
              await audit(
                tx,
                audited("change_request.create", p, r.id, {
                  kind: ask.kind,
                  count: ask.diff.length,
                  runId: ask.subject.runId,
                }),
              );
              return r;
            }
            if (!k || !("ops" in body)) throw new Error("a request for edits has edits and keys");
            const r = await createChangeRequest(tx, k, {
              ...atOf(p),
              ops: body.ops,
              author,
              expiresAt,
            });
            await audit(tx, audited("change_request.create", p, r.id, { count: body.ops.length }));
            return r;
          })
          .catch(
            mapDbError({
              // the environment went between the check and the write
              change_requests_environment_project_fk: notFound("Environment"),
            }),
          )
          .catch(failingWith(set));
        set.status = 201;
        return requestDto(made);
      },
      {
        params,
        body: create,
        parse: "json",
        response: { 201: requestSchema, ...unavailable },
        audit: "change_request.create",
        guard: "change_request.create",
      },
    )
    .post(
      "/:crId/approve",
      async ({ params: p, audit, set, principal: caller }) => {
        const found = await getChangeRequest(db, atOf(p), p.crId);
        if (!found) throw notFound("Change request");
        // only edits were sealed with the keys: approving a leave to apply opens nothing
        const k = found.kind === "variables" ? sealing() : undefined;
        const approver = who(caller);
        const out = await db
          .transaction(async (tx) => {
            const r = await approveChangeRequest(tx, k, atOf(p), p.crId, approver);
            if (r.result === "approved") {
              await audit(
                tx,
                audited("change_request.approve", p, p.crId, {
                  authorKind: r.request.authorKind,
                  authorId: r.request.authorId,
                  kind: r.request.kind,
                  count: r.request.diff.length,
                }),
              );
              return r;
            }
            if (r.result !== "applied") return r;
            const by = { authorKind: r.request.authorKind, authorId: r.request.authorId };
            const done = r.changes.filter((c) => c.applied).length;
            await audit(
              tx,
              audited("change_request.approve", p, p.crId, {
                ...by,
                count: r.changes.length,
                appliedCount: done,
              }),
            );
            const from = { source: "change_request", changeRequestId: p.crId, ...by };
            for (const event of bulkEvents("environment", r.changes, from)) {
              await audit(tx, event);
            }
            return r;
          })
          .catch(failingWith(set));
        switch (out.result) {
          case "not_found":
            throw notFound("Change request");
          case "closed":
            throw closed(out.status);
          case "expired":
            throw new DomainError(
              "change_request_expired",
              409,
              "This change request has expired: propose it again",
            );
          case "self":
            throw new DomainError(
              "self_approval",
              403,
              "You cannot approve your own change request",
            );
          case "conflict":
            throw new DomainError(
              "change_conflict",
              409,
              `The variables have changed since this was proposed: reject it and propose it again (${out.keys.slice(0, 10).join(", ")})`,
            );
          case "applied":
          case "approved":
            return requestDto(out.request);
        }
      },
      {
        params: itemParams,
        response: { 200: requestSchema, ...unavailable, 403: problemSchema },
        audit: ["change_request.approve", "variable.create", "variable.update", "variable.delete"],
        guard: "change_request.approve",
      },
    )
    .post(
      "/:crId/reject",
      async ({ params: p, audit, principal: caller }) => {
        const decider = who(caller);
        const out = await db.transaction(async (tx) => {
          const r = await rejectChangeRequest(tx, atOf(p), p.crId, decider);
          if (r?.result === "rejected") {
            await audit(
              tx,
              audited("change_request.reject", p, p.crId, {
                authorKind: r.request.authorKind,
                authorId: r.request.authorId,
              }),
            );
          }
          return r;
        });
        if (!out) throw notFound("Change request");
        if (out.result === "closed") throw closed(out.status);
        return requestDto(out.request);
      },
      {
        params: itemParams,
        response: { 200: requestSchema, ...writeErrors },
        audit: "change_request.reject",
        guard: "change_request.reject",
      },
    );
};
