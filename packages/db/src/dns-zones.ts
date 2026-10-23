import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Executor, Page } from "./repo";
import { dnsZones } from "./schema";

export type DnsZoneRow = typeof dnsZones.$inferSelect;
export type DnsZoneInput = Pick<DnsZoneRow, "organizationId" | "projectId" | "zone" | "stack">;

/**
 * Claims a zone for a project's stack. The database refuses a zone that is claimed already
 * (`dns_zones_org_zone_key`), a project of another organization (`dns_zones_project_org_fk`) and a name
 * that is not a zone (`dns_zones_check`); the route turns each into its answer.
 */
export async function createDnsZone(db: Executor, input: DnsZoneInput) {
  const [row] = await db.insert(dnsZones).values(input).returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

/** Ordered by id (a v7 uuid: creation order to the millisecond, not a strict guarantee). */
export function listDnsZones(db: Executor, organizationId: string, page: Page<string>) {
  return db
    .select()
    .from(dnsZones)
    .where(
      and(
        eq(dnsZones.organizationId, organizationId),
        page.after ? gt(dnsZones.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(dnsZones.id))
    .limit(page.limit);
}

/** The claim that was deleted, or `undefined` when the organization had none with that id. */
export async function deleteDnsZone(db: Executor, organizationId: string, id: string) {
  return (
    await db
      .delete(dnsZones)
      .where(and(eq(dnsZones.id, id), eq(dnsZones.organizationId, organizationId)))
      .returning()
  )[0];
}

/** Which of `zones` the stack holds: a claim of another stack, project or organization does not count. */
export async function claimedZones(
  db: Executor,
  at: { organizationId: string; projectId: string; stack: string },
  zones: readonly string[],
): Promise<Set<string>> {
  if (zones.length === 0) return new Set();
  const rows = await db
    .select({ zone: dnsZones.zone })
    .from(dnsZones)
    .where(
      and(
        eq(dnsZones.organizationId, at.organizationId),
        eq(dnsZones.projectId, at.projectId),
        eq(dnsZones.stack, at.stack),
        inArray(dnsZones.zone, [...zones]),
      ),
    );
  return new Set(rows.map((r) => r.zone));
}
