import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { projects } from "./projects";

/**
 * One run of IaC stacks on a commit (IAC-5): which stacks, for which ref and commit, and, when a
 * merge request caused it, which one. What each stack is doing is in `run_stacks`; the run has no
 * state of its own. Nothing here is a secret. `sha` is the commit the plans are made from, so an
 * apply can tell that the branch has moved on.
 */
export const runs = pgTable(
  "runs",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    ref: text().notNull(),
    sha: text().notNull(),
    mergeRequestIid: integer(),
    ...timestamps(),
  },
  (t) => [
    // for the stacks' composite key: a stack's row cannot name another project than its run's
    unique("runs_scope_key").on(t.id, t.organizationId, t.projectId),
    // newest first: ids are time-ordered
    index("runs_project_idx").on(t.projectId, t.id),
    // CASCADE: a project's runs are its history and go with it.
    foreignKey({
      name: "runs_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check("runs_ref_check", sql`length(${t.ref}) between 1 and 255`),
    // a git object id: SHA-1, or SHA-256 in repositories that use it
    check("runs_sha_check", sql`${t.sha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
    check("runs_mr_check", sql`${t.mergeRequestIid} is null or ${t.mergeRequestIid} > 0`),
  ],
);

/**
 * One stack of a run and where it is in the lifecycle of `@orch/core`'s `RUN_STATES`. `stack` is the
 * stack's name when the run was made and is not a foreign key: stacks leave the table when they
 * leave the repository, a run is history. `error` says why a stack failed, in fixed words, never a
 * tool's output (that can hold values).
 */
export const runStacks = pgTable(
  "run_stacks",
  {
    runId: uuid().notNull(),
    // repeated from the run, for the mutex below
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    stack: text().notNull(),
    status: text().notNull().default("queued"),
    error: text(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.stack] }),
    foreignKey({
      name: "run_stacks_run_fk",
      columns: [t.runId, t.organizationId, t.projectId],
      foreignColumns: [runs.id, runs.organizationId, runs.projectId],
    }).onDelete("cascade"),
    // The mutex: a stack is applied by one run at a time, whatever the callers do.
    uniqueIndex("run_stacks_one_applying")
      .on(t.projectId, t.stack)
      .where(sql`${t.status} = 'applying'`),
    check("run_stacks_stack_check", sql`${t.stack} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`),
    check(
      "run_stacks_status_check",
      sql`${t.status} in ('queued', 'planning', 'planned', 'applying', 'applied', 'failed', 'discarded', 'canceled')`,
    ),
    check("run_stacks_error_check", sql`length(${t.error}) <= 500`),
  ],
);
