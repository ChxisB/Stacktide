import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { projects } from "./projects";

/**
 * A short-lived credential issued to one principal (ROT-10, ADR-0014). The credential itself is
 * returned once to whoever asked and exists nowhere here: a row names who asked, what was made, where,
 * and until when, plus the `handle` (a token id, never a credential) that revokes it. A row with no
 * handle is one whose credential was never made or whose handle was never recorded; nothing can
 * revoke it, and the provider's own expiry is what ends it. `revoked_at` is set when it ends, on
 * request or at expiry.
 */
export const secretLeases = pgTable(
  "secret_leases",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    // `<kind>:<id>` as audit and change requests name a person, so the live count is per principal.
    principal: text().notNull(),
    provider: text().notNull(),
    // The stored connection that made it, and the GitLab project it was made on (taken from the
    // platform project at issue time: relinking the project later must not move the revoke).
    connectionId: uuid().notNull(),
    remoteProjectId: bigint({ mode: "number" }).notNull(),
    // Comma-separated, from a fixed read-only list.
    scopes: text().notNull(),
    handle: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    // CASCADE: a lease is the project's own record and goes with it.
    foreignKey({
      name: "secret_leases_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    index("secret_leases_project_idx").on(t.organizationId, t.projectId, t.id),
    index("secret_leases_live_idx").on(t.principal, t.expiresAt).where(sql`${t.revokedAt} is null`),
    index("secret_leases_due_idx")
      .on(t.expiresAt)
      .where(sql`${t.revokedAt} is null and ${t.handle} is not null`),
    check("secret_leases_provider_check", sql`${t.provider} ~ '^[a-z][a-z0-9_-]{0,31}$'`),
    check(
      "secret_leases_principal_check",
      sql`${t.principal} ~ '^[a-z]{1,16}:[A-Za-z0-9._:@=+-]{1,120}$'`,
    ),
    check("secret_leases_scopes_check", sql`${t.scopes} ~ '^[a-z_]{1,32}(,[a-z_]{1,32}){0,7}$'`),
    check(
      "secret_leases_handle_check",
      sql`${t.handle} is null or ${t.handle} ~ '^[A-Za-z0-9._:/@=+-]{1,200}$'`,
    ),
  ],
);
