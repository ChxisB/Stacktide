import { hostname } from "node:os";
import type { Logger } from "@orch/core";
import { claim, complete, type Db, describeError, fail, fireDue, type Job } from "@orch/db";

export interface JobContext {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
  /** 1 on the first run. */
  attempt: number;
  /** The last run is `attempt === maxAttempts`: a failure then is final. */
  maxAttempts: number;
  log: Logger;
  /** Aborts when the lock timeout passes or the worker gives up draining: stop work that would outlive the lock. */
  signal: AbortSignal;
}
/** Resolve to finish the job, throw to fail it (it is retried with backoff until its attempts run out). */
export type JobHandler = (ctx: JobContext) => Promise<void>;

/**
 * Several consumers for one queue: each handler runs for the job and one failing does not stop the
 * others. If any failed, the job fails and is retried with all of them again, so each must be
 * idempotent.
 */
export const chain =
  (...handlers: JobHandler[]): JobHandler =>
  async (ctx) => {
    const results = await Promise.allSettled(handlers.map((handler) => handler(ctx)));
    for (const r of results) if (r.status === "rejected") throw r.reason;
  };

export interface WorkerOptions {
  db: Db;
  logger: Logger;
  /** Keyed by queue. A worker only claims queues it has a handler for. */
  handlers: Record<string, JobHandler>;
  workerId?: string;
  concurrency?: number;
  pollMs?: number;
  /** shortcut: no lock heartbeat, so a handler must finish within this or honour `signal`. */
  lockTimeoutMs?: number;
  /** How long `stop()` waits for running jobs before aborting them. */
  drainMs?: number;
  /** Test seam: a fake clock. Left out, the database clock decides. */
  now?: () => Date;
  backoff?: (attempt: number) => number;
}

export interface Worker {
  start(): void;
  /** Stops claiming, lets running jobs finish (up to `drainMs`), then resolves. */
  stop(): Promise<void>;
}

const ABORT_GRACE_MS = 2_000;

export function createWorker(o: WorkerOptions): Worker {
  const { db, logger, handlers, backoff } = o;
  const { concurrency = 4, pollMs = 1_000, lockTimeoutMs = 300_000, drainMs = 10_000 } = o;
  const now = o.now;
  const workerId = o.workerId ?? `${hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const queues = Object.keys(handlers);
  const running = new Set<Promise<void>>();
  const aborts = new Set<AbortController>();
  let stopping = false;
  let loop: Promise<void> | undefined;
  // Set while the loop sleeps. A wake-up that lands while it is busy is remembered in `nudged`.
  let nudge: (() => void) | undefined;
  let nudged = false;
  const wake = () => {
    if (nudge) nudge();
    else nudged = true;
  };

  // Never rejects: whatever happens to one job must not take the worker down.
  async function run(job: Job) {
    const log = logger.child({
      job_id: job.id,
      queue: job.queue,
      attempt: job.attempts,
      worker: workerId,
    });
    const ac = new AbortController();
    aborts.add(ac);
    const timer = setTimeout(() => ac.abort(new Error("job lock timeout")), lockTimeoutMs);
    let failure: { error: unknown } | undefined;
    try {
      log.info("job started");
      const handler = handlers[job.queue];
      if (!handler) throw new Error("no handler for queue");
      await handler({
        id: job.id,
        queue: job.queue,
        payload: job.payload,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        log,
        signal: ac.signal,
      });
    } catch (error) {
      failure = { error };
    }
    clearTimeout(timer);
    aborts.delete(ac);
    try {
      if (!failure) {
        if (await complete(db, job, workerId)) log.info("job done");
        else log.warn("job finished after its lock expired; the result was not recorded");
      } else {
        // Only the described error is logged, never the thrown object: it may carry a secret.
        const status = await fail(db, job, workerId, failure.error, { now: now?.(), backoff });
        const error = describeError(failure.error);
        if (status)
          log.warn(status === "dead" ? "job failed for good" : "job failed, will retry", { error });
        else log.warn("job failed after its lock expired; the failure was not recorded", { error });
      }
    } catch (error) {
      // The lock expires and the job is handed out again: at-least-once, so handlers must be idempotent.
      log.error("could not record the job result", { error: describeError(error) });
    }
  }

  /** True when every running job finished within `ms`. */
  async function drained(ms: number) {
    let timer: Timer | undefined;
    const done = await Promise.race([
      Promise.all(running).then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), ms);
      }),
    ]);
    clearTimeout(timer);
    return done;
  }

  async function poll() {
    while (!stopping) {
      // Every worker tries; the database lets each due schedule fire once (see `fireDue`).
      try {
        const fired = await fireDue(db, {
          now: now?.(),
          onError: (schedule, error) =>
            logger.warn("schedule failed to fire", { schedule, error: describeError(error) }),
        });
        if (fired > 0) logger.info("schedules fired", { count: fired });
      } catch (error) {
        logger.error("firing schedules failed", { error: describeError(error) });
      }
      const free = concurrency - running.size;
      if (free > 0) {
        try {
          for (const job of await claim(db, {
            queues,
            workerId,
            limit: free,
            lockTimeoutMs,
            now: now?.(),
          })) {
            const p: Promise<void> = run(job).finally(() => {
              running.delete(p);
              wake();
            });
            running.add(p);
          }
        } catch (error) {
          logger.error("job claim failed", { error: describeError(error) });
        }
      }
      // Sleep until the next poll, a finished job (a slot freed) or stop().
      if (!stopping && !nudged) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => nudge?.(), pollMs);
          nudge = () => {
            clearTimeout(timer);
            nudge = undefined;
            resolve();
          };
        });
      }
      nudged = false;
    }
  }

  return {
    start() {
      loop ??= poll();
    },
    async stop() {
      stopping = true;
      wake();
      await loop;
      if (!(await drained(drainMs))) {
        logger.warn("stopping with jobs still running; aborting them", { jobs: running.size });
        for (const ac of aborts) ac.abort(new Error("worker stopping"));
        // Let the aborted jobs record their failure before the caller closes the database.
        await drained(ABORT_GRACE_MS);
      }
    },
  };
}
