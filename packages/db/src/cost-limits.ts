import { and, asc, eq, gt } from "drizzle-orm";
import type { Executor, Page } from "./repo";
import { costLimits, organizations } from "./schema";

export type CostLimitRow = typeof costLimits.$inferSelect;
export type CostLimitInput = Pick<
  CostLimitRow,
  "organizationId" | "tag" | "maxMonthlyDelta" | "warnAt" | "currency"
>;

/** Limits an organization may have: every plan reads all of them, so the number is bounded where they are made. */
export const MAX_COST_LIMITS = 100;

/**
 * Sets the limit of a scope (the organization's own for no tag, else the tag's): a new one, or the
 * existing one replaced with its id kept. `previous` is what it replaced. `undefined` when the scope is
 * new and the organization already has `MAX_COST_LIMITS`. Setters of one organization take its row in
 * turn, so the count and the one-per-scope rule are not a race. Call it inside a transaction: the row
 * lock lasts as long as the transaction does.
 */
export async function setCostLimit(
  db: Executor,
  input: CostLimitInput,
): Promise<{ row: CostLimitRow; previous: CostLimitRow | undefined } | undefined> {
  // NO KEY UPDATE conflicts with itself and not with the key share a limit's foreign key takes
  await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for("no key update");
  const have = await db
    .select()
    .from(costLimits)
    .where(eq(costLimits.organizationId, input.organizationId))
    .limit(MAX_COST_LIMITS);
  const previous = have.find((l) => l.tag === input.tag);
  if (previous) {
    const [row] = await db
      .update(costLimits)
      .set({
        maxMonthlyDelta: input.maxMonthlyDelta,
        warnAt: input.warnAt,
        currency: input.currency,
      })
      .where(eq(costLimits.id, previous.id))
      .returning();
    if (!row) throw new Error("update returned no row");
    return { row, previous };
  }
  if (have.length >= MAX_COST_LIMITS) return undefined;
  const [row] = await db.insert(costLimits).values(input).returning();
  if (!row) throw new Error("insert returned no row");
  return { row, previous: undefined };
}

const inOrg = (organizationId: string, id: string) =>
  and(eq(costLimits.id, id), eq(costLimits.organizationId, organizationId));

export async function getCostLimit(db: Executor, organizationId: string, id: string) {
  return (await db.select().from(costLimits).where(inOrg(organizationId, id)))[0];
}

/** Ordered by id (a v7 uuid: creation order to the millisecond, not a strict guarantee). */
export function listCostLimits(db: Executor, organizationId: string, page: Page<string>) {
  return db
    .select()
    .from(costLimits)
    .where(
      and(
        eq(costLimits.organizationId, organizationId),
        page.after ? gt(costLimits.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(costLimits.id))
    .limit(page.limit);
}

/** Every limit of the organization (at most `MAX_COST_LIMITS`), for judging a plan. */
export const allCostLimits = (db: Executor, organizationId: string) =>
  listCostLimits(db, organizationId, { limit: MAX_COST_LIMITS });

/**
 * The row that was deleted, or `undefined` when there was none. Limits are read when a plan is applied or
 * shown, not when it was made, so deleting one frees the plans it held.
 */
export async function deleteCostLimit(db: Executor, organizationId: string, id: string) {
  return (await db.delete(costLimits).where(inOrg(organizationId, id)).returning())[0];
}
