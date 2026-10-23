import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { projects } from "./projects";

/**
 * Which project and stack may manage which DNS zone (DNS-6, ADR-0018): an organization admin makes the
 * claim, and a plan that names a zone nobody claimed for its stack is denied before apply (DNS-7). A zone is
 * claimed once per organization; the stack is a name, not a row, because a claim may be made before the
 * stack's first scan. Zone and stack names only: nothing here is a secret, and nothing here is a record.
 * The check repeats `ZONE` and `NAME` of `@orch/iac` for a writer other than the route.
 */
export const dnsZones = pgTable(
  "dns_zones",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    zone: text().notNull(),
    stack: text().notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("dns_zones_org_zone_key").on(t.organizationId, t.zone),
    index("dns_zones_project_idx").on(t.projectId, t.id),
    // CASCADE: a claim is configuration and goes with the project it names (an organization cannot be deleted
    // while it has projects). The pair also makes the project one of the organization's.
    foreignKey({
      name: "dns_zones_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check(
      "dns_zones_check",
      sql`length(${t.zone}) <= 253
        and ${t.zone} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
        and ${t.stack} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
  ],
);
