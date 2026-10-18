import {
  CHANGE_REQUEST_KINDS,
  CHANGE_REQUEST_MAX_OPEN,
  CHANGE_REQUEST_STATUSES,
  CHANGE_REQUEST_TTL_DAYS,
  DomainError,
  type Logger,
} from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  approveChangeRequest,
  type ChangeRequest,
  createChangeRequest,
  getChangeRequest,
  getEnvironment,
  listChangeRequests,
  rejectChangeRequest,
} from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { guardPlugin, unauthenticated } from "../guard";
import { type Principal, personOf } from "../principal";
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
import { bulkEvents, bulkOps, failing } from "./variables";

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
      action: z.enum(["set", "rename", "delete"]),
      key: z.string(),
      kind: z.string().optional(),
      to: z.string().optional(),
    }),
  ),
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
const create = z.strictObject({ ops: bulkOps });
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

/**
 * Changes to the variables of an environment that wait for a second person (GOV-2). Anyone who
 * may develop in the project proposes; a maintainer other than the author approves, which applies
 * the changes as them in the same transaction, or rejects. The request holds its values sealed and
 * shows only key names and actions: reading one, listing them or the audit trail never shows a value.
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
        const k = sealing();
        const author = who(caller);
        if (!(await getEnvironment(db, p.orgId, p.projectId, p.envId))) {
          throw notFound("Environment");
        }
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
        const k = sealing();
        const approver = who(caller);
        const out = await db
          .transaction(async (tx) => {
            const r = await approveChangeRequest(tx, k, atOf(p), p.crId, approver);
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
