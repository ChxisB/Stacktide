import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";

/**
 * A recurring job: every time `next_run_at` passes, the worker enqueues `queue` with `payload` and
 * moves `next_run_at` on. Exactly one of `cron` (UTC, five fields) and `interval_seconds` is set.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: id(),
    name: text().notNull().unique("schedules_name_key"),
    cron: text(),
    intervalSeconds: integer(),
    queue: text().notNull(),
    /** Ids and parameters, never values: the same rule as `jobs.payload`. */
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    nextRunAt: timestamp({ withTimezone: true }).notNull(),
    lastRunAt: timestamp({ withTimezone: true }),
    enabled: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    check("schedules_kind_check", sql`(${t.cron} is null) <> (${t.intervalSeconds} is null)`),
    check(
      "schedules_interval_check",
      sql`${t.intervalSeconds} is null or ${t.intervalSeconds} >= 1`,
    ),
    index("schedules_due_idx").on(t.nextRunAt).where(sql`${t.enabled}`),
  ],
);
