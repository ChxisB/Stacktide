import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { AuditRow } from "./audit-log";
import type { Executor } from "./repo";
import { auditEvents, auditForwards } from "./schema";

/** The queue of the schedule that hands the audit log to its sinks. */
export const AUDIT_FORWARD_QUEUE = "audit.forward";

/** Events in one hand-over. */
export const FORWARD_BATCH = 100;

/**
 * An event is handed over once its id is this old. Ids come from the clock of the process that wrote
 * the event, not from the order of commits, so an event with a lower id can commit after one with a
 * higher id; the cursor must not pass either until the slower one has had time to land.
 *
 * shortcut: a transaction that stays open longer than this after it wrote an event can still commit
 * it behind the cursor, and that event is never forwarded; raise the setting if that happens (the
 * audit writes of this platform are the last statements of short transactions).
 */
export const FORWARD_SETTLE_MS = 30_000;

/** Where a sink that is to hear of the whole log starts: before the first event. */
const START = "00000000-0000-0000-0000-000000000000";

/**
 * The highest id an event written at `t` can have: a v7 uuid begins with its 48-bit millisecond
 * clock, and the rest of this one is all ones, so every id from that millisecond or before is below it.
 */
export const idAt = (t: Date) => {
  const hex = t.getTime().toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-ffff-ffff-ffffffffffff`;
};

/** An unreachable sink is tried again after 30 s, then twice as long each time, at most an hour. */
export const forwardBackoffMs = (failures: number) =>
  Math.min(30_000 * 2 ** Math.max(0, failures - 1), 3_600_000);

export type Forwarding = typeof auditForwards.$inferSelect;

/** What a sink says of why it could not take a batch. It is stored and shown, so it is a fixed sentence and never carries an address or a response. */
export class ForwardFailure extends Error {}

/**
 * Starts (or finds) the forwarding of an organization's log to one of its sinks. `from: "now"` sends
 * what is written after this call; `"start"` the whole log still kept. Idempotent: an existing
 * forwarding keeps its place and `created` says no. A sink that is not the organization's fails the
 * `audit_forwards_sink_org_fk` foreign key.
 */
export async function enableForwarding(
  db: Executor,
  o: { organizationId: string; sinkId: string; from: "now" | "start"; now: Date },
): Promise<{ forwarding: Forwarding; created: boolean }> {
  const [inserted] = await db
    .insert(auditForwards)
    .values({
      sinkId: o.sinkId,
      organizationId: o.organizationId,
      cursor: o.from === "start" ? START : idAt(o.now),
      nextAttemptAt: o.now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { forwarding: inserted, created: true };
  const existing = await getForwarding(db, o.organizationId, o.sinkId);
  if (!existing) throw new Error("forwarding vanished while it was being enabled");
  return { forwarding: existing, created: false };
}

export async function getForwarding(db: Executor, organizationId: string, sinkId: string) {
  return (
    await db
      .select()
      .from(auditForwards)
      .where(
        and(eq(auditForwards.sinkId, sinkId), eq(auditForwards.organizationId, organizationId)),
      )
  )[0];
}

/** True when there was a forwarding to stop. */
export async function disableForwarding(db: Executor, organizationId: string, sinkId: string) {
  const rows = await db
    .delete(auditForwards)
    .where(and(eq(auditForwards.sinkId, sinkId), eq(auditForwards.organizationId, organizationId)))
    .returning({ sinkId: auditForwards.sinkId });
  return rows.length > 0;
}

/** Sinks whose turn it is, the longest waiting first. */
export async function dueForwards(db: Executor, now: Date, limit: number): Promise<string[]> {
  const rows = await db
    .select({ sinkId: auditForwards.sinkId })
    .from(auditForwards)
    .where(lte(auditForwards.nextAttemptAt, now))
    .orderBy(asc(auditForwards.nextAttemptAt), asc(auditForwards.sinkId))
    .limit(limit);
  return rows.map((r) => r.sinkId);
}

export type ForwardStep =
  | { result: "sent"; count: number }
  | { result: "idle" | "failed" | "skipped" };

/**
 * One hand-over to one sink: takes the forwarding's row (another worker that holds it, or a sink that
 * is not due, is skipped), reads the next events of the organization after the cursor, in id order, and
 * calls `send`. Only when `send` returns does the cursor move, in the same transaction, so a crash
 * between the sink taking the batch and this commit sends it again: delivery is at least once and a
 * receiver dedupes by event id. When `send` throws the cursor stays; the failure and the time of the
 * next try are recorded (the message only if it is a `ForwardFailure`).
 */
export async function forwardStep(
  db: Executor,
  o: {
    sinkId: string;
    now: Date;
    settleMs?: number;
    batch?: number;
    send: (f: Forwarding, events: AuditRow[]) => Promise<void>;
  },
): Promise<ForwardStep> {
  const { settleMs = FORWARD_SETTLE_MS, batch = FORWARD_BATCH } = o;
  return db.transaction(async (tx) => {
    const [f] = await tx
      .select()
      .from(auditForwards)
      .where(eq(auditForwards.sinkId, o.sinkId))
      .for("update", { skipLocked: true });
    if (!f || f.nextAttemptAt > o.now) return { result: "skipped" };
    const events = await tx
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, f.organizationId),
          gt(auditEvents.id, f.cursor),
          lte(auditEvents.id, idAt(new Date(o.now.getTime() - settleMs))),
        ),
      )
      .orderBy(asc(auditEvents.id))
      .limit(batch);
    const last = events.at(-1);
    if (!last) return { result: "idle" };
    try {
      await o.send(f, events);
    } catch (error) {
      const failures = f.failures + 1;
      await tx
        .update(auditForwards)
        .set({
          failures,
          lastError: error instanceof ForwardFailure ? error.message : "delivery failed",
          nextAttemptAt: new Date(o.now.getTime() + forwardBackoffMs(failures)),
        })
        .where(eq(auditForwards.sinkId, f.sinkId));
      return { result: "failed" };
    }
    await tx
      .update(auditForwards)
      .set({
        cursor: last.id,
        deliveredAt: o.now,
        failures: 0,
        lastError: null,
        nextAttemptAt: o.now,
      })
      .where(eq(auditForwards.sinkId, f.sinkId));
    return { result: "sent", count: events.length };
  });
}
