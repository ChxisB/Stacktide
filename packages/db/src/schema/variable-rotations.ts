import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { id, timestamps } from "./columns";
import { variables } from "./variables";

export const ROTATION_STATUSES = ["never", "ok", "failing", "pending_approval"] as const;
export type RotationStatus = (typeof ROTATION_STATUSES)[number];

/**
 * How one secret variable replaces itself (ROT-2): which provider mints the new value, how often,
 * and how long the old credential stays valid afterwards. At most one per variable. Nothing here is
 * a secret: `config` holds ids and settings, `handle` and `previous_handle` name credentials at the
 * provider (a token id) and are never a credential; a generated value exists only as a variable
 * version. `next_at` doubles as the claim: `claimDue` pushes it out by a lease, and whoever finishes
 * must still hold that exact value, so a worker that lost its lease cannot finish over the next one.
 */
export const variableRotations = pgTable(
  "variable_rotations",
  {
    id: id(),
    organizationId: uuid().notNull(),
    variableId: uuid().notNull(),
    provider: text().notNull(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    intervalDays: integer().notNull(),
    // How long the credential a rotation replaced stays valid, for providers that have one.
    graceDays: integer().notNull().default(0),
    enabled: boolean().notNull().default(true),
    nextAt: timestamp({ withTimezone: true }).notNull(),
    lastAt: timestamp({ withTimezone: true }),
    lastStatus: text().$type<RotationStatus>().notNull().default("never"),
    // A short code (`denied`, `failed`), never the provider's own text.
    lastError: text(),
    attempts: integer().notNull().default(0),
    handle: text(),
    previousHandle: text(),
    revokeAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // One rotation per variable; the FK pair keeps it in the variable's own organization.
    // CASCADE: the rotation is configuration of the variable and goes with it.
    unique("variable_rotations_variable_key").on(t.variableId),
    foreignKey({
      name: "variable_rotations_variable_org_fk",
      columns: [t.variableId, t.organizationId],
      foreignColumns: [variables.id, variables.organizationId],
    }).onDelete("cascade"),
    index("variable_rotations_org_idx").on(t.organizationId, t.id),
    index("variable_rotations_due_idx").on(t.nextAt).where(sql`${t.enabled}`),
    index("variable_rotations_revoke_idx")
      .on(t.revokeAt)
      .where(sql`${t.previousHandle} is not null`),
    check("variable_rotations_provider_check", sql`${t.provider} ~ '^[a-z][a-z0-9_-]{0,31}$'`),
    // Size only: the driver stores a jsonb object as a JSON string, so the shape is the provider's
    // `validate`, not `jsonb_typeof`.
    check("variable_rotations_config_check", sql`length(${t.config}::text) <= 2000`),
    check(
      "variable_rotations_interval_check",
      sql`${t.intervalDays} between 1 and 365 and ${t.graceDays} between 0 and ${t.intervalDays}`,
    ),
    check(
      "variable_rotations_status_check",
      sql`${t.lastStatus} in ('never', 'ok', 'failing', 'pending_approval')
        and (${t.lastError} is null or ${t.lastError} ~ '^[a-z0-9_]{1,40}$')
        and ${t.attempts} >= 0`,
    ),
    check(
      "variable_rotations_handle_check",
      sql`(${t.handle} is null or ${t.handle} ~ '^[A-Za-z0-9._:/@=+-]{1,200}$')
        and (${t.previousHandle} is null or ${t.previousHandle} ~ '^[A-Za-z0-9._:/@=+-]{1,200}$')
        and (${t.previousHandle} is null) = (${t.revokeAt} is null)`,
    ),
  ],
);
