import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Executor, Page } from "./repo";
import { environments, type RotationStatus, variableRotations, variables } from "./schema";

export type Rotation = typeof variableRotations.$inferSelect;

/** The schedule's job: revokes what is due, then rotates what is due. */
export const ROTATION_TICK_QUEUE = "rotation.tick";

/** How long a claim holds a due rotation before another worker may take it, if the first one dies. */
export const ROTATION_LEASE_MS = 900_000;

const clock = (now?: Date) => (now ? sql`${now.toISOString()}::timestamptz` : sql`now()`);
/**
 * A lease: `at` plus `ms`, cut to whole milliseconds. The claim is held up by comparing `next_at`
 * with the value handed to the claimant as a JS date, which cannot carry the database clock's
 * microseconds: left uncut, no claim made on that clock would ever match its own row.
 */
const leaseUntil = (at: ReturnType<typeof clock>, ms: number) =>
  sql`date_trunc('milliseconds', ${at} + make_interval(secs => ${ms / 1000}))`;

export interface RotationInput {
  organizationId: string;
  variableId: string;
  provider: string;
  /** Ids and settings the provider needs, never a secret. */
  config: Record<string, unknown>;
  intervalDays: number;
  graceDays: number;
  enabled?: boolean;
  /** Test seam. Left out, the database clock decides. */
  now?: Date;
}

/**
 * Sets how a variable rotates: a new rotation (first due one interval from now), or the existing one
 * changed with its history kept; a changed interval starts counting from now, an unchanged one keeps
 * its place. `not_found` for a variable that is not live in that organization, `not_secret` for one
 * that is not a secret (a rotated value is a credential and must be sealed and masked like one).
 * Out-of-range numbers and a malformed provider or config fail the table's checks (23514). Call it
 * inside the transaction that audits it.
 *
 * `check` sees the rotation as it is (undefined for a new one) once the variable is held, and
 * throws to refuse the change: held, no rotation can finish in between and give it a replaced
 * credential the change would lose track of (a rotation's write of its version needs the same row).
 * It may return the config to store in place of `input.config`: a caller that keeps the stored config
 * must read it here, not before, or it could put back what a rotation has since moved on from.
 */
export async function setRotation(
  db: Executor,
  input: RotationInput,
  check?: (existing: Rotation | undefined) => Record<string, unknown> | undefined,
): Promise<{ row: Rotation } | { error: "not_found" | "not_secret" }> {
  // Taking the variable's row serializes this with its deletion, so no rotation outlives it.
  const [variable] = await db
    .select({ kind: variables.kind })
    .from(variables)
    .where(
      and(
        eq(variables.id, input.variableId),
        eq(variables.organizationId, input.organizationId),
        sql`${variables.deletedAt} is null`,
      ),
    )
    .for("no key update");
  if (!variable) return { error: "not_found" };
  if (variable.kind !== "secret") return { error: "not_secret" };
  const prior = await getRotation(db, input.organizationId, input.variableId);
  const config = (check ? check(prior) : undefined) ?? input.config;
  const at = clock(input.now);
  const due = sql`${at} + make_interval(days => ${input.intervalDays})`;
  const enabled = input.enabled ?? true;
  // a person who fixes what was failing wants it tried again now, with the count started over
  const retry =
    prior !== undefined &&
    (prior.attempts > 0 || prior.lastStatus === "failing") &&
    (prior.provider !== input.provider || !Bun.deepEquals(prior.config, config));
  // one switched back on counts its interval from now, not from when it was last due
  const resumed = prior !== undefined && !prior.enabled && enabled;
  const [row] = await db
    .insert(variableRotations)
    .values({
      organizationId: input.organizationId,
      variableId: input.variableId,
      provider: input.provider,
      config,
      intervalDays: input.intervalDays,
      graceDays: input.graceDays,
      enabled,
      nextAt: due,
    })
    .onConflictDoUpdate({
      target: variableRotations.variableId,
      set: {
        provider: input.provider,
        config,
        intervalDays: input.intervalDays,
        graceDays: input.graceDays,
        enabled,
        // an unchanged interval keeps its place; a changed one counts from now
        nextAt: retry
          ? at
          : resumed
            ? due
            : sql`case when ${variableRotations.intervalDays} = ${input.intervalDays}
          then ${variableRotations.nextAt} else ${due} end`,
        ...(retry && { attempts: 0, lastError: null, lastStatus: "never" as const }),
        // a changed provider does not inherit another provider's credential names
        handle: sql`case when ${variableRotations.provider} = ${input.provider}
          then ${variableRotations.handle} else null end`,
      },
    })
    .returning();
  if (!row) throw new Error("upsert returned no row");
  return { row };
}

