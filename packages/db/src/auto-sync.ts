import { and, eq } from "drizzle-orm";
import { enqueueOnce } from "./jobs";
import type { Executor } from "./repo";
import { syncTargets } from "./schema";
import type { Owner } from "./variables";

export const AUTO_SYNC_QUEUE = "sync.auto";
/** Time from the first change of a burst to its sync. shortcut: a timer from the first change, not a sliding debounce, so a steady trickle still syncs within this. */
export const AUTO_SYNC_DELAY_MS = 30_000;

/**
 * A variable changed at `owner`'s level (SYNC-7): every auto-sync target it can reach gets a job,
 * unless one is already waiting, so a burst of changes makes one run. Runs in the change's
 * transaction, so the job exists exactly when the change does. An organization's variables reach
 * all of its targets, a project's (and its environments') only the project's. The job holds ids; it
 * reads the variables when it runs.
 */
export async function queueAutoSync(db: Executor, owner: Owner): Promise<void> {
  const targets = await db
    .select({
      id: syncTargets.id,
      organizationId: syncTargets.organizationId,
      projectId: syncTargets.projectId,
    })
    .from(syncTargets)
    .where(
      and(
        eq(syncTargets.organizationId, owner.organizationId),
        owner.projectId ? eq(syncTargets.projectId, owner.projectId) : undefined,
        eq(syncTargets.autoSync, true),
      ),
    );
  for (const t of targets) await queueTargetSync(db, t);
}

/**
 * One target is to be synced soon, unless a job already waits for it.
 * shortcut: the delay is counted on this host's clock (a skewed host shifts it by the skew), and a change in a bulk edit, import or restore asks once per variable; add a per-transaction memo if that shows up.
 */
export async function queueTargetSync(
  db: Executor,
  t: { id: string; organizationId: string; projectId: string },
  /** The job is to put right drift (SYNC-8), which a target that is not `auto_sync` may also want. */
  remediate = false,
): Promise<void> {
  await enqueueOnce(db, {
    queue: AUTO_SYNC_QUEUE,
    payload: {
      organizationId: t.organizationId,
      projectId: t.projectId,
      targetId: t.id,
      ...(remediate && { remediate }),
    },
    runAt: new Date(Date.now() + AUTO_SYNC_DELAY_MS),
    dedupeKey: t.id,
  });
}
