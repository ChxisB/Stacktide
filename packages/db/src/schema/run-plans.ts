import { sql } from "drizzle-orm";
import { check, foreignKey, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { runs } from "./runs";

/**
 * The plan of a run as data (FRG-17): the stacks in dependency levels with the commands of their jobs, for a runner
 * that does not read GitLab's YAML. One per run and action, written by whoever starts the run, from the same input as
 * the pipeline. Commands and variable names only: a value is never in it (a command says `$ORCH_TOKEN`, not the token).
 */
export const runPlans = pgTable(
  "run_plans",
  {
    runId: uuid().notNull(),
    // repeated from the run, so a plan cannot name another project than its run's
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    action: text().notNull(),
    plan: jsonb().notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.action] }),
    foreignKey({
      name: "run_plans_run_fk",
      columns: [t.runId, t.organizationId, t.projectId],
      foreignColumns: [runs.id, runs.organizationId, runs.projectId],
    }).onDelete("cascade"),
    check("run_plans_action_check", sql`${t.action} in ('plan', 'apply')`),
    // a few hundred stacks of a few kilobytes of commands each
    check("run_plans_size_check", sql`length(${t.plan}::text) <= 4000000`),
  ],
);
