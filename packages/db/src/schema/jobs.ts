import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";

export const JOB_STATUSES = ["queued", "running", "done", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Work for the worker. `payload` holds ids and parameters, never values (see `enqueue`). A job is
 * `running` while `locked_by`/`locked_at` are set; `attempts` counts claims and doubles as the
 * fencing token for `complete`/`fail`. Finished rows stay (`done`, `dead`) until a retention
 * job removes them.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    queue: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    status: text().$type<JobStatus>().notNull().default("queued"),
    /** Scrubbed and truncated (see `fail`): safe to show in a UI. */
    lastError: text(),
    lockedBy: text(),
    lockedAt: timestamp({ withTimezone: true }),
    /** Names what a queued job is for: while one is queued, `enqueueOnce` with the same key adds nothing. */
    dedupeKey: text(),
    ...timestamps(),
  },
  (t) => [
    check("jobs_status_check", sql`${t.status} in ('queued', 'running', 'done', 'dead')`),
    check("jobs_attempts_check", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1`),
    // Claiming scans due queued jobs per queue, and expired locks.
    index("jobs_claim_idx").on(t.queue, t.runAt).where(sql`${t.status} = 'queued'`),
    index("jobs_lock_idx").on(t.lockedAt).where(sql`${t.status} = 'running'`),
    uniqueIndex("jobs_queued_dedupe")
      .on(t.queue, t.dedupeKey)
      .where(sql`${t.status} = 'queued' and ${t.dedupeKey} is not null`),
  ],
);