export async function getRotation(db: Executor, organizationId: string, variableId: string) {
  return (
    await db
      .select()
      .from(variableRotations)
      .where(
        and(
          eq(variableRotations.organizationId, organizationId),
          eq(variableRotations.variableId, variableId),
        ),
      )
  )[0];
}

/** Ordered by id (a v7 uuid: creation order to the millisecond, not a strict guarantee). */
export function listRotations(db: Executor, organizationId: string, page: Page<string>) {
  return db
    .select()
    .from(variableRotations)
    .where(
      and(
        eq(variableRotations.organizationId, organizationId),
        page.after ? gt(variableRotations.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(variableRotations.id))
    .limit(page.limit);
}

/**
 * Removes the rotation of a variable. A rotation whose replaced credential is still valid
 * (`previous_handle`) stays, so nothing forgets the name of a live credential: `revoke_pending`.
 * (Deleting the variable has its own rule, `dropRotationOf`.)
 */
export async function removeRotation(
  db: Executor,
  organizationId: string,
  variableId: string,
): Promise<"removed" | "revoke_pending" | "none"> {
  const rows = await db
    .delete(variableRotations)
    .where(
      and(
        eq(variableRotations.organizationId, organizationId),
        eq(variableRotations.variableId, variableId),
        sql`${variableRotations.previousHandle} is null`,
      ),
    )
    .returning({ id: variableRotations.id });
  if (rows.length === 1) return "removed";
  return (await getRotation(db, organizationId, variableId)) ? "revoke_pending" : "none";
}

/**
 * What deleting a variable does to its rotation: a rotation with no credential at the provider is
 * deleted. The variable's current credential (`handle`) is handed to the revoke sweep as the one to
 * revoke now, and a replaced one still valid (`previous_handle`) waits for its time; either way the
 * rotation is switched off and kept until the sweep has revoked them (`clearRevoked` then deletes it),
 * so deleting the variable cannot leave a live credential behind with nothing that knows its name.
 * shortcut: a rotation with both a current and a replaced credential (a provider with a grace period
 * that mints outside: none yet) revokes the replaced one and forgets the current, which ends at its
 * provider's own expiry; upgrade when such a provider arrives.
 */
export async function dropRotationOf(db: Executor, variableId: string) {
  await db
    .delete(variableRotations)
    .where(
      and(
        eq(variableRotations.variableId, variableId),
        sql`${variableRotations.previousHandle} is null`,
        sql`${variableRotations.handle} is null`,
      ),
    );
  await db
    .update(variableRotations)
    .set({ previousHandle: variableRotations.handle, handle: null, revokeAt: sql`now()` })
    .where(
      and(
        eq(variableRotations.variableId, variableId),
        sql`${variableRotations.previousHandle} is null`,
        sql`${variableRotations.handle} is not null`,
      ),
    );
  await db
    .update(variableRotations)
    .set({ enabled: false })
    .where(eq(variableRotations.variableId, variableId));
}

/**
 * Takes up to `limit` rotations that are due, oldest first, for the caller to rotate. Each is pushed
 * out by `leaseMs`, so a worker that dies leaves it to be tried again later and two workers never get
 * the same one (`FOR UPDATE SKIP LOCKED`, and the update re-checks that the row is still due).
 * Rotations of deleted variables are never handed out. The returned `nextAt` is the lease: pass the
 * row to `completeRotation` or `failRotation`, which only act while it is still the row's `next_at`.
 */
export async function claimDue(
  db: Executor,
  opts: { now?: Date; limit?: number; leaseMs?: number } = {},
): Promise<Rotation[]> {
  const { limit = 10, leaseMs = ROTATION_LEASE_MS } = opts;
  if (limit < 1) return [];
  const at = clock(opts.now);
  const picked = db
    .select({ id: variableRotations.id })
    .from(variableRotations)
    .innerJoin(variables, eq(variables.id, variableRotations.variableId))
    .where(
      and(
        eq(variableRotations.enabled, true),
        sql`${variableRotations.nextAt} <= ${at}`,
        sql`${variables.deletedAt} is null`,
      ),
    )
    .orderBy(asc(variableRotations.nextAt), asc(variableRotations.id))
    .limit(limit)
    .for("update", { of: variableRotations, skipLocked: true });
  // ARRAY(subquery) is evaluated once: `id IN (subquery)` may be re-run and lock more than `limit`.
  const rows = await db
    .update(variableRotations)
    .set({ nextAt: leaseUntil(at, leaseMs) })
    .where(
      and(
        sql`${variableRotations.id} = any(array(${picked}))`,
        sql`${variableRotations.nextAt} <= ${at}`,
      ),
    )
    .returning();
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Takes one rotation now, due or not, for "rotate now": the lease and the fence of `claimDue`, so a
 * worker that is rotating it loses its claim and exactly one run finishes. A disabled rotation is
 * taken too (a person asked). Undefined when the variable has no rotation here or is deleted.
 */
export async function claimOne(
  db: Executor,
  organizationId: string,
  variableId: string,
  opts: { now?: Date; leaseMs?: number } = {},
): Promise<Rotation | undefined> {
  const [row] = await db
    .update(variableRotations)
    .set({ nextAt: leaseUntil(clock(opts.now), opts.leaseMs ?? ROTATION_LEASE_MS) })
    .where(
      and(
        eq(variableRotations.organizationId, organizationId),
        eq(variableRotations.variableId, variableId),
        sql`exists (select 1 from ${variables} where ${variables.id} = ${variableRotations.variableId} and ${variables.deletedAt} is null)`,
      ),
    )
    .returning();
  return row;
}

/**
 * Rotations whose replaced credential is past its grace and still valid, longest overdue first.
 * Nothing is claimed: revoking is idempotent and `clearRevoked` only acts on the handle it saw, so
 * two workers at once do no harm.
 */
export function dueRevocations(db: Executor, opts: { now?: Date; limit?: number } = {}) {
  return db
    .select()
    .from(variableRotations)
    .where(
      and(
        sql`${variableRotations.previousHandle} is not null`,
        sql`${variableRotations.revokeAt} <= ${clock(opts.now)}`,
      ),
    )
    .orderBy(asc(variableRotations.revokeAt), asc(variableRotations.id))
    .limit(opts.limit ?? 100);
}

/** What a rotation needs to know about its variable: where it is and whether its environment is protected. */
export interface RotationSubject {
  key: string;
  projectId: string | null;
  environmentId: string | null;
  protected: boolean;
}

/** The live variable of a rotation, undefined when it is gone. Only an environment can be protected. */
export async function rotationSubject(
  db: Executor,
  organizationId: string,
  variableId: string,
): Promise<RotationSubject | undefined> {
  const [row] = await db
    .select({
      key: variables.key,
      projectId: variables.projectId,
      environmentId: variables.environmentId,
      protected: sql<boolean>`coalesce(${environments.protected}, false)`,
    })
    .from(variables)
    .leftJoin(environments, eq(environments.id, variables.environmentId))
    .where(
      and(
        eq(variables.id, variableId),
        eq(variables.organizationId, organizationId),
        sql`${variables.deletedAt} is null`,
      ),
    );
  return row;
}

/**
 * Forgets a replaced credential once it is revoked, and the rotation with it when its variable is gone
 * and nothing is left to revoke. False when it was already cleared or has changed.
 */
export async function clearRevoked(db: Executor, rotationId: string, previousHandle: string) {
  const rows = await db
    .update(variableRotations)
    .set({ previousHandle: null, revokeAt: null })
    .where(
      and(
        eq(variableRotations.id, rotationId),
        eq(variableRotations.previousHandle, previousHandle),
      ),
    )
    .returning({ id: variableRotations.id });
  await db.delete(variableRotations).where(
    and(
      eq(variableRotations.id, rotationId),
      eq(variableRotations.enabled, false),
      sql`${variableRotations.handle} is null`,
      sql`${variableRotations.previousHandle} is null`,
      sql`not exists (select 1 from ${variables} where ${variables.id} = ${variableRotations.variableId}
        and ${variables.deletedAt} is null)`,
    ),
  );
  return rows.length === 1;
}

/** The claim still stands: nobody has taken this rotation since `claimed` was handed out. */
const held = (claimed: Rotation) =>
  and(eq(variableRotations.id, claimed.id), eq(variableRotations.nextAt, claimed.nextAt));

export interface Completed {
  /** What the provider minted: the credential that is now live (null for a provider with none). */
  handle: string | null;
  /** The config for the next rotation, if the provider changed it. */
  config?: Record<string, unknown>;
  /** The credential this rotation replaced, to revoke at `revokeAt` (both, or neither). */
  previousHandle?: string | null;
  revokeAt?: Date | null;
  status?: RotationStatus;
  now?: Date;
}

/** Records a rotation that happened and sets the next one. False when the claim was lost. */
export async function completeRotation(db: Executor, claimed: Rotation, done: Completed) {
  const at = clock(done.now);
  const rows = await db
    .update(variableRotations)
    .set({
      handle: done.handle,
      ...(done.config !== undefined && { config: done.config }),
      // left alone unless the caller says: a cycle that only records "waiting" must not forget a credential still to revoke
      ...(done.previousHandle !== undefined && {
        previousHandle: done.previousHandle,
        revokeAt: done.revokeAt ?? null,
      }),
      lastAt: at,
      lastStatus: done.status ?? "ok",
      lastError: null,
      attempts: 0,
      nextAt: sql`${at} + make_interval(days => ${claimed.intervalDays})`,
    })
    .where(held(claimed))
    .returning({ id: variableRotations.id });
  return rows.length === 1;
}

/**
 * Moves a rotation on to a credential minted for it when the write that was to record it failed, for a
 * provider whose minting ended the old one: the old handle and config name something that no longer
 * exists. True when the rotation now names `next.handle` (it did already, or this did it); false when it
 * is gone or has moved on to something else.
 */
export async function advanceRotation(
  db: Executor,
  claimed: Rotation,
  next: { handle: string; config?: Record<string, unknown> },
) {
  const rows = await db
    .update(variableRotations)
    .set({ handle: next.handle, ...(next.config !== undefined && { config: next.config }) })
    .where(
      and(
        eq(variableRotations.id, claimed.id),
        sql`(${variableRotations.handle} is not distinct from ${claimed.handle} or ${variableRotations.handle} = ${next.handle})`,
      ),
    )
    .returning({ id: variableRotations.id });
  return rows.length === 1;
}

/**
 * Records a failed attempt: the old value stays live, the rotation is tried again at `retryAt`, and
 * `code` (a short word, never the provider's text) says why. False when the claim was lost.
 */
export async function failRotation(
  db: Executor,
  claimed: Rotation,
  fail: { code: string; retryAt: Date; failing: boolean; now?: Date },
) {
  const rows = await db
    .update(variableRotations)
    .set({
      lastAt: clock(fail.now),
      lastStatus: fail.failing ? "failing" : claimed.lastStatus,
      lastError: fail.code,
      attempts: sql`${variableRotations.attempts} + 1`,
      nextAt: fail.retryAt,
    })
    .where(held(claimed))
    .returning({ id: variableRotations.id });
  return rows.length === 1;
}
