import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { projects } from "./projects";

/**
 * Whether a stack's real infrastructure still matches its code (POL-1): what the stack's last drift
 * run found. A drift run is a plan of the default branch; a plan that would change nothing is
 * `clean`, one that would add, change or destroy is `drifted`, and `unknown` is a stack no run has
 * reported on yet. `since` is when the current drift was first seen: an episode lasts until a run
 * finds the stack clean, and only its start and its end are news. `requested_at` is when the
 * platform last asked for a check, which is what the cadence counts from; a check that never
 * reports is asked for again after a full period. `stack` is a name, not a foreign key: stacks leave
 * the repository, and this is history. Counts only, never a resource or a value.
 */
export const stackDrift = pgTable(
  "stack_drift",
  {
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    stack: text().notNull(),
    status: text().notNull().default("unknown"),
    since: timestamp({ withTimezone: true }),
    requestedAt: timestamp({ withTimezone: true }).notNull(),
    checkedAt: timestamp({ withTimezone: true }),
    planAdd: integer(),
    planChange: integer(),
    planDestroy: integer(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.stack] }),
    // CASCADE: an observation of a project's stack goes with the project.
    foreignKey({
      name: "stack_drift_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check("stack_drift_stack_check", sql`${t.stack} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`),
    check("stack_drift_status_check", sql`${t.status} in ('unknown', 'clean', 'drifted')`),
    // what a check found is there exactly when there was one, and an episode exactly while drifted
    check(
      "stack_drift_found_check",
      sql`(${t.status} = 'unknown') = (${t.checkedAt} is null)
        and (${t.status} = 'unknown') = (${t.planAdd} is null)
        and (${t.status} = 'unknown') = (${t.planChange} is null)
        and (${t.status} = 'unknown') = (${t.planDestroy} is null)
        and (${t.status} = 'drifted') = (${t.since} is not null)
        and coalesce(least(${t.planAdd}, ${t.planChange}, ${t.planDestroy}), 0) >= 0
        and (${t.status} <> 'drifted' or ${t.planAdd} + ${t.planChange} + ${t.planDestroy} > 0)
        and (${t.status} <> 'clean' or ${t.planAdd} + ${t.planChange} + ${t.planDestroy} = 0)`,
    ),
  ],
);
