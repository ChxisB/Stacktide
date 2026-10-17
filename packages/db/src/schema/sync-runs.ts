import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { syncTargets } from "./sync-targets";

/**
 * One plan of a sync target (SYNC-5), and later the record of applying it. A plan holds keys,
 * scopes, actions and counts, never a value: `desired_digest` is a hash of which variables and
 * versions it was made from (no value goes into it), so a later apply can tell the desired state
 * has moved on. `skipped` says what the plan left out and why.
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    targetId: uuid().notNull(),
    status: text().notNull().default("planned"),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    desiredDigest: text().notNull(),
    counts: jsonb().$type<Record<string, number>>().notNull(),
    skipped: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (t) => [
    // CASCADE: a run is the history of its target and goes with it. The composite key keeps the
    // run in the target's project and organization.
    foreignKey({
      name: "sync_runs_target_fk",
      columns: [t.targetId, t.organizationId, t.projectId],
      foreignColumns: [syncTargets.id, syncTargets.organizationId, syncTargets.projectId],
    }).onDelete("cascade"),
    index("sync_runs_target_idx").on(t.targetId, t.id),
    check(
      "sync_runs_status_check",
      sql`${t.status} IN ('planned', 'applying', 'applied', 'failed')`,
    ),
  ],
);

/**
 * A line of a plan: `action` is what `@orch/sync` calls it, `changed` names fields, not values.
 * Timestamps, because an apply records what happened to each line (SYNC-6).
 */
export const syncRunItems = pgTable(
  "sync_run_items",
  {
    runId: uuid()
      .notNull()
      .references(() => syncRuns.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    key: text().notNull(),
    scope: text().notNull(),
    action: text().notNull(),
    changed: jsonb().$type<string[]>().notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.position] }),
    check(
      "sync_run_items_action_check",
      sql`${t.action} IN ('create', 'update', 'delete', 'noop', 'adopt')`,
    ),
  ],
);
