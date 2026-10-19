import { VARIABLE_KINDS, type VariableKind } from "@orch/core";
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { environments } from "./environments";
import { organizations } from "./organizations";
import { projects } from "./projects";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

// Defined in core, where the resolver that reads these kinds lives.
export { VARIABLE_KINDS, type VariableKind };

/**
 * The data key that seals the values of one owner's variables: one per project, one per
 * organization for org-level variables (`project_id` null). It is stored wrapped by a master key
 * (ADR-0007), so a database read alone opens nothing. Only `variables.ts` in this package reads it.
 */
export const variableKeys = pgTable(
  "variable_keys",
  {
    id: id(),
    // CASCADE here and on `variables`: an organization can be removed only after its projects
    // (RESTRICT), and what is left of its configuration goes with it.
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid(),
    dekKeyId: text().notNull(),
    dekWrapped: bytea().notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("variable_keys_org_key").on(t.organizationId).where(sql`${t.projectId} IS NULL`),
    uniqueIndex("variable_keys_project_key").on(t.projectId).where(sql`${t.projectId} IS NOT NULL`),
    foreignKey({
      name: "variable_keys_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
  ],
);

/**
 * A named value at one of three levels: the organization (`project_id` null), a project, or one
 * environment of a project. Deleting sets `deleted_at` (the key is then free again, the history
 * stays); the values live in `variable_versions`, and `current_version` says which one is live.
 * Project and environment removal cascade: their variables go with them.
 */
export const variables = pgTable(
  "variables",
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid(),
    environmentId: uuid(),
    key: text().notNull(),
    kind: text().$type<VariableKind>().notNull(),
    description: text().notNull().default(""),
    currentVersion: integer().notNull().default(1),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // The target of other tables' composite keys (a rotation stays in its variable's organization).
    unique("variables_id_org_key").on(t.id, t.organizationId),
    // For the cascades from an organization, project or environment (the partial indexes below
    // cannot serve them: they only hold live rows).
    index("variables_scope_idx").on(t.organizationId, t.projectId),
    index("variables_environment_idx")
      .on(t.environmentId)
      .where(sql`${t.environmentId} IS NOT NULL`),
    // Live rows only: a deleted variable does not hold its key.
    uniqueIndex("variables_org_key")
      .on(t.organizationId, t.key)
      .where(sql`${t.projectId} IS NULL AND ${t.deletedAt} IS NULL`),
    uniqueIndex("variables_project_key")
      .on(t.projectId, t.key)
      .where(
        sql`${t.projectId} IS NOT NULL AND ${t.environmentId} IS NULL AND ${t.deletedAt} IS NULL`,
      ),
    uniqueIndex("variables_environment_key")
      .on(t.environmentId, t.key)
      .where(sql`${t.environmentId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    foreignKey({
      name: "variables_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "variables_environment_project_fk",
      columns: [t.environmentId, t.projectId],
      foreignColumns: [environments.id, environments.projectId],
    }).onDelete("cascade"),
    check("variables_scope_check", sql`${t.environmentId} IS NULL OR ${t.projectId} IS NOT NULL`),
    check("variables_key_check", sql`${t.key} ~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$'`),
    check("variables_kind_check", sql`${t.kind} IN ('plain', 'secret', 'file')`),
    check("variables_version_check", sql`${t.currentVersion} >= 1`),
  ],
);

/**
 * Every value a variable has had, sealed with its owner's data key (`value_enc`, bound to the
 * owner, the variable and the version). Append-only: a trigger refuses UPDATE, TRUNCATE and any
 * DELETE that does not come from a cascade.
 */
export const variableVersions = pgTable(
  "variable_versions",
  {
    id: id(),
    variableId: uuid()
      .notNull()
      .references(() => variables.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    valueEnc: bytea().notNull(),
    actorKind: text().notNull(),
    actorId: text().notNull(),
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("variable_versions_variable_version_key").on(t.variableId, t.version),
    check("variable_versions_version_check", sql`${t.version} >= 1`),
  ],
);
