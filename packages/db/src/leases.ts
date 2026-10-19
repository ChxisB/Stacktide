import { LEASES_PER_PRINCIPAL } from "@orch/core";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Executor, Page } from "./repo";
import { secretLeases } from "./schema";

export type Lease = typeof secretLeases.$inferSelect;

/** The schedule's job that ends the leases past their expiry. */
export const LEASE_SWEEP_QUEUE = "lease.sweep";

const clock = (now?: Date) => (now ? sql`${now.toISOString()}::timestamptz` : sql`now()`);
const live = (now?: Date) =>
  and(sql`${secretLeases.revokedAt} is null`, sql`${secretLeases.expiresAt} > ${clock(now)}`);

export interface NewLease {
  organizationId: string;
  projectId: string;
  /** `<kind>:<id>`, as audit names a person. */
  principal: string;
  provider: string;
  connectionId: string;
  remoteProjectId: number;
  scopes: readonly string[];
  expiresAt: Date;
  /** Test seam for the live count. Left out, the database clock decides. */
  now?: Date;
}

/**
 * Records a lease about to be made, before the credential exists: a credential minted with no row to
 * name it could not be revoked. `too_many` once the principal holds `LEASES_PER_PRINCIPAL` live ones.
 * The count and the insert share a lock on the principal, so concurrent requests cannot pass the cap
 * together. Follow with `recordHandle`, or `forgetLease` when the provider failed.
 */
export async function startLease(
  db: Executor,
  input: NewLease,
): Promise<{ lease: Lease } | { error: "too_many" }> {
  const { now, scopes, ...row } = input;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${row.principal}, 0))`);
    const [held] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(secretLeases)
      .where(and(eq(secretLeases.principal, row.principal), live(now)));
    if ((held?.n ?? 0) >= LEASES_PER_PRINCIPAL) return { error: "too_many" as const };
    const [lease] = await tx
      .insert(secretLeases)
      .values({ ...row, scopes: scopes.join(",") })
      .returning();
    if (!lease) throw new Error("insert returned no row");
    return { lease };
  });
}

/** Names the credential just made, so that it can be revoked. False when the row is gone or already ended. */
export async function recordHandle(db: Executor, id: string, handle: string) {
  const rows = await db
    .update(secretLeases)
    .set({ handle })
    .where(
      and(
        eq(secretLeases.id, id),
        sql`${secretLeases.handle} is null`,
        sql`${secretLeases.revokedAt} is null`,
      ),
    )
    .returning({ id: secretLeases.id });
  return rows.length === 1;
}

/** Drops a lease whose credential was never made. Never one with a handle: that names a live credential. */
export async function forgetLease(db: Executor, id: string) {
  await db
    .delete(secretLeases)
    .where(and(eq(secretLeases.id, id), sql`${secretLeases.handle} is null`));
}

export async function getLease(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
) {
  return (
    await db
      .select()
      .from(secretLeases)
      .where(
        and(
          eq(secretLeases.id, id),
          eq(secretLeases.organizationId, organizationId),
          eq(secretLeases.projectId, projectId),
        ),
      )
  )[0];
}

/** A project's leases in creation order (v7 ids), optionally only one principal's. Nothing here is a credential. */
export function listLeases(
  db: Executor,
  organizationId: string,
  projectId: string,
  page: Page<string>,
  opts: { principal?: string } = {},
) {
  return db
    .select()
    .from(secretLeases)
    .where(
      and(
        eq(secretLeases.organizationId, organizationId),
        eq(secretLeases.projectId, projectId),
        opts.principal ? eq(secretLeases.principal, opts.principal) : undefined,
        page.after ? gt(secretLeases.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(secretLeases.id))
    .limit(page.limit);
}

/**
 * Marks a lease ended, once: the row when this call ended it, undefined when it was already ended (or
 * is not there), so a revoke by a person and one by the sweeper at the same moment is counted once.
 */
export async function endLease(db: Executor, id: string, now?: Date) {
  const [row] = await db
    .update(secretLeases)
    .set({ revokedAt: clock(now) })
    .where(and(eq(secretLeases.id, id), sql`${secretLeases.revokedAt} is null`))
    .returning();
  return row;
}

/**
 * Leases past their expiry that are still valid, longest overdue first. Nothing is claimed: revoking
 * is idempotent and `endLease` acts once, so two workers at once do no harm. A lease with no handle
 * has nothing to revoke here; the provider's own expiry ends it.
 */
export function dueLeases(db: Executor, opts: { now?: Date; limit?: number } = {}) {
  return db
    .select()
    .from(secretLeases)
    .where(
      and(
        sql`${secretLeases.revokedAt} is null`,
        sql`${secretLeases.handle} is not null`,
        sql`${secretLeases.expiresAt} <= ${clock(opts.now)}`,
      ),
    )
    .orderBy(asc(secretLeases.expiresAt), asc(secretLeases.id))
    .limit(opts.limit ?? 100);
}
