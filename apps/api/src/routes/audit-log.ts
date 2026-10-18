import { AUDIT_RETENTION_MAX_DAYS, AUDIT_RETENTION_MIN_DAYS } from "@orch/core";
import {
  type AuditFilter,
  type AuditRow,
  getAuditRetention,
  getOrganization,
  listAuditEvents,
  setAuditRetention,
} from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { auditCsv, auditFields } from "../audit-export";
import { guardPlugin } from "../guard";
import {
  decodeCursor,
  encodeCursor,
  notFound,
  paged,
  pageOf,
  pageQuery,
  type RouteDeps,
  readErrors,
  writeErrors,
} from "./shared";

const short = z.string().min(1).max(200);
/** An action, or a prefix of actions: `variable.*`. */
const actionFilter = z
  .string()
  .max(100)
  .regex(
    /^[a-z0-9_]+(\.[a-z0-9_]+)*(\.\*)?$/,
    "an action like `variable.create`, or a prefix like `variable.*`",
  );

const filterQuery = z.object({
  action: actionFilter.optional(),
  actorKind: short.optional(),
  actorId: short.optional(),
  resourceType: short.optional(),
  resourceId: short.optional(),
  projectId: z.uuid().optional(),
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
});
type FilterQuery = z.infer<typeof filterQuery>;

const filterOf = (organizationId: string, q: FilterQuery): AuditFilter => ({
  organizationId,
  action: q.action,
  actorKind: q.actorKind,
  actorId: q.actorId,
  resourceType: q.resourceType,
  resourceId: q.resourceId,
  projectId: q.projectId,
  since: q.since === undefined ? undefined : new Date(q.since),
  until: q.until === undefined ? undefined : new Date(q.until),
});

const eventSchema = z.object({
  id: z.uuid(),
  at: z.iso.datetime(),
  actorKind: z.string(),
  actorId: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  organizationId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  requestId: z.string().nullable(),
  ip: z.string().nullable(),
  /** Ids, key names and counts: `audit()` refuses a value on the way in. */
  metadata: z.record(z.string(), z.unknown()),
});

const orgParams = z.object({ orgId: z.uuid() });

/** Rows an export holds at most: a larger log is fetched by following `x-next-cursor`. */
export const EXPORT_MAX = 5000;
const exportQuery = filterQuery.extend({
  format: z.enum(["json", "csv"]).default("json"),
  limit: z.coerce.number().int().min(1).max(EXPORT_MAX).default(1000),
  cursor: z.string().max(300).optional(),
});

const retentionSchema = z.object({ days: z.number().int().nullable() });
const retentionBody = z.strictObject({
  /** null keeps the events for ever. */
  days: z.number().int().min(AUDIT_RETENTION_MIN_DAYS).max(AUDIT_RETENTION_MAX_DAYS).nullable(),
});

const cursorKey = z.tuple([z.uuid()]);
const FILTERS = [
  "action",
  "actorKind",
  "actorId",
  "resourceType",
  "resourceId",
  "projectId",
  "since",
  "until",
] as const;
/** What the audit row of an export says it was asked for. */
const filterFacts = (q: FilterQuery) =>
  Object.fromEntries(FILTERS.flatMap((k) => (q[k] === undefined ? [] : [[k, q[k]]])));

/**
 * The organization's audit log (GOV-1): a filtered, cursor-paged list, an export of the same
 * (itself audited, with the filters it was asked for and how many rows went out), and how long the
 * events are kept. Org admins read and export; only an owner sets the retention. An event holds ids,
 * key names and counts, so no answer here carries a value.
 */
export const auditLogRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "/audit-events",
      async ({ params: { orgId }, query }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        return paged(query, {
          key: cursorKey,
          keyOf: (r: AuditRow): [string] => [r.id],
          fetch: (after, limit) =>
            listAuditEvents(db, filterOf(orgId, query), { after: after?.[0], limit }),
          dto: auditFields,
        });
      },
      {
        params: orgParams,
        query: pageQuery.extend(filterQuery.shape),
        response: { 200: pageOf(eventSchema), ...readErrors },
        guard: "audit.read",
      },
    )
    .get(
      "/audit-events/export",
      async ({ params: { orgId }, query, audit }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        const after =
          query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorKey)[0];
        // Read and audited in one transaction: the export is recorded exactly when the rows were read.
        const rows = await db.transaction(async (tx) => {
          const found = await listAuditEvents(tx, filterOf(orgId, query), {
            after,
            limit: query.limit + 1,
          });
          const page = found.slice(0, query.limit);
          await audit(tx, {
            action: "audit.export",
            resourceType: "audit_log",
            resourceId: orgId,
            organizationId: orgId,
            metadata: {
              format: query.format,
              count: page.length,
              ...filterFacts(query),
            },
          });
          return { page, more: found.length > query.limit };
        });
        const last = rows.page.at(-1);
        const next = rows.more && last ? encodeCursor([last.id]) : null;
        const headers = new Headers({
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="audit-events.${query.format}"`,
        });
        if (next) headers.set("x-next-cursor", next);
        if (query.format === "csv") {
          headers.set("content-type", "text/csv; charset=utf-8");
          return new Response(auditCsv(rows.page), { headers });
        }
        headers.set("content-type", "application/json");
        return new Response(
          JSON.stringify({ items: rows.page.map(auditFields), nextCursor: next }),
          {
            headers,
          },
        );
      },
      {
        params: orgParams,
        query: exportQuery,
        response: { 200: z.string(), ...readErrors },
        audit: "audit.export",
        guard: "audit.export",
      },
    )
    .get(
      "/audit-retention",
      async ({ params: { orgId } }) => {
        const days = await getAuditRetention(db, orgId);
        if (days === undefined) throw notFound("Organization");
        return { days };
      },
      {
        params: orgParams,
        response: { 200: retentionSchema, ...readErrors },
        guard: "audit.retention.read",
      },
    )
    .put(
      "/audit-retention",
      async ({ params: { orgId }, body, audit }) => {
        await db.transaction(async (tx) => {
          const was = await setAuditRetention(tx, orgId, body.days);
          if (!was) throw notFound("Organization");
          await audit(tx, {
            action: "audit.retention.update",
            resourceType: "organization",
            resourceId: orgId,
            organizationId: orgId,
            metadata: { days: body.days, previousDays: was.previous },
          });
        });
        return { days: body.days };
      },
      {
        params: orgParams,
        body: retentionBody,
        parse: "json",
        response: { 200: retentionSchema, ...writeErrors },
        audit: "audit.retention.update",
        guard: "audit.retention.update",
      },
    );
