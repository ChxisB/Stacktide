import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { stateLocks } from "./schema";
import type { StateRef } from "./state";

type Row = typeof stateLocks.$inferSelect;
/** A held lock as callers see it: who holds it, until when, and Terraform's lock info as the holder sent it. */
export type StateLock = Pick<Row, "lockId" | "owner" | "info" | "expiresAt" | "createdAt">;

const shown = {
  lockId: stateLocks.lockId,
  owner: stateLocks.owner,
  info: stateLocks.info,
  expiresAt: stateLocks.expiresAt,
  createdAt: stateLocks.createdAt,
};
const inStack = (ref: StateRef) =>
  and(
    eq(stateLocks.organizationId, ref.organizationId),
    eq(stateLocks.projectId, ref.projectId),
    eq(stateLocks.stackName, ref.stackName),
  );
// the database's clock, like every other expiry here
const ended = sql`now()`;

/**
 * Whatever changes a stack's lock or its state takes turns first, so a lock is read next to the write it holds off.
 * Held until the transaction ends: callers are inside one.
 */
export const takeTurn = (db: Executor, ref: StateRef) =>
  db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`state:${ref.projectId}:${ref.stackName}`}, 0))`,
  );

/** The lock on the stack, if one is held: a lock whose time is up is not. Call inside a transaction that has the turn. */
const heldNow = async (tx: Executor, ref: StateRef): Promise<StateLock | undefined> => {
  const [held] = await tx
    .select(shown)
    .from(stateLocks)
    .where(and(inStack(ref), gt(stateLocks.expiresAt, ended)));
  return held;
};

export type LockResult = { ok: true; lock: StateLock } | { ok: false; held: StateLock };

/**
 * Takes the stack's lock for `owner` until `expiresAt` (the end of the owner's token). Refused, with the holder's lock
 * and nothing written, when another lock is held. The holder asking again with the lock's own id is a retry (Terraform
 * does this when an answer is lost): accepted, nothing changed. A lock whose time is up is replaced.
 */
export function lockState(
  db: Executor,
  ref: StateRef,
  input: { lockId: string; owner: string; expiresAt: Date; info: Record<string, string> },
): Promise<LockResult> {
  const { lockId, owner, expiresAt, info } = input;
  return db.transaction(async (tx) => {
    await takeTurn(tx, ref);
    await tx.delete(stateLocks).where(and(inStack(ref), lte(stateLocks.expiresAt, ended)));
    const held = await heldNow(tx, ref);
    if (held) {
      return held.owner === owner && held.lockId === lockId
        ? { ok: true, lock: held }
        : { ok: false, held };
    }
    const [lock] = await tx
      .insert(stateLocks)
      .values({ ...ref, lockId, owner, info, expiresAt })
      .returning(shown);
    if (!lock) throw new Error("insert returned no row");
    return { ok: true, lock };
  });
}

export type UnlockResult = { ok: true; released: boolean } | { ok: false; held: StateLock };

/**
 * Releases the lock for the job that holds it, naming its id: the owner alone is not enough, and neither is the id
 * (it is shown to whoever is refused). Releasing what is not held is accepted: Terraform may unlock after the lock
 * ended with its token.
 */
export function unlockState(
  db: Executor,
  ref: StateRef,
  who: { lockId: string; owner: string },
): Promise<UnlockResult> {
  return db.transaction(async (tx) => {
    await takeTurn(tx, ref);
    const held = await heldNow(tx, ref);
    if (!held) return { ok: true, released: false };
    if (held.owner !== who.owner || held.lockId !== who.lockId) return { ok: false, held };
    await tx.delete(stateLocks).where(inStack(ref));
    return { ok: true, released: true };
  });
}

/** An organization admin's release: whatever lock the stack has goes, and it comes back so the audit can say whose it was. */
export function forceUnlock(db: Executor, ref: StateRef): Promise<StateLock | undefined> {
  return db.transaction(async (tx) => {
    await takeTurn(tx, ref);
    const [gone] = await tx.delete(stateLocks).where(inStack(ref)).returning(shown);
    return gone;
  });
}

/**
 * The lock that holds this writer off, if any: a lock held by another owner, or by this owner under another id.
 * `lockId` left out means any id of the owner's will do. Takes the turn, so call it in the writer's own transaction:
 * the lock cannot change before the write commits.
 */
export function blockedBy(
  db: Executor,
  ref: StateRef,
  who: { owner: string; lockId?: string },
): Promise<StateLock | undefined> {
  return db.transaction(async (tx) => {
    await takeTurn(tx, ref);
    const held = await heldNow(tx, ref);
    if (!held) return undefined;
    const mine =
      held.owner === who.owner && (who.lockId === undefined || held.lockId === who.lockId);
    return mine ? undefined : held;
  });
}
