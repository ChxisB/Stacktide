import { DomainError } from "@orch/core";
import { getRunPlan } from "@orch/db";
import { runPlanSchema } from "@orch/iac";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import { notFound, type RouteDeps, readErrors } from "./shared";

const params = z.object({ orgId: z.uuid(), projectId: z.uuid(), runId: z.uuid() });

/**
 * The plan of a run as data (FRG-17), for a runner that does not read GitLab's YAML (a GitHub Actions workflow):
 * the stacks in dependency levels, each with the commands of its jobs. Whoever starts the run keeps it. The reader
 * is a CI job of the project: a person has no use for it, and the route says so.
 *
 * shortcut: the scope is `run.summary`, which every job of the project in no environment holds, so any such job
 * may read any run's plan of the project, not only a job of the run; the plan is commands and variable names, and
 * a job of the project can read the repository's own. Upgrade to a scope of its own if the plan ever holds more.
 */
export const runPlanRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/runs" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "/:runId/plan",
      async ({ params: { orgId, projectId, runId }, query, principal: caller }) => {
        if (caller?.kind !== "ci") {
          throw new DomainError(
            "forbidden",
            403,
            "Not allowed: only a CI job reads the plan of a run",
          );
        }
        const plan = await getRunPlan(db, orgId, projectId, runId, query.action);
        if (plan === undefined) throw notFound("Plan");
        // parsed on the way out as well: what the route sends is what the schema says
        return runPlanSchema.parse(plan);
      },
      {
        params,
        query: z.object({ action: z.enum(["plan", "apply"]).default("plan") }),
        response: { 200: runPlanSchema, ...readErrors },
        guard: "run.summary",
      },
    );
