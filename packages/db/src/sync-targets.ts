import { and, asc, eq, gt } from "drizzle-orm";
import type { Executor, Page } from "./repo";
import { syncTargets } from "./schema";

export type SyncTarget = typeof syncTargets.$inferSelect;
export type NewSyncTarget = Pick<
  typeof syncTargets.$inferInsert,
  "organizationId" | "projectId" | "name" | "type" | "connectionId" | "config"
> &
  Partial<
    Pick<
      typeof syncTargets.$inferInsert,
      "environmentMapping" | "unmanagedPolicy" | "autoSync" | "autoRemediate"
    >
  >;

/** What a PATCH may change. The type is fixed for life: a different target is a different row. */
export interface SyncTargetPatch {
  name?: string;
  connectionId?: string;
  config?: Record<string, unknown>;
  environmentMapping?: Record<string, string>;
  unmanagedPolicy?: "ignore" | "adopt" | "prune";
  autoSync?: boolean;
  autoRemediate?: boolean;
}

/** Drops `undefined` entries; a patch is applied only for the fields that were given. */
const given = <T extends object>(patch: T) =>
  Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as T;

// Every lookup repeats the organization and the project, so an id from elsewhere matches nothing.
const targetIs = (organizationId: string, projectId: string, id: string) =>
  and(
    eq(syncTargets.id, id),
    eq(syncTargets.projectId, projectId),
    eq(syncTargets.organizationId, organizationId),
  );

export async function createSyncTarget(db: Executor, input: NewSyncTarget): Promise<SyncTarget> {
  const row = (await db.insert(syncTargets).values(input).returning())[0];
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function getSyncTarget(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
) {
  return (
    await db
      .select()
      .from(syncTargets)
      .where(targetIs(organizationId, projectId, id))
  )[0];
}

/** Ordered by id, which is time-ordered (v7): creation order. */
export function listSyncTargets(
  db: Executor,
  organizationId: string,
  projectId: string,
  page: Page<string>,
) {
  return db
    .select()
    .from(syncTargets)
    .where(
      and(
        eq(syncTargets.projectId, projectId),
        eq(syncTargets.organizationId, organizationId),
        page.after ? gt(syncTargets.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(syncTargets.id))
    .limit(page.limit);
}

/** The updated row, or undefined when there is none. */
export async function updateSyncTarget(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
  patch: SyncTargetPatch,
) {
  const set = given(patch);
  if (Object.keys(set).length === 0) return getSyncTarget(db, organizationId, projectId, id);
  const where = targetIs(organizationId, projectId, id);
  return (await db.update(syncTargets).set(set).where(where).returning())[0];
}

/** True when a row was deleted. */
export async function deleteSyncTarget(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
) {
  const where = targetIs(organizationId, projectId, id);
  return (await db.delete(syncTargets).where(where).returning()).length > 0;
}
