import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id } from "./columns";
import { projects } from "./projects";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * One version of a stack's Terraform state (STATE-2, ADR-0017): one row per write, never changed, the newest
 * 20 kept. The state is sealed like a connection's token (own data key, wrapped by a master key, ADR-0007), so
 * a database read alone yields nothing, and only `state.ts` in this package reads `state_enc`. What the
 * columns do show (stack name, serial, lineage, size, who) is metadata.
 *
 * Keyed by project and stack *name*, not by a `stacks` row: a repository scan replaces those rows, and a scan
 * that no longer finds a stack must not delete its state. The project foreign key is RESTRICT for the same
 * reason: a project with state cannot be deleted until its state is. `created_at` only, like other tables
 * whose rows are written once.
 */
export const stateVersions = pgTable(
  "state_versions",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    stackName: text().notNull(),
    serial: integer().notNull(),
    lineage: text().notNull(),
    stateEnc: bytea().notNull(),
    dekKeyId: text().notNull(),
    dekWrapped: bytea().notNull(),
    sizeBytes: integer().notNull(),
    // who wrote it, for showing: the CI job's subject, never a token
    createdBy: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("state_versions_serial_key").on(t.projectId, t.stackName, t.serial),
    foreignKey({
      name: "state_versions_project_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("restrict"),
    check(
      "state_versions_stack_name_check",
      sql`${t.stackName} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    check("state_versions_serial_check", sql`${t.serial} >= 0`),
    check("state_versions_lineage_check", sql`length(${t.lineage}) between 1 and 256`),
  ],
);

/**
 * The lock on one stack's state (STATE-4, ADR-0017): at most one row per stack, taken by a CI job and ended by it,
 * by its own expiry (the job's token) or by an organization admin. `info` is Terraform's lock info as the holder
 * sent it, handed to whoever is refused. The project foreign key cascades: a lock is not state, and a project
 * can be deleted with one held. `created_at` only: a lock is taken and released, never changed.
 */
export const stateLocks = pgTable(
  "state_locks",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    stackName: text().notNull(),
    // Terraform's lock id: the holder names it, the job (owner) is what proves it
    lockId: text().notNull(),
    owner: text().notNull(),
    info: jsonb().$type<Record<string, string>>().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("state_locks_stack_key").on(t.projectId, t.stackName),
    foreignKey({
      name: "state_locks_project_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check(
      "state_locks_stack_name_check",
      sql`${t.stackName} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    check("state_locks_lock_id_check", sql`length(${t.lockId}) between 1 and 256`),
  ],
);

/**
 * The resource instances of the **newest** version of a stack's state (STATE-6, ADR-0017): identity only (address,
 * mode, type, name, provider, module, index key), never an attribute, so a query over it cannot yield a secret from
 * the state. Replaced wholesale in the transaction that writes a version, so it cannot disagree with it; it goes
 * with the version it describes (`version_id` cascades). The organization, project and stack are repeated from the
 * version, written from the same reference in the same transaction, to filter by without a join. `created_at` only.
 */
export const stateResources = pgTable(
  "state_resources",
  {
    id: id(),
    versionId: uuid()
      .notNull()
      .references(() => stateVersions.id, { onDelete: "cascade" }),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    stackName: text().notNull(),
    address: text().notNull(),
    mode: text().notNull(),
    type: text().notNull(),
    name: text().notNull(),
    provider: text().notNull(),
    module: text(),
    indexKey: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("state_resources_address_key").on(t.versionId, t.address),
    index("state_resources_stack_idx").on(t.projectId, t.stackName, t.address),
    check("state_resources_mode_check", sql`${t.mode} in ('managed', 'data')`),
  ],
);
