import type { Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { getPipelineConfig, getProject, type PipelineConfig, savePipelineConfig } from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import { loadTemplates, recommend, type Template } from "@orch/pipelines";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { openGitlabConnection } from "../connections";
import { guardPlugin } from "../guard";
import { applyPipeline, type PipelineDeps, previewPipeline } from "../pipeline-apply";
import { iso, notFound, type RouteDeps, readErrors, slug, stamps, writeErrors } from "./shared";

const configSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  /** The connection that reached the project when this was applied. */
  connectionId: z.uuid(),
  template: z.string(),
  version: z.string(),
  params: z.record(z.string(), z.unknown()),
  overrides: z.record(z.string(), z.unknown()),
  /** SHA-256 of the file as committed. */
  renderedHash: z.string(),
  /** The merge request that carries the file; null while the default branch already has it. */
  mrIid: z.number().int().nullable(),
  mrUrl: z.string().nullable(),
  ...stamps,
});
const configDto = (c: PipelineConfig): z.infer<typeof configSchema> => ({
  id: c.id,
  organizationId: c.organizationId,
  projectId: c.projectId,
  connectionId: c.connectionId,
  template: c.template,
  version: c.version,
  params: c.params,
  overrides: c.overrides,
  renderedHash: c.renderedHash,
  mrIid: c.mrIid,
  mrUrl: c.mrUrl,
  createdAt: iso(c.createdAt),
  updatedAt: iso(c.updatedAt),
});

const validationSchema = z.object({
  /** False for lint errors or a missing variable; warnings alone leave it true. */
  ok: z.boolean(),
  lint: z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  /** Variables the template requires that are not set, per environment (`null`: the project). */
  missingVariables: z.array(
    z.object({ environment: z.string().nullable(), keys: z.array(z.string()) }),
  ),
});
const existingSchema = z.enum(["none", "identical", "generated", "hand-written"]);

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });
/** Names and values the template's own schema checks; here only the shape and a size. */
const request = z.strictObject({
  /** The GitLab connection of the organization that reaches the project. */
  connectionId: z.uuid(),
  template: z.string().min(1).max(100),
  version: z.string().min(1).max(50).optional(),
  params: z.record(z.string().max(100), z.unknown()).optional(),
  overrides: z.record(z.string().max(100), z.json()).optional(),
  environments: z.array(slug).max(50).optional(),
});
const sealed = { 500: z.any(), 502: z.any(), 503: z.any() } as const;

/**
 * A project's CI pipeline from the catalog (PIPE-6). Reading what it was last set up with and what
 * suits it needs only `pipeline.read`. Previewing and applying reach GitLab with the organization's
 * connection, so both take an organization admin (`pipeline.apply`): the pipeline is committed to a
 * branch and proposed as one merge request, never written to the default branch.
 */
export const pipelineRoutes = ({
  db,
  principal,
  keys,
  logger,
}: RouteDeps & { keys?: KeyProvider; logger: Logger }) => {
  let catalog: Promise<Template[]> | undefined;
  const templates = () => {
    catalog ??= loadTemplates().catch((e) => {
      catalog = undefined;
      throw e;
    });
    return catalog;
  };
  const reach = async (
    orgId: string,
    connectionId: string,
    requestId: unknown,
  ): Promise<PipelineDeps> => ({
    db,
    catalog: await templates(),
    gitlab: async () => {
      const { baseUrl, token } = await openGitlabConnection(
        { db, keys, logger },
        orgId,
        connectionId,
        requestId,
      );
      return createGitlab({
        baseUrl,
        auth: { type: "private-token", token },
        timeoutMs: 15_000,
        maxRetries: 1,
        maxRetryDelayMs: 2_000,
      });
    },
  });
  const wanted = (b: z.infer<typeof request>) => {
    const { connectionId, ...rest } = b;
    return rest;
  };

  return new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/pipeline" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId, projectId } }) => {
        const project = await getProject(db, orgId, projectId);
        if (!project) throw notFound("Project");
        const config = await getPipelineConfig(db, orgId, projectId);
        return {
          config: config ? configDto(config) : null,
          recommendations: recommend(project.detectedTypes, await templates()),
        };
      },
      {
        params,
        response: {
          200: z.object({
            config: configSchema.nullable(),
            /** Templates that suit the project's kind, the surest first. */
            recommendations: z.array(
              z.object({
                template: z.string(),
                version: z.string(),
                confidence: z.enum(["high", "medium"]),
                reason: z.string(),
              }),
            ),
          }),
          ...readErrors,
        },
        guard: "pipeline.read",
      },
    )
    .post(
      "/preview",
      async ({ params: { orgId, projectId }, body, set }) => {
        const deps = await reach(orgId, body.connectionId, set.headers["x-request-id"]);
        const p = await previewPipeline(deps, orgId, projectId, wanted(body));
        return {
          text: p.text,
          renderedHash: p.renderedHash,
          existing: p.existing,
          template: { name: p.template.name, version: p.template.version },
          validation: p.validation,
        };
      },
      {
        params,
        body: request,
        parse: "json",
        response: {
          200: z.object({
            /** The `.gitlab-ci.yml` that would be committed. */
            text: z.string(),
            renderedHash: z.string(),
            existing: existingSchema,
            template: z.object({ name: z.string(), version: z.string() }),
            validation: validationSchema,
          }),
          ...writeErrors,
          ...sealed,
        },
        noAudit:
          "read-only: renders and lints, writes nothing to GitLab or the database (it does use the connection to read the repository)",
        guard: "pipeline.apply",
      },
    )
    .post(
      "",
      async ({ params: { orgId, projectId }, body, audit, set }) => {
        const deps = await reach(orgId, body.connectionId, set.headers["x-request-id"]);
        const applied = await applyPipeline(
          deps,
          orgId,
          projectId,
          body.connectionId,
          wanted(body),
        );
        // GitLab first, so no transaction waits on it; a re-run after a failure here changes nothing.
        const saved = await db.transaction(async (tx) => {
          const row = await savePipelineConfig(tx, applied.config);
          await audit(tx, {
            action: "pipeline.apply",
            resourceType: "pipeline",
            resourceId: projectId,
            organizationId: orgId,
            projectId,
            metadata: {
              template: row.template,
              version: row.version,
              outcome: applied.outcome,
              committed: applied.committed,
              existing: applied.existing,
              mrIid: applied.mr?.iid ?? null,
              renderedHash: applied.renderedHash,
              paramNames: Object.keys(row.params).sort(),
              overrideKeys: Object.keys(row.overrides).sort(),
            },
          });
          return row;
        });
        return {
          outcome: applied.outcome,
          committed: applied.committed,
          existing: applied.existing,
          mr: applied.mr,
          renderedHash: applied.renderedHash,
          validation: applied.validation,
          config: configDto(saved),
        };
      },
      {
        params,
        body: request,
        parse: "json",
        response: {
          200: z.object({
            /** `opened` a merge request, `updated` the open one, `unchanged` (nothing to do), `in_place` (the default branch already has this file). */
            outcome: z.enum(["opened", "updated", "unchanged", "in_place"]),
            /** A commit was made on the branch this time. */
            committed: z.boolean(),
            existing: existingSchema,
            mr: z.object({ iid: z.number().int(), url: z.string() }).nullable(),
            renderedHash: z.string(),
            validation: validationSchema,
            config: configSchema,
          }),
          ...writeErrors,
          ...sealed,
        },
        audit: "pipeline.apply",
        guard: "pipeline.apply",
      },
    );
};
