import type { Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { isProjectPath } from "@orch/pipelines";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { guardPlugin } from "../guard";
import { consumersOf, readRegistry } from "../template-registry";
import { gitlabFor } from "./pipeline";
import { type RouteDeps, readErrors } from "./shared";

const params = z.object({ orgId: z.uuid() });

/**
 * What a catalog project publishes (CMP-4): its releases, its components and their inputs, and which of the organization's projects use it, read with
 * the token of one of the organization's connections. Nothing is written anywhere. Org admins only:
 * it reads a repository of the admin's choosing with the connection's token, as a pipeline preview does.
 */
export const templateRegistryRoutes = ({
  db,
  principal,
  keys,
  logger,
}: RouteDeps & { keys?: KeyProvider; logger: Logger }) =>
  new Elysia({ prefix: "/organizations/:orgId/template-registry" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId }, query, set }) => {
        if (!keys) throw noKeys();
        const api = await gitlabFor(
          { db, keys, logger },
          orgId,
          query.connectionId,
          set.headers["x-request-id"],
        );
        const registry = await readRegistry(api, query.project);
        return { ...registry, consumers: await consumersOf(db, orgId, registry) };
      },
      {
        params,
        query: z.object({
          /** The catalog project's path, such as `group/ci-templates`. */
          project: z.string().min(1).max(255).refine(isProjectPath, "not a project path"),
          connectionId: z.uuid(),
        }),
        response: {
          200: z.object({
            project: z.string(),
            /** Every release (a tag such as `1.2.3`), newest first. */
            releases: z.array(z.string()),
            latest: z.string().nullable(),
            /** More releases than were read for the components. */
            truncated: z.boolean(),
            components: z.array(
              z.object({
                name: z.string(),
                /** The releases that hold it, newest first. */
                versions: z.array(z.string()),
                /** Declared at the newest of them. */
                inputs: z.array(
                  z.object({ name: z.string(), type: z.string(), required: z.boolean() }),
                ),
                /** Why its file could not be read; null when it could. */
                problem: z.string().nullable(),
              }),
            ),
            /** The organization's projects that include this catalog project, and how current each is. */
            consumers: z.array(
              z.object({
                projectId: z.uuid(),
                projectName: z.string(),
                template: z.string(),
                mode: z.enum(["include", "component"]),
                ref: z.string().nullable(),
                standing: z.enum(["up_to_date", "behind", "unpinned", "unpublished"]),
              }),
            ),
          }),
          ...readErrors,
          502: z.any(),
          503: z.any(),
        },
        guard: "template.registry.read",
      },
    );
