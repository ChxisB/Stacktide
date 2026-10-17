import { nextCronRun, parseCron } from "@orch/core";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { enqueue, JobError, jobPayload, jobQueue } from "./jobs";
import type { Executor } from "./repo";
import { schedules } from "./schema";

export type Schedule = typeof schedules.$inferSelect;

const NAME = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const MAX_INTERVAL_SECONDS = 366 * 86_400;

export interface ScheduleInput {
  /** Identifies the schedule: registering the same name again updates it. */
  name: string;
  /** Five-field cron, UTC. Exactly one of `cron` and `intervalSeconds`. */
  cron?: string;
  intervalSeconds?: number;
  queue: string;
  /** Ids and parameters, never values (the rule for every job payload). */
  payload?: Record<string, unknown>;
  enabled?: boolean;
  /** Test seam. Left out, the database clock decides. */
  now?: Date;
}

async function dbNow(db: Executor): Promise<Date> {
  const [row] = await db.execute<{ now: Date | string }>(sql`select now() as now`);
  if (!row) throw new Error("now() returned no row");
  return new Date(row.now);
}

/** The first run strictly after `now`; an interval schedule keeps to the grid its due time set. */
function nextRun(s: Pick<Schedule, "cron" | "intervalSeconds" | "nextRunAt">, now: Date): Date {
  if (s.cron !== null) return nextCronRun(s.cron, now);
  if (s.intervalSeconds === null) throw new Error("schedule has neither cron nor interval");
  const step = s.intervalSeconds * 1000;
  const missed = Math.max(0, Math.floor((now.getTime() - s.nextRunAt.getTime()) / step));
  return new Date(s.nextRunAt.getTime() + (missed + 1) * step);
}

/**
 * Creates or updates a schedule by name. Calling it again with the same timing keeps the
 * schedule's place (so a restart does not reset or double-fire it); a changed timing, or a
 * disabled schedule switched back on, starts afresh from now.
 */
export async function upsertSchedule(db: Executor, input: ScheduleInput): Promise<Schedule> {
  if (!NAME.test(input.name))
    throw new JobError("schedule name must be 1-64 chars of a-z 0-9 _ . : -");
  const { cron, intervalSeconds } = input;
  if ((cron === undefined) === (intervalSeconds === undefined)) {
    throw new JobError("schedule needs exactly one of cron and intervalSeconds");
  }
  if (
    intervalSeconds !== undefined &&
    !(
      Number.isInteger(intervalSeconds) &&
      intervalSeconds >= 1 &&
      intervalSeconds <= MAX_INTERVAL_SECONDS
    )
  ) {
    throw new JobError("schedule intervalSeconds must be an integer from 1 to a year");
  }
  const queue = jobQueue(input.queue);
  const payload = jobPayload(input.payload);
  const now = input.now ?? (await dbNow(db));
  let first: Date;
  try {
    first =
      cron !== undefined
        ? nextCronRun(parseCron(cron), now)
        : new Date(now.getTime() + (intervalSeconds ?? 0) * 1000);
  } catch (e) {
    // The cron parser's messages name the field, never the input.
    throw new JobError(`schedule cron is invalid: ${e instanceof Error ? e.message : "unknown"}`);
  }
  const enabled = input.enabled ?? true;
  const [row] = await db
    .insert(schedules)
    .values({
      name: input.name,
      cron: cron ?? null,
      intervalSeconds: intervalSeconds ?? null,
      queue,
      payload,
      enabled,
      nextRunAt: first,
    })
    .onConflictDoUpdate({
      target: schedules.name,
      set: {
        cron: cron ?? null,
        intervalSeconds: intervalSeconds ?? null,
        queue,
        payload,
        enabled,
        nextRunAt: sql`case when ${schedules.cron} is not distinct from excluded.cron
          and ${schedules.intervalSeconds} is not distinct from excluded.interval_seconds
          and ${schedules.enabled} = excluded.enabled
          then ${schedules.nextRunAt} else excluded.next_run_at end`,
      },
    })
    .returning();
  if (!row) throw new Error("upsert returned no row");
  return row;
}

/**
 * Enqueues the job of every schedule that is due and moves each one on, in one transaction. Rows
 * are taken `FOR UPDATE SKIP LOCKED`, so workers firing at the same moment split the work and
 * never fire a tick twice. A tick that was missed (workers down) fires once, not once per miss.
 * Each schedule fires in its own savepoint: one that cannot (a row only a direct insert can make)
 * is reported to `onError` and stays due, and the others still fire. Returns how many fired.
 */
export function fireDue(
  db: Executor,
  opts: { now?: Date; limit?: number; onError?: (schedule: string, error: unknown) => void } = {},
): Promise<number> {
  return db.transaction(async (tx) => {
    const now = opts.now ?? (await dbNow(tx));
    const due = await tx
      .select()
      .from(schedules)
      .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)))
      .orderBy(asc(schedules.nextRunAt), asc(schedules.id))
      .limit(opts.limit ?? 100)
      .for("update", { skipLocked: true });
    let fired = 0;
    for (const s of due) {
      try {
        await tx.transaction(async (sp) => {
          await enqueue(sp, { queue: s.queue, payload: s.payload, runAt: now });
          await sp
            .update(schedules)
            .set({ nextRunAt: nextRun(s, now), lastRunAt: now })
            .where(eq(schedules.id, s.id));
        });
        fired++;
      } catch (e) {
        opts.onError?.(s.name, e);
      }
    }
    return fired;
  });
}
