import { MAX_POOLS } from "@orch/core";
import { and, asc, count, eq, gt } from "drizzle-orm";
import type { Executor, Page } from "./repo";
import { organizations, workerPools } from "./schema";

export type WorkerPool = typeof workerPools.$inferSelect;

export interface PoolInput {
  organizationId: string;
  name: string;
  tags: string[];
  image?: string | null | undefined;
  enabled?: boolean | undefined;
  isDefault?: boolean | undefined;
}
/** What may change: the name is the pool's identity in `stack.yml`, so it does not. */
export interface PoolPatch {
  tags?: string[] | undefined;
  /** `null` clears it. */
  image?: string | null | undefined;
  enabled?: boolean | undefined;
  isDefault?: boolean | undefined;
}

/**
 * Setters of one organization's pools take its row in turn, so the count and the swap of the default
 * are not a race. NO KEY UPDATE conflicts with itself and not with the key share a pool's foreign key
 * takes. The lock lasts as long as the transaction does: call these inside one.
 */
const lock = (db: Executor, organizationId: string) =>
  db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("no key update");

/** The organization's default stops being one, in the same transaction as the pool that takes its place. */
const demoteDefault = async (db: Executor, organizationId: string) =>
  (
    await db
      .update(workerPools)
      .set({ isDefault: false })
      .where(and(eq(workerPools.organizationId, organizationId), eq(workerPools.isDefault, true)))
      .returning()
  )[0];

/**
 * A new pool, or `undefined` when the organization already has `MAX_POOLS`. A pool made the default takes
 * it from the old one. A name in use, or a disabled default, is the table's refusal (a constraint error).
 */
export async function createPool(db: Executor, input: PoolInput): Promise<WorkerPool | undefined> {
  await lock(db, input.organizationId);
  const [have] = await db
    .select({ n: count() })
    .from(workerPools)
    .where(eq(workerPools.organizationId, input.organizationId));
  if ((have?.n ?? 0) >= MAX_POOLS) return undefined;
  if (input.isDefault) await demoteDefault(db, input.organizationId);
  const [row] = await db
    .insert(workerPools)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      tags: input.tags,
      image: input.image ?? null,
      enabled: input.enabled ?? true,
      isDefault: input.isDefault ?? false,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

/**
 * Changes what is given. `previous` is the pool as it was; `demoted` is the default it took the place of,
 * when it became the default. `undefined` when the organization has no such pool.
 */
export async function updatePool(
  db: Executor,
  organizationId: string,
  id: string,
  patch: PoolPatch,
): Promise<{ row: WorkerPool; previous: WorkerPool; demoted: WorkerPool | undefined } | undefined> {
  await lock(db, organizationId);
  const [previous] = await db
    .select()
    .from(workerPools)
    .where(inOrg(organizationId, id))
    .for("update");
  if (!previous) return undefined;
  const set = {
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.image !== undefined ? { image: patch.image } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
  };
  if (Object.keys(set).length === 0) return { row: previous, previous, demoted: undefined };
  const demoted =
    patch.isDefault === true && !previous.isDefault
      ? await demoteDefault(db, organizationId)
      : undefined;
  const [row] = await db.update(workerPools).set(set).where(inOrg(organizationId, id)).returning();
  if (!row) throw new Error("update returned no row");
  return { row, previous, demoted };
}

/**
 * Removes a pool. The default is not removed (`default`): with no default, the stacks that name no pool
 * would run on shared runners, so it is cleared first, as a decision. `undefined` when there is no such pool.
 */
export async function deletePool(
  db: Executor,
  organizationId: string,
  id: string,
): Promise<{ result: "deleted"; row: WorkerPool } | { result: "default" } | undefined> {
  await lock(db, organizationId);
  const [row] = await db.select().from(workerPools).where(inOrg(organizationId, id)).for("update");
  if (!row) return undefined;
  if (row.isDefault) return { result: "default" };
  await db.delete(workerPools).where(inOrg(organizationId, id));
  return { result: "deleted", row };
}

const inOrg = (organizationId: string, id: string) =>
  and(eq(workerPools.id, id), eq(workerPools.organizationId, organizationId));

export async function getPool(db: Executor, organizationId: string, id: string) {
  return (await db.select().from(workerPools).where(inOrg(organizationId, id)))[0];
}

export async function getPoolByName(db: Executor, organizationId: string, name: string) {
  return (
    await db
      .select()
      .from(workerPools)
      .where(and(eq(workerPools.organizationId, organizationId), eq(workerPools.name, name)))
  )[0];
}

/** Ordered by id (a v7 uuid: creation order to the millisecond, not a strict guarantee). */
export function listPools(db: Executor, organizationId: string, page: Page<string>) {
  return db
    .select()
    .from(workerPools)
    .where(
      and(
        eq(workerPools.organizationId, organizationId),
        page.after ? gt(workerPools.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(workerPools.id))
    .limit(page.limit);
}

/** Every pool of the organization (at most `MAX_POOLS`), for generating a pipeline. */
export const allPools = (db: Executor, organizationId: string) =>
  listPools(db, organizationId, { limit: MAX_POOLS });

export async function defaultPool(db: Executor, organizationId: string) {
  return (
    await db
      .select()
      .from(workerPools)
      .where(and(eq(workerPools.organizationId, organizationId), eq(workerPools.isDefault, true)))
  )[0];
}
