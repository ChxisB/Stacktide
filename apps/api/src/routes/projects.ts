import { can, DomainError, PROJECT_TAGS } from "@orch/core";
import {
  createProject,
  deleteProject,
  forgesOfProjects,
  getOrganization,
  getProject,
  listProjects,
  type projects,
  updateProject,
} from "@orch/db";
import { CAPABILITY_FLAGS, capabilitiesOf, type ForgeKind } from "@orch/forge";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import {
  atLeastOne,
  defaultBranch,
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
  stamps,
  taken,
  writeErrors,
} from "./shared";

const detectedType = z.object({
  tag: z.enum(PROJECT_TAGS),
  confidence: z.enum(["high", "medium"]),
  /** Paths in the repository that suggest the tag. */
  evidence: z.array(z.string()),
});

export const projectSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  name: z.string(),
  gitlabProjectId: z.number().int().nullable(),
  defaultBranch: z.string(),
  /** What the repository looks like, as of the last import; empty for a project made by hand. */
  types: z.array(detectedType),
  /** The forge the project is on, and what that forge cannot do, so a screen hides or explains it (FRG-24). */
  forge: z.enum(["gitlab", "github"]),
  capabilities: z.record(z.enum(CAPABILITY_FLAGS), z.boolean()),
  ...stamps,
});
export const projectDto = (
  p: typeof projects.$inferSelect,
  forge: ForgeKind,
): z.infer<typeof projectSchema> => ({
  id: p.id,
  organizationId: p.organizationId,
  name: p.name,
  gitlabProjectId: p.gitlabProjectId,
  defaultBranch: p.defaultBranch,
  types: p.detectedTypes,
  forge,
  capabilities: capabilitiesOf(forge),
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
});

type Listed = readonly [typeof projects.$inferSelect, ForgeKind];
const forgeOf = async (db: RouteDeps["db"], p: { connectionId: string | null }) =>
  (await forgesOfProjects(db, [p]))[0] ?? "gitlab";

const params = z.object({ orgId: z.uuid() });
const itemParams = params.extend({ projectId: z.uuid() });
const gitlabProjectId = gitlabId;
const create = z.strictObject({
  name,
  gitlabProjectId: gitlabProjectId.optional(),
  defaultBranch: defaultBranch.optional(),
});
// `null` unlinks the GitLab project.
const patch = z
  .strictObject({
    name: name.optional(),
    gitlabProjectId: gitlabProjectId.nullable().optional(),
    defaultBranch: defaultBranch.optional(),
  })
  .refine(nonEmpty, atLeastOne);

const known = {
  projects_org_name_key: taken("name_taken", "The name"),
  projects_org_gitlab_project_key: taken("gitlab_project_linked", "The GitLab project"),
  projects_connection_gitlab_project_key: taken("gitlab_project_linked", "The GitLab project"),
};

const audited = (
  action: string,
  p: { id: string; organizationId: string },
  metadata: Record<string, unknown>,
) => ({
  action,
  resourceType: "project",
  resourceId: p.id,
  organizationId: p.organizationId,
  projectId: p.id,
  metadata,
});

export const projectRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/projects" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId }, query }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: ([p]: Listed) => [p.id],
          fetch: async (after, limit) => {
            const rows = await listProjects(db, orgId, { after: after?.[0], limit });
            const forges = await forgesOfProjects(db, rows);
            return rows.map((p, i): Listed => [p, forges[i] ?? "gitlab"]);
          },
          dto: ([p, forge]: Listed) => projectDto(p, forge),
        });
      },
      {
        params,
        query: pageQuery,
        response: { 200: pageOf(projectSchema), ...readErrors },
        guard: "organization.read", // an org reader reads all of its projects
      },
    )
    .get(
      "/:projectId",
      async ({ params: { orgId, projectId } }) => {
        const project = await getProject(db, orgId, projectId);
        if (!project) throw notFound("Project");
        return projectDto(project, await forgeOf(db, project));
      },
      {
        params: itemParams,
        response: { 200: projectSchema, ...readErrors },
        guard: "project.read",
      },
    )
    .post(
      "",
      async ({ params: { orgId }, body, audit, set }) => {
        const project = await db
          .transaction(async (tx) => {
            const project = await createProject(tx, { ...body, organizationId: orgId });
            await audit(tx, audited("project.create", project, { name: project.name }));
            return project;
          })
          .catch(
            mapDbError({
              ...known,
              projects_organization_id_organizations_id_fk: notFound("Organization"),
            }),
          );
        set.status = 201;
        return projectDto(project, "gitlab"); // made by hand, it has no connection
      },
      {
        params,
        body: create,
        parse: "json",
        response: { 201: projectSchema, ...writeErrors },
        audit: "project.create",
        guard: "project.create",
      },
    )
    .patch(
      "/:projectId",
      async ({ params: { orgId, projectId }, body, audit, principal: caller }) => {
        // The link decides which GitLab project the organization's connection token is used on (leases,
        // runs), so re-pointing it is as privileged as creating a project with one: an org admin's.
        if (
          body.gitlabProjectId !== undefined &&
          caller &&
          "subject" in caller &&
          !can(caller.subject, "project.create", { organizationId: orgId })
        ) {
          throw new DomainError("forbidden", 403, "Not allowed: project.create");
        }
        const project = await db
          .transaction(async (tx) => {
            const project = await updateProject(tx, orgId, projectId, body);
            if (!project) throw notFound("Project");
            await audit(tx, audited("project.update", project, { fields: Object.keys(body) }));
            return project;
          })
          .catch(mapDbError(known));
        return projectDto(project, await forgeOf(db, project));
      },
      {
        params: itemParams,
        body: patch,
        parse: "json",
        response: { 200: projectSchema, ...writeErrors },
        audit: "project.update",
        guard: "project.update",
      },
    )
    .delete(
      "/:projectId",
      async ({ params: { orgId, projectId }, audit, set }) => {
        await db
          .transaction(async (tx) => {
            const project = await getProject(tx, orgId, projectId);
            if (!project || !(await deleteProject(tx, orgId, projectId))) throw notFound("Project");
            await audit(tx, audited("project.delete", project, { name: project.name }));
          })
          // Terraform state is not taken down with its project: a CI job deletes it first (ADR-0017).
          .catch(
            mapDbError({
              state_versions_project_fk: new DomainError(
                "project_has_state",
                409,
                "The project holds Terraform state; delete the state first",
              ),
            }),
          );
        set.status = 204;
      },
      {
        params: itemParams,
        response: deleteResponses,
        audit: "project.delete",
        guard: "project.delete",
      },
    );
