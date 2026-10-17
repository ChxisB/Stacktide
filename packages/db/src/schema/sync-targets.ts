import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { connections } from "./connections";
import { projects } from "./projects";

/**
 * Where a project's variables are written (SYNC-4): one row says which kind of target (`type`),
 * which connection reaches it, which part of it (`config`: ids and flags, never a credential), which
 * environments go to which scope of it (`environment_mapping`: environment slug -> scope), and what
 * to do with what the target holds that nothing here wants. Rows are configuration only; what a
 * sync did is kept elsewhere.
 */
export const syncTargets = pgTable(
  "sync_targets",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    name: text().notNull(),
    type: text().notNull(),
    connectionId: uuid().notNull(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    environmentMapping: jsonb().$type<Record<string, string>>().notNull().default({}),
    unmanagedPolicy: text().notNull().default("ignore"),
    autoSync: boolean().notNull().default(false),
    /** Drift (SYNC-8) is put right by an automatic apply of creates and updates; never deletes. */
    autoRemediate: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    unique("sync_targets_project_name_key").on(t.projectId, t.name),
    // The target of a run: its id together with where it lives, so a run cannot name a target of another project.
    unique("sync_targets_id_scope_key").on(t.id, t.organizationId, t.projectId),
    // CASCADE: a project's targets are its configuration and go with it.
    foreignKey({
      name: "sync_targets_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    // RESTRICT: a connection in use is never silently taken away from its targets. The composite
    // key also keeps the connection in the target's organization.
    foreignKey({
      name: "sync_targets_connection_org_fk",
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [connections.id, connections.organizationId],
    }).onDelete("restrict"),
    check("sync_targets_type_check", sql`${t.type} ~ '^[a-z][a-z0-9_-]{0,63}$'`),
    check(
      "sync_targets_unmanaged_policy_check",
      sql`${t.unmanagedPolicy} IN ('ignore', 'adopt', 'prune')`,
    ),
  ],
);
