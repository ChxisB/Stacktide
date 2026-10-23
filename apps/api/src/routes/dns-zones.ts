import { DomainError } from "@orch/core";
import {
  createDnsZone,
  type DnsZoneRow,
  deleteDnsZone,
  getOrganization,
  listDnsZones,
} from "@orch/db";
import { MAX_ZONE, NAME, ZONE } from "@orch/iac";
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

const zoneSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  zone: z.string(),
  stack: z.string(),
  ...stamps,
});
const dto = (c: DnsZoneRow): z.infer<typeof zoneSchema> => ({
  id: c.id,
  organizationId: c.organizationId,
  projectId: c.projectId,
  zone: c.zone,
  stack: c.stack,
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
});

// The messages name the field and never repeat what was sent.
const claimBody = z.strictObject({
  zone: z.string().max(MAX_ZONE).regex(ZONE, "not a zone name"),
  projectId: z.uuid(),
  /** The stack in the project's repository whose `dnsconfig.js` manages the zone. */
  stack: z.string().regex(NAME, "not a stack name"),
});

const orgParams = z.object({ orgId: z.uuid() });
const zoneParams = orgParams.extend({ zoneId: z.uuid() });

const audited = (action: string, c: DnsZoneRow) => ({
  action,
  resourceType: "dns_zone",
  resourceId: c.id,
  organizationId: c.organizationId,
  // a zone name, a stack name and a project id: public names and ids, nothing to keep out of the trail
  metadata: { zone: c.zone, projectId: c.projectId, stack: c.stack },
});

/**
 * The DNS zones an organization has handed to a stack (DNS-6). A zone is claimed once per organization, by
 * one project's stack, so a second project cannot take over the records of a zone it was not given. The
 * claim lives with the organization and not in the repository, so a merge request cannot make one (DNS-7
 * checks it before an apply). Anyone in the organization reads the claims; org admins make and release them.
 */
export const dnsZoneRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/dns/zones" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId }, query }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (c: DnsZoneRow) => [c.id],
          fetch: (after, limit) => listDnsZones(db, orgId, { after: after?.[0], limit }),
          dto,
        });
      },
      {
        params: orgParams,
        query: pageQuery,
        response: { 200: pageOf(zoneSchema), ...readErrors },
        guard: "dns.zone.read",
      },
    )
    .post(
      "",
      async ({ params: { orgId }, body, audit, set }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        const row = await db
          .transaction(async (tx) => {
            const row = await createDnsZone(tx, { ...body, organizationId: orgId });
            await audit(tx, audited("dns_zone.create", row));
            return row;
          })
          .catch(
            mapDbError({
              dns_zones_org_zone_key: new DomainError(
                "dns_zone_claimed",
                409,
                "That zone is claimed already",
              ),
              dns_zones_project_org_fk: notFound("Project"),
            }),
          );
        set.status = 201;
        return dto(row);
      },
      {
        params: orgParams,
        body: claimBody,
        parse: "json",
        response: { 201: zoneSchema, ...writeErrors },
        audit: "dns_zone.create",
        guard: "dns.zone.create",
      },
    )
    .delete(
      "/:zoneId",
      async ({ params: { orgId, zoneId }, audit, set }) => {
        await db.transaction(async (tx) => {
          const gone = await deleteDnsZone(tx, orgId, zoneId);
          if (!gone) throw notFound("DNS zone");
          await audit(tx, audited("dns_zone.delete", gone));
        });
        set.status = 204;
      },
      {
        params: zoneParams,
        response: deleteResponses,
        audit: "dns_zone.delete",
        guard: "dns.zone.delete",
      },
    );
