import { DomainError } from "@orch/core";
import {
  type CostLimitRow,
  deleteCostLimit,
  getOrganization,
  listCostLimits,
  MAX_COST_LIMITS,
  setCostLimit,
} from "@orch/db";
import { TAG } from "@orch/iac";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import {
  deleteResponses,
  iso,
  mapDbError,
  notFound,
  paged,
  pageOf,
  pageQuery,
  type RouteDeps,
  readErrors,
  stamps,
  writeErrors,
} from "./shared";

const MAX_AMOUNT = 1e12;

const limitSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  tag: z.string().nullable(),
  maxMonthlyDelta: z.number(),
  warnAt: z.number().nullable(),
  currency: z.string(),
  ...stamps,
});
const dto = (l: CostLimitRow): z.infer<typeof limitSchema> => ({
  id: l.id,
  organizationId: l.organizationId,
  tag: l.tag,
  maxMonthlyDelta: l.maxMonthlyDelta,
  warnAt: l.warnAt,
  currency: l.currency,
  createdAt: iso(l.createdAt),
  updatedAt: iso(l.updatedAt),
});

// The messages name the field and never repeat what was sent.
const setBody = z
  .strictObject({
    /** The stack tag the limit is for; none (or null) is the organization's own limit for every stack. */
    tag: z.string().regex(TAG, "not a usable stack tag").nullish(),
    /** What one plan may add to the monthly cost, in `currency`. Zero allows no increase. */
    maxMonthlyDelta: z.number().min(0).max(MAX_AMOUNT),
    /** From this much on, a plan is warned about, not denied. None: no warning. */
    warnAt: z.number().min(0).max(MAX_AMOUNT).nullish(),
    /** A 3-letter code. It is never converted: an estimate in another currency is denied. */
    currency: z.string().regex(/^[A-Z]{3}$/, "not a currency code"),
  })
  .refine((b) => b.warnAt == null || b.warnAt <= b.maxMonthlyDelta, {
    path: ["warnAt"],
    message: "is above the maximum",
  });

const orgParams = z.object({ orgId: z.uuid() });
const limitParams = orgParams.extend({ limitId: z.uuid() });

const figures = (l: CostLimitRow) => ({
  tag: l.tag,
  maxMonthlyDelta: l.maxMonthlyDelta,
  warnAt: l.warnAt,
  currency: l.currency,
});
const audited = (action: string, l: CostLimitRow, extra: object = {}) => ({
  action,
  resourceType: "cost_limit",
  resourceId: l.id,
  organizationId: l.organizationId,
  // numbers, a currency code and a tag: nothing in them to keep out of the trail
  metadata: { ...figures(l), ...extra },
});

/**
 * An organization's cost limits (COST-2): what one plan may add to the monthly cost, for the whole
 * organization or for the stacks with a tag (the strictest limit of a stack's tags wins, see
 * `limitFor` in core). They live with the organization and not in a stack's repository, so a merge
 * request cannot raise one. Anyone in the organization reads them; org admins set and remove them.
 */
export const costLimitRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/cost-limits" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId }, query }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (l: CostLimitRow) => [l.id],
          fetch: (after, limit) => listCostLimits(db, orgId, { after: after?.[0], limit }),
          dto,
        });
      },
      {
        params: orgParams,
        query: pageQuery,
        response: { 200: pageOf(limitSchema), ...readErrors },
        guard: "cost.limit.read",
      },
    )
    // PUT: the scope is the identity, so setting it again replaces it (200) and the first time makes it (201)
    .put(
      "",
      async ({ params: { orgId }, body, audit, set }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        const done = await db
          .transaction(async (tx) => {
            const done = await setCostLimit(tx, {
              organizationId: orgId,
              tag: body.tag ?? null,
              maxMonthlyDelta: body.maxMonthlyDelta,
              warnAt: body.warnAt ?? null,
              currency: body.currency,
            });
            if (!done) {
              throw new DomainError(
                "too_many_cost_limits",
                409,
                `An organization has at most ${MAX_COST_LIMITS} cost limits`,
              );
            }
            await audit(
              tx,
              audited("cost.limit.set", done.row, {
                previous: done.previous ? figures(done.previous) : null,
              }),
            );
            return done;
          })
          .catch(
            mapDbError({
              cost_limits_organization_id_organizations_id_fk: notFound("Organization"),
            }),
          );
        set.status = done.previous ? 200 : 201;
        return dto(done.row);
      },
      {
        params: orgParams,
        body: setBody,
        parse: "json",
        response: { 200: limitSchema, 201: limitSchema, ...writeErrors },
        audit: "cost.limit.set",
        guard: "cost.limit.set",
      },
    )
    .delete(
      "/:limitId",
      async ({ params: { orgId, limitId }, audit, set }) => {
        await db.transaction(async (tx) => {
          const gone = await deleteCostLimit(tx, orgId, limitId);
          if (!gone) throw notFound("Cost limit");
          await audit(tx, audited("cost.limit.delete", gone));
        });
        set.status = 204;
      },
      {
        params: limitParams,
        response: deleteResponses,
        audit: "cost.limit.delete",
        guard: "cost.limit.delete",
      },
    );
