import type { Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { getPool, getProject } from "@orch/db";
import { GitlabError } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import { gitlabFor } from "./pipeline";
import { notFound, type RouteDeps, readErrors } from "./shared";

const REASONS = ["unlinked", "not_permitted", "unavailable"] as const;
type Reason = (typeof REASONS)[number];

const statusSchema = z.object({
  poolId: z.uuid(),
  tags: z.array(z.string()),
  /** `unknown` when GitLab could not be asked or would not say: never read as healthy. */
  state: z.enum(["healthy", "degraded", "offline", "unknown"]),
  /** Runners with every tag of the pool that are online and not paused. */
  online: z.number().int(),
  /** Runners with every tag that have been heard from lately (stale and never-contacted ones are left out). */
  total: z.number().int(),
  /** Why the state is `unknown`: the project is not on GitLab, the connection's token may not list its runners, or GitLab did not answer. */
  reason: z.enum(REASONS).nullable(),
});

const unknown = (reason: Reason) => ({ state: "unknown" as const, online: 0, total: 0, reason });

/**
 * How a pool looks from one project (POOL-4). GitLab lists runners per project, so the answer is the
 * runners **that project can use** with the pool's tags: its own, its groups' and the instance's. It
 * reaches GitLab with the organization's connection, so it takes an organization admin, as a pipeline
 * preview does. Counts only: no runner's address, description or token is read, let alone shown.
 */
export const poolStatusRoutes = ({
  db,
  principal,
  keys,
  logger,
}: RouteDeps & { keys?: KeyProvider; logger: Logger }) =>
  new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/pools" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "/:poolId/status",
      async ({ params: { orgId, projectId, poolId }, query, set }) => {
        const project = await getProject(db, orgId, projectId);
        if (!project) throw notFound("Project");
        const pool = await getPool(db, orgId, poolId);
        if (!pool) throw notFound("Pool");
        const gitlab = await gitlabFor(
          { db, keys, logger },
          orgId,
          query.connectionId,
          set.headers["x-request-id"],
        );
        const answer = { poolId: pool.id, tags: pool.tags };
        if (project.gitlabProjectId === null) return { ...answer, ...unknown("unlinked") };
        try {
          const heard: { online: boolean; paused: boolean }[] = [];
          for await (const r of gitlab.runners.list(project.gitlabProjectId, { tags: pool.tags })) {
            if (r.status === "online" || r.status === "offline") heard.push(r);
          }
          const online = heard.filter((r) => r.online && !r.paused).length;
          return {
            ...answer,
            state:
              online === 0
                ? ("offline" as const)
                : online === heard.length
                  ? ("healthy" as const)
                  : ("degraded" as const),
            online,
            total: heard.length,
            reason: null,
          };
        } catch (e) {
          if (!(e instanceof GitlabError)) throw e;
          // what GitLab said is not passed on; a refusal and a failure are both "not known"
          const reason: Reason =
            e.kind === "forbidden" || e.kind === "unauthorized"
              ? "not_permitted"
              : e.kind === "not_found"
                ? "unlinked"
                : "unavailable";
          return { ...answer, ...unknown(reason) };
        }
      },
      {
        params: z.object({ orgId: z.uuid(), projectId: z.uuid(), poolId: z.uuid() }),
        query: z.object({ connectionId: z.uuid() }),
        response: { 200: statusSchema, ...readErrors },
        guard: "pool.status",
      },
    );
