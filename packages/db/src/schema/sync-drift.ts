import { sql } from "drizzle-orm";
import { check, foreignKey, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { syncTargets } from "./sync-targets";

/**
 * What the last drift check (SYNC-8) found on a sync target: `in_sync`, or `drifted` when applying
 * the plan would create, update or delete something. One row per target, replaced by each check;
 * `counts` is the plan's count per action, never a key or a value. Kept apart from the target so
 * that configuration and what was observed do not share a row.
 */
export const syncDrift = pgTable(
  "sync_target_drift",
  {
    targetId: uuid().primaryKey(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    status: text().notNull(),
    counts: jsonb().$type<Record<string, number>>().notNull(),
    // `updated_at` is when the target was last checked: every check rewrites the row, and the trigger stamps it with the database clock.
    ...timestamps(),
  },
  (t) => [
    // CASCADE: an observation of a target goes with it. The composite key keeps it in the target's project and organization.
    foreignKey({
      name: "sync_target_drift_target_fk",
      columns: [t.targetId, t.organizationId, t.projectId],
      foreignColumns: [syncTargets.id, syncTargets.organizationId, syncTargets.projectId],
    }).onDelete("cascade"),
    check("sync_target_drift_status_check", sql`${t.status} IN ('in_sync', 'drifted')`),
  ],
);
