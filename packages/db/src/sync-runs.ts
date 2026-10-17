import { and, asc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { jobs, syncRunItems, syncRuns } from "./schema";

export type SyncRun = typeof syncRuns.$inferSelect;
export type SyncRunItem = Pick<
  typeof syncRunItems.$inferSelect,
  "key" | "scope" | "action" | "changed"
>;
/** A line as an apply sees it: where it is, and what has been done to it. */
export type SyncRunLine = SyncRunItem &
  Pick<typeof syncRunItems.$inferSelect, "position" | "result" | "error">;
export type NewSyncRun = Pick<
  typeof syncRuns.$inferInsert,
  "organizationId" | "projectId" | "targetId" | "expiresAt" | "desiredDigest" | "counts" | "skipped"
>;

/** Lines per INSERT: each binds several values, and one statement takes 65,535 of them. */
const CHUNK = 1000;

/** A plan and its lines, in the order given (which is the plan's). Keys, scopes and actions: no value. */
export async function createSyncRun(
  db: Executor,
  input: NewSyncRun,
  items: readonly SyncRunItem[],
): Promise<SyncRun> {
  const run = (await db.insert(syncRuns).values(input).returning())[0];
  if (!run) throw new Error("insert returned no row");
  for (let from = 0; from < items.length; from += CHUNK) {
    await db
      .insert(syncRunItems)
      .values(
        items
          .slice(from, from + CHUNK)
          .map((item, i) => ({ ...item, runId: run.id, position: from + i })),
      );
  }
  return run;
}

// Every lookup repeats the organization, project and target, so an id from elsewhere matches nothing.
export async function getSyncRun(
  db: Executor,
  organizationId: string,
  projectId: string,
  targetId: string,
  id: string,
) {
  return (
    await db
      .select()
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.id, id),
          eq(syncRuns.targetId, targetId),
          eq(syncRuns.projectId, projectId),
          eq(syncRuns.organizationId, organizationId),
        ),
      )
  )[0];
}

/** All lines of a run, in plan order. A plan is as long as the target's variables, not unbounded. */
export function listSyncRunItems(db: Executor, runId: string): Promise<SyncRunLine[]> {
  return db
    .select({
      position: syncRunItems.position,
      key: syncRunItems.key,
      scope: syncRunItems.scope,
      action: syncRunItems.action,
      changed: syncRunItems.changed,
      result: syncRunItems.result,
      error: syncRunItems.error,
    })
    .from(syncRunItems)
    .where(eq(syncRunItems.runId, runId))
    .orderBy(asc(syncRunItems.position));
}

const inTarget = (organizationId: string, projectId: string, targetId: string) =>
  and(
    eq(syncRuns.targetId, targetId),
    eq(syncRuns.projectId, projectId),
    eq(syncRuns.organizationId, organizationId),
  );

/**
 * `planned` -> `applying`, for the job that will do it: only a plan that is still planned and not
 * expired (by the database clock). Undefined when it is not. A target already being applied violates
 * `sync_runs_one_applying`: that is the mutex, and the caller maps it.
 */
export async function claimSyncRun(
  db: Executor,
  organizationId: string,
  projectId: string,
  targetId: string,
  id: string,
  jobId: string,
) {
  const where = and(
    eq(syncRuns.id, id),
    inTarget(organizationId, projectId, targetId),
    eq(syncRuns.status, "planned"),
    gt(syncRuns.expiresAt, sql`now()`),
  );
  return (await db.update(syncRuns).set({ status: "applying", jobId }).where(where).returning())[0];
}

/** An apply that has made no progress for this long is given up on. */
const STUCK_APPLY_MS = 60 * 60_000;

/**
 * Ends the applies of a target that cannot finish, so none blocks it forever: the job is dead (the
 * queue gave up, or the worker was lost for good), or it has been `applying` for `stuckMs` (no
 * worker serves the queue, or the job row is gone). A late job finds the run ended and does nothing.
 * Returns the ids it ended, so the caller can say so in the audit log.
 */
export async function failStuckApplies(
  db: Executor,
  organizationId: string,
  projectId: string,
  targetId: string,
  stuckMs = STUCK_APPLY_MS,
) {
  const dead = db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, "dead"));
  const ended = await db
    .update(syncRuns)
    .set({ status: "failed", error: "the apply did not finish: its job died or was never taken" })
    .where(
      and(
        inTarget(organizationId, projectId, targetId),
        eq(syncRuns.status, "applying"),
        or(
          inArray(syncRuns.jobId, dead),
          lt(syncRuns.updatedAt, sql`now() - ${stuckMs} * interval '1 millisecond'`),
        ),
      ),
    )
    .returning({ id: syncRuns.id });
  return ended.map((r) => r.id);
}

/** What an apply did to one line. `error` is fixed words. */
export async function recordSyncItem(
  db: Executor,
  runId: string,
  position: number,
  outcome: { result: "applied" | "failed" | null; error: string | null },
) {
  await db
    .update(syncRunItems)
    .set(outcome)
    .where(and(eq(syncRunItems.runId, runId), eq(syncRunItems.position, position)));
}

/** `applying` -> `applied` or `failed`. Undefined when the run was not applying (it is done once). */
export async function finishSyncRun(
  db: Executor,
  runId: string,
  outcome: { status: "applied" | "failed"; error?: string },
) {
  const where = and(eq(syncRuns.id, runId), eq(syncRuns.status, "applying"));
  const set = { status: outcome.status, error: outcome.error ?? null };
  return (await db.update(syncRuns).set(set).where(where).returning())[0];
}
