import { DomainError } from "@orch/core";
import {
  createOrganization,
  deleteOrganization,
  getOrganization,
  listOrganizations,
  type organizations,
  pgCode,
  updateOrganization,
} from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import {
  atLeastOne,
  iso,
  mapDbError,
  name,
  nonEmpty,
  notFound,
  paged,
  pageQuery,
  type RouteDeps,
  slug,
  taken,
} from "./shared";

const orgDto = (o: typeof organizations.$inferSelect) => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  createdAt: iso(o.createdAt),
  updatedAt: iso(o.updatedAt),
});

const params = z.object({ orgId: z.uuid() });
const create = z.strictObject({ slug, name });
// The slug is the organization's identifier in other systems: it cannot change.
const patch = z.strictObject({ name: name.optional() }).refine(nonEmpty, atLeastOne);

const audited = (
  action: string,
  o: { id: string; slug: string },
  metadata: Record<string, unknown> = {},
) => ({
  action,
  resourceType: "organization",
  resourceId: o.id,
  organizationId: o.id,
  metadata: { slug: o.slug, ...metadata },
});

export const organizationRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations" })
    .use(auditPlugin(principal))
    .get(
      "/",
      ({ query }) =>
        paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (o) => [o.id],
          fetch: (after, limit) => listOrganizations(db, { after: after?.[0], limit }),
          dto: orgDto,
        }),
      { query: pageQuery },
    )
    .get(
      "/:orgId",
      async ({ params: { orgId } }) => {
        const org = await getOrganization(db, orgId);
        if (!org) throw notFound("Organization");
        return orgDto(org);
      },
      { params },
    )
    .post(
      "/",
      async ({ body, audit, set }) => {
        const org = await db
          .transaction(async (tx) => {
            const org = await createOrganization(tx, body);
            await audit(tx, audited("organization.create", org, { name: org.name }));
            return org;
          })
          .catch(mapDbError({ organizations_slug_key: taken("slug_taken", "The slug") }));
        set.status = 201;
        return orgDto(org);
      },
      { body: create, audit: "organization.create" },
    )
    .patch(
      "/:orgId",
      ({ params: { orgId }, body, audit }) =>
        db.transaction(async (tx) => {
          const org = await updateOrganization(tx, orgId, body);
          if (!org) throw notFound("Organization");
          await audit(tx, audited("organization.update", org, { fields: Object.keys(body) }));
          return orgDto(org);
        }),
      { params, body: patch, audit: "organization.update" },
    )
    .delete(
      "/:orgId",
      async ({ params: { orgId }, audit, set }) => {
        await db
          .transaction(async (tx) => {
            const org = await getOrganization(tx, orgId);
            if (!org || !(await deleteOrganization(tx, orgId))) throw notFound("Organization");
            await audit(tx, audited("organization.delete", org, { name: org.name }));
          })
          .catch((e) => {
            // RESTRICT: projects still reference it. Deleting them first is a deliberate act.
            if (pgCode(e) === "23001") {
              throw new DomainError(
                "organization_not_empty",
                409,
                "The organization still has projects",
              );
            }
            throw e;
          });
        set.status = 204;
      },
      { params, audit: "organization.delete" },
    );
