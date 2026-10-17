import {
  createEnvironment,
  deleteEnvironment,
  type environments,
  getEnvironment,
  getProject,
  listEnvironments,
  updateEnvironment,
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

const envDto = (e: typeof environments.$inferSelect) => ({
  id: e.id,
  organizationId: e.organizationId,
  projectId: e.projectId,
  name: e.name,
  slug: e.slug,
  sortOrder: e.sortOrder,
  createdAt: iso(e.createdAt),
  updatedAt: iso(e.updatedAt),
});

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });
const itemParams = params.extend({ envId: z.uuid() });
const sortOrder = z.number().int().min(0).max(1_000_000);
const create = z.strictObject({ name, slug, sortOrder: sortOrder.optional() });
// The slug is the environment's identifier (variable scopes refer to it): it cannot change.
const patch = z
  .strictObject({ name: name.optional(), sortOrder: sortOrder.optional() })
  .refine(nonEmpty, atLeastOne);

const audited = (
  action: string,
  e: typeof environments.$inferSelect,
  metadata: Record<string, unknown>,
) => ({
  action,
  resourceType: "environment",
  resourceId: e.id,
  organizationId: e.organizationId,
  projectId: e.projectId,
  metadata: { slug: e.slug, ...metadata },
});

export const environmentRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/environments" })
    .use(auditPlugin(principal))
    .get(
      "/",
      async ({ params: { orgId, projectId }, query }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        return paged(query, {
          key: z.tuple([sortOrder, slug]),
          keyOf: (e): [number, string] => [e.sortOrder, e.slug],
          fetch: (after, limit) => listEnvironments(db, orgId, projectId, { after, limit }),
          dto: envDto,
        });
      },
      { params, query: pageQuery },
    )
    .get(
      "/:envId",
      async ({ params: { orgId, projectId, envId } }) => {
        const env = await getEnvironment(db, orgId, projectId, envId);
        if (!env) throw notFound("Environment");
        return envDto(env);
      },
      { params: itemParams },
    )
    .post(
      "/",
      async ({ params: { orgId, projectId }, body, audit, set }) => {
        const env = await db
          .transaction(async (tx) => {
            const env = await createEnvironment(tx, {
              ...body,
              organizationId: orgId,
              projectId,
            });
            await audit(tx, audited("environment.create", env, { name: env.name }));
            return env;
          })
          .catch(
            mapDbError({
              environments_project_slug_key: taken("slug_taken", "The slug"),
              // The composite key: no such project in this organization.
              environments_project_org_fk: notFound("Project"),
            }),
          );
        set.status = 201;
        return envDto(env);
      },
      { params, body: create, audit: "environment.create" },
    )
    .patch(
      "/:envId",
      ({ params: { orgId, projectId, envId }, body, audit }) =>
        db.transaction(async (tx) => {
          const env = await updateEnvironment(tx, orgId, projectId, envId, body);
          if (!env) throw notFound("Environment");
          await audit(tx, audited("environment.update", env, { fields: Object.keys(body) }));
          return envDto(env);
        }),
      { params: itemParams, body: patch, audit: "environment.update" },
    )
    .delete(
      "/:envId",
      async ({ params: { orgId, projectId, envId }, audit, set }) => {
        await db.transaction(async (tx) => {
          const env = await getEnvironment(tx, orgId, projectId, envId);
          if (!env || !(await deleteEnvironment(tx, orgId, projectId, envId))) {
            throw notFound("Environment");
          }
          await audit(tx, audited("environment.delete", env, { name: env.name }));
        });
        set.status = 204;
      },
      { params: itemParams, audit: "environment.delete" },
    );
