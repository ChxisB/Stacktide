import { and, desc, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { auditEvents, organizations } from "./schema";

export type AuditRow = typeof auditEvents.$inferSelect;

/** The queue of the schedule that runs the purge. */
export const AUDIT_PURGE_QUEUE = "audit.purge";

export interface AuditFilter {
  /** Always set: the events of one organization, never another's. */
  organizationId: string;
  /** An action, or a prefix ending in `.*` (`variable.*`). */
  action?: string | undefined;
  actorKind?: string | undefined;
  actorId?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  projectId?: string | undefined;
  /** `at >= since`, `at < until`. */
  since?: Date | undefined;
  until?: Date | undefined;
}

/**
 * The organization's events, newest first. Paged by id, which is time-ordered (v7) and exact, where
 * a timestamp cursor would lose the microseconds a JS Date does not carry. `after` is the id of the
 * last row of the previous page.
 */
export function listAuditEvents(
  db: Executor,
  f: AuditFilter,
  page: { after?: string | undefined; limit: number },
): Promise<AuditRow[]> {
  const where: (SQL | undefined)[] = [
    eq(auditEvents.organizationId, f.organizationId),
    page.after === undefined ? undefined : lt(auditEvents.id, page.after),
    f.actorKind === undefined ? undefined : eq(auditEvents.actorKind, f.actorKind),
    f.actorId === undefined ? undefined : eq(auditEvents.actorId, f.actorId),
    f.resourceType === undefined ? undefined : eq(auditEvents.resourceType, f.resourceType),
    f.resourceId === undefined ? undefined : eq(auditEvents.resourceId, f.resourceId),
    f.projectId === undefined ? undefined : eq(auditEvents.projectId, f.projectId),
    f.since === undefined ? undefined : gte(auditEvents.at, f.since),
    f.until === undefined ? undefined : lt(auditEvents.at, f.until),
  ];
  if (f.action !== undefined) {
    // starts_with, not LIKE: `_` is legal in an action and is a wildcard in a pattern
    where.push(
      f.action.endsWith(".*")
        ? sql`starts_with(${auditEvents.action}, ${f.action.slice(0, -1)})`
        : eq(auditEvents.action, f.action),
    );
  }
  return db
    .select()
    .from(auditEvents)
    .where(and(...where))
    .orderBy(desc(auditEvents.id))
    .limit(page.limit);
}

/** Days an organization's events are kept; null for ever; undefined when there is no such organization. */
export async function getAuditRetention(
  db: Executor,
  organizationId: string,
): Promise<number | null | undefined> {
  const [row] = await db
    .select({ days: organizations.auditRetentionDays })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.days;
}

/** The previous setting, or undefined when there is no such organization. The table refuses fewer than 30 days or more than 3650. */
export async function setAuditRetention(
  db: Executor,
  organizationId: string,
  days: number | null,
): Promise<{ previous: number | null } | undefined> {
  const [before] = await db
    .select({ days: organizations.auditRetentionDays })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
  if (!before) return undefined;
  await db
    .update(organizations)
    .set({ auditRetentionDays: days })
    .where(eq(organizations.id, organizationId));
  return { previous: before.days };
}

/**
 * Deletes up to `batch` audit events that are older than their organization's retention, oldest
 * first, and says how many of each organization's went. The cutoff is not an argument: the SQL
 * function reads each organization's own setting, and leaves alone every event of an organization
 * that keeps them for ever, that no longer exists, or that names none. Run it in a transaction
 * with the `audit.purge` rows that record it.
 */
export async function purgeExpiredAudit(
  db: Executor,
  batch: number,
): Promise<{ organizationId: string; purged: number }[]> {
  const rows = await db.execute<{ org_id: string; purged: string | number | bigint }>(
    sql`select org_id, purged from audit_purge_expired(${batch}::integer)`,
  );
  return [...rows].map((r) => ({ organizationId: r.org_id, purged: Number(r.purged) }));
}
