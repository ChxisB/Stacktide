import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "./repo";
import { syncRunItems, syncRuns } from "./schema";

export type SyncRun = typeof syncRuns.$inferSelect;
export type SyncRunItem = Pick<
  typeof syncRunItems.$inferSelect,
  "key" | "scope" | "action" | "changed"
>;
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
export function listSyncRunItems(db: Executor, runId: string): Promise<SyncRunItem[]> {
  return db
    .select({
      key: syncRunItems.key,
      scope: syncRunItems.scope,
      action: syncRunItems.action,
      changed: syncRunItems.changed,
    })
    .from(syncRunItems)
    .where(eq(syncRunItems.runId, runId))
    .orderBy(asc(syncRunItems.position));
}
