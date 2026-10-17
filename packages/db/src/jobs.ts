import { scrubText } from "@orch/core";
import { and, asc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import { AuditError, checkMetadata } from "./audit";
import type { Executor } from "./repo";
import { type JobStatus, jobs } from "./schema";

export type Job = typeof jobs.$inferSelect;

/** A refused enqueue or schedule. The message names the problem, never a payload value. */
export class JobError extends Error {
  override readonly name = "JobError";
}

const QUEUE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MAX_ERROR = 500;

export interface EnqueueInput {
  queue: string;
  /** Ids and parameters. Never a secret: the handler reads values from the vault when it runs. */
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}

/** Returns the queue name, or throws `JobError`. */
export function jobQueue(queue: string): string {
  if (!QUEUE.test(queue)) throw new JobError("job queue must be 1-64 chars of a-z 0-9 _ . -");
  return queue;
}

/** Same tripwire as audit metadata: small plain JSON without secret-looking keys. */
export function jobPayload(payload: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    return checkMetadata(payload);
  } catch (e) {
    if (e instanceof AuditError)
      throw new JobError(e.message.replace(/^audit metadata/, "job payload"));
    throw e;
  }
}

/** Takes a transaction too, so the job exists exactly when the change that needs it does. */
export async function enqueue(db: Executor, input: EnqueueInput): Promise<Job> {
  const queue = jobQueue(input.queue);
  const { maxAttempts } = input;
  if (
    maxAttempts !== undefined &&
    !(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 100)
  ) {
    throw new JobError("job maxAttempts must be an integer from 1 to 100");
  }
  const [job] = await db
    .insert(jobs)
    .values({ queue, payload: jobPayload(input.payload), runAt: input.runAt, maxAttempts })
    .returning();
  if (!job) throw new Error("insert returned no row");
  return job;
}

export interface ClaimOptions {
  queues: string[];
  /** Identifies the claimer; only it can complete or fail what it claimed. */
  workerId: string;
  limit?: number;
  /** A running job older than this is taken to be orphaned and is handed out again. */
  lockTimeoutMs?: number;
  /** Test seam. Left out, the database clock decides, so workers need not agree on the time. */
  now?: Date;
}

const clock = (now?: Date) => (now ? sql`${now.toISOString()}::timestamptz` : sql`now()`);
const secs = (ms: number) => sql`make_interval(secs => ${ms / 1000})`;

/**
 * Takes up to `limit` due jobs, oldest first. `FOR UPDATE SKIP LOCKED` lets workers claim at the
 * same time without waiting for or double-taking each other. Each claim counts as an attempt.
 */
export async function claim(db: Executor, opts: ClaimOptions): Promise<Job[]> {
  const { queues, workerId, limit = 1, lockTimeoutMs = 300_000 } = opts;
  const at = clock(opts.now);
  if (queues.length === 0 || limit < 1) return [];
  const expired = sql`${jobs.lockedAt} < ${at} - ${secs(lockTimeoutMs)}`;
  // Orphaned on their last attempt: nothing may run them again.
  await db
    .update(jobs)
    .set({
      status: "dead",
      lockedBy: null,
      lockedAt: null,
      lastError: "worker lost the job (lock expired) on its last attempt",
    })
    .where(
      and(
        inArray(jobs.queue, queues),
        eq(jobs.status, "running"),
        expired,
        gte(jobs.attempts, jobs.maxAttempts),
      ),
    );
  const picked = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        inArray(jobs.queue, queues),
        or(
          and(eq(jobs.status, "queued"), lte(jobs.runAt, at)),
          and(eq(jobs.status, "running"), expired, lt(jobs.attempts, jobs.maxAttempts)),
        ),
      ),
    )
    .orderBy(asc(jobs.runAt), asc(jobs.id))
    .limit(limit)
    .for("update", { skipLocked: true });
  // ARRAY(subquery) is evaluated once: `id IN (subquery)` may be re-run and lock more than `limit`.
  const rows = await db
    .update(jobs)
    .set({
      status: "running",
      attempts: sql`${jobs.attempts} + 1`,
      lockedBy: workerId,
      lockedAt: at,
    })
    .where(sql`${jobs.id} = any(array(${picked}))`)
    .returning();
  return rows.sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.id.localeCompare(b.id));
}

// The attempt number is a fencing token: a worker whose lock expired and whose job was handed to
// another worker (attempts + 1) can no longer touch it.
const owned = (job: Job, workerId: string) =>
  and(
    eq(jobs.id, job.id),
    eq(jobs.status, "running"),
    eq(jobs.lockedBy, workerId),
    eq(jobs.attempts, job.attempts),
  );

/** True when this worker still held the job and it is now done. */
export async function complete(db: Executor, job: Job, workerId: string): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "done", lockedBy: null, lockedAt: null })
    .where(owned(job, workerId))
    .returning({ id: jobs.id });
  return rows.length === 1;
}

/** 1s, 2s, 4s ... capped at 15 minutes. shortcut: no jitter; add it if retries ever stampede. */
export const backoffMs = (attempt: number, o: { baseMs?: number; capMs?: number } = {}) =>
  Math.min(o.capMs ?? 900_000, (o.baseMs ?? 1_000) * 2 ** Math.min(Math.max(attempt - 1, 0), 30));

/** What reaches `last_error`: error name and message only, scrubbed, one line, bounded. */
export function describeError(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : `non-Error thrown (${typeof error})`;
  // Scrub before cutting, so a cut-off secret cannot slip through.
  return scrubText(text).replace(/\s+/g, " ").slice(0, MAX_ERROR);
}

export interface FailOptions {
  now?: Date;
  backoff?: (attempt: number) => number;
}

/**
 * Records the failure and requeues the job after a backoff, or buries it (`dead`) when it had
 * its last attempt. Undefined when this worker no longer held the job.
 */
export async function fail(
  db: Executor,
  job: Job,
  workerId: string,
  error: unknown,
  opts: FailOptions = {},
): Promise<Extract<JobStatus, "queued" | "dead"> | undefined> {
  const { backoff = backoffMs } = opts;
  const status = job.attempts >= job.maxAttempts ? "dead" : "queued";
  const rows = await db
    .update(jobs)
    .set({
      status,
      runAt:
        status === "queued" ? sql`${clock(opts.now)} + ${secs(backoff(job.attempts))}` : undefined,
      lastError: describeError(error),
      lockedBy: null,
      lockedAt: null,
    })
    .where(owned(job, workerId))
    .returning({ id: jobs.id });
  return rows.length === 1 ? status : undefined;
}
