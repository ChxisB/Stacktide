import { DomainError, visibleOrganizations } from "@orch/core";
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
import { guardPlugin } from "../guard";
import {
  atLeastOne,
  deleteResponses,
  gitlabId,
  iso,
  mapDbError,
  name,
  nonEmpty,
  notFound,
  paged,
  pageOf,
  pageQuery,
  type RouteDeps,
  readErrors,
  slug,
  stamps,
  taken,
  writeErrors,
} from "./shared";

const orgSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  gitlabGroupId: z.number().int().nullable(),
  ...stamps,
});
const orgDto = (o: typeof organizations.$inferSelect): z.infer<typeof orgSchema> => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  gitlabGroupId: o.gitlabGroupId,
  createdAt: iso(o.createdAt),
  updatedAt: iso(o.updatedAt),
});

const params = z.object({ orgId: z.uuid() });
// The GitLab group's members hold this organization's roles (AUTH-5). Like the slug it cannot change:
// whoever could relink it to a group they control would make themselves its owner.
const create = z.strictObject({ slug, name, gitlabGroupId: gitlabId.optional() });
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
    .use(guardPlugin)
    .get(
      "",
      ({ query, principal }) => {
        // Only the organizations the caller holds a role in (the dev principal sees all).
        const only =
          principal?.kind === "dev" ? undefined : visibleOrganizations(principal?.subject);
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (o) => [o.id],
          fetch: (after, limit) => listOrganizations(db, { after: after?.[0], limit }, only),
          dto: orgDto,
        });
      },
      {
        query: pageQuery,
        response: { 200: pageOf(orgSchema), ...readErrors },
        signedIn: "lists only the organizations the caller holds a role in",
      },
    )
    .get(
      "/:orgId",
      async ({ params: { orgId } }) => {
        const org = await getOrganization(db, orgId);
        if (!org) throw notFound("Organization");
        return orgDto(org);
      },
      { params, response: { 200: orgSchema, ...readErrors }, guard: "organization.read" },
    )
    .post(
      "",
      async ({ body, audit, set }) => {
        const org = await db
          .transaction(async (tx) => {
            const org = await createOrganization(tx, body);
            await audit(
              tx,
              audited("organization.create", org, {
                name: org.name,
                gitlabGroupId: org.gitlabGroupId,
              }),
            );
            return org;
          })
          .catch(
            mapDbError({
              organizations_slug_key: taken("slug_taken", "The slug"),
              organizations_gitlab_group_key: taken("gitlab_group_linked", "The GitLab group"),
            }),
          );
        set.status = 201;
        return orgDto(org);
      },
      {
        body: create,
        parse: "json",
        response: { 201: orgSchema, ...writeErrors },
        audit: "organization.create",
        guard: "organization.create",
      },
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
      {
        params,
        body: patch,
        parse: "json",
        response: { 200: orgSchema, ...writeErrors },
        audit: "organization.update",
        guard: "organization.update",
      },
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
      {
        params,
        response: deleteResponses,
        audit: "organization.delete",
        guard: "organization.delete",
      },
    );
