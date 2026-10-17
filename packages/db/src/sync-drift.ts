import { and, asc, eq, gt } from "drizzle-orm";
import { enqueueOnce } from "./jobs";
import type { Executor } from "./repo";
import { syncDrift, syncRuns, syncTargets } from "./schema";

export type SyncDrift = typeof syncDrift.$inferSelect;
export type DriftStatus = "in_sync" | "drifted";

/** The recurring job that asks for a check of every target, and the job that checks one. */
export const DRIFT_TICK_QUEUE = "sync.drift.tick";
export const DRIFT_CHECK_QUEUE = "sync.drift";

const PAGE = 500;

export type TargetRef = { id: string; organizationId: string; projectId: string };

/** What the last check found, or undefined when the target has not been checked. */
export async function getSyncDrift(
  db: Executor,
  organizationId: string,
  projectId: string,
  targetId: string,
) {
  return (
    await db
      .select()
      .from(syncDrift)
      .where(
        and(
          eq(syncDrift.targetId, targetId),
          eq(syncDrift.projectId, projectId),
          eq(syncDrift.organizationId, organizationId),
        ),
      )
  )[0];
}

/** Replaces the observation of a target; returns the status it had before, if any. */
export function recordDrift(
  db: Executor,
  t: TargetRef,
  status: DriftStatus,
  counts: Record<string, number>,
): Promise<DriftStatus | undefined> {
  return db.transaction(async (tx) => {
    const here = and(
      eq(syncDrift.targetId, t.id),
      eq(syncDrift.projectId, t.projectId),
      eq(syncDrift.organizationId, t.organizationId),
    );
    const before = (await tx.select({ status: syncDrift.status }).from(syncDrift).where(here))[0];
    const written = await tx
      .insert(syncDrift)
      .values({ ...t, targetId: t.id, status, counts })
      .onConflictDoUpdate({
        target: syncDrift.targetId,
        set: { status, counts },
        // a row of the target elsewhere is not ours to replace
        setWhere: here,
      })
      .returning({ id: syncDrift.targetId });
    if (written.length === 0) throw new Error("the target is not in that organization and project");
    return before?.status as DriftStatus | undefined;
  });
}

/** True while an apply is running on the target: what it is changing is not drift. */
export async function isApplying(db: Executor, targetId: string) {
  const rows = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(eq(syncRuns.targetId, targetId), eq(syncRuns.status, "applying")))
    .limit(1);
  return rows.length > 0;
}

/**
 * Asks for a check of every target (SYNC-8), unless one is already waiting for it, so a backlog
 * does not grow when workers fall behind. The jobs hold ids only. Returns how many were asked for.
 * shortcut: one INSERT per target, in pages of ids; batch them when the targets number thousands.
 */
export async function queueDriftChecks(db: Executor, pageSize = PAGE): Promise<number> {
  let after: string | undefined;
  let queued = 0;
  for (;;) {
    const page = await db
      .select({
        id: syncTargets.id,
        organizationId: syncTargets.organizationId,
        projectId: syncTargets.projectId,
      })
      .from(syncTargets)
      .where(after ? gt(syncTargets.id, after) : undefined)
      .orderBy(asc(syncTargets.id))
      .limit(pageSize);
    for (const t of page) {
      const job = await enqueueOnce(db, {
        queue: DRIFT_CHECK_QUEUE,
        payload: { organizationId: t.organizationId, projectId: t.projectId, targetId: t.id },
        dedupeKey: t.id,
      });
      if (job) queued++;
    }
    const last = page.at(-1);
    if (page.length < pageSize || !last) return queued;
    after = last.id;
  }
}
