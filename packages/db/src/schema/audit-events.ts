import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id } from "./columns";

/**
 * Append-only (a trigger rejects UPDATE, DELETE and TRUNCATE), so no `updated_at`. Ids of the
 * organization and project are plain columns, not foreign keys: the record must outlive them.
 * Metadata is ids, key names and counts, never values (see `audit()`).
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    actorKind: text().notNull(),
    actorId: text().notNull(),
    action: text().notNull(),
    resourceType: text().notNull(),
    resourceId: text(),
    organizationId: uuid(),
    projectId: uuid(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    requestId: text(),
    ip: text(),
  },
  (t) => [
    index("audit_events_org_at_idx").on(t.organizationId, t.at),
    // The audit API pages newest first by id (GOV-1).
    index("audit_events_org_id_idx").on(t.organizationId, t.id),
    index("audit_events_resource_idx").on(t.resourceType, t.resourceId),
  ],
);
