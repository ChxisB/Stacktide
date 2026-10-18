import { sql } from "drizzle-orm";
import type { Executor } from "./repo";

export interface StatusCount {
  status: string;
  count: number;
  /** Seconds the longest-waiting row has been in a state that should be short; null when none is. */
  oldestSeconds: number | null;
}
export interface QueueCount extends StatusCount {
  queue: string;
}
export interface OperationalStats {
  jobs: QueueCount[];
  syncRuns: StatusCount[];
  stackRuns: StatusCount[];
}

type Row = {
  queue?: string;
  status: string;
  n: string | number | bigint;
  oldest: string | number | null;
};
// the driver types a row as a bag of anything: these are the columns each query selects
const rows = (r: Iterable<Record<string, unknown>>) =>
  (<Row[]>[...r]).map((x) => ({
    ...(x.queue === undefined ? {} : { queue: x.queue }),
    status: x.status,
    count: Number(x.n),
    oldestSeconds: x.oldest === null ? null : Math.max(0, Number(x.oldest)),
  }));

/**
 * What the worker has queued and in flight, counted from the tables (METRICS, OPS-3). Only names and
 * numbers leave: no ids, no payloads, no values. The run tables keep no start time, so how long a
 * run took is not here, only how long one has been waiting in a state; for a job that is `run_at`
 * (when due) or `locked_at`.
 *
 * shortcut: full group-by scans at each call (the caller caches them for a few seconds); move to
 * counters kept as rows change when the tables are large enough for a scrape to be felt.
 */
export async function operationalStats(db: Executor): Promise<OperationalStats> {
  const [jobs, syncRuns, stackRuns] = await Promise.all([
    db.execute(sql`
    select queue, status, count(*) as n,
      max(extract(epoch from now() - case
        when status = 'queued' and run_at <= now() then run_at
        when status = 'running' then locked_at end)) as oldest
    from jobs group by queue, status order by queue, status`),
    db.execute(sql`
    select status, count(*) as n,
      max(extract(epoch from now() - updated_at)) filter (where status = 'applying') as oldest
    from sync_runs group by status order by status`),
    db.execute(sql`
    select status, count(*) as n,
      max(extract(epoch from now() - updated_at))
        filter (where status in ('queued', 'planning', 'applying')) as oldest
    from run_stacks group by status order by status`),
  ]);
  return {
    jobs: rows(jobs) as QueueCount[],
    syncRuns: rows(syncRuns),
    stackRuns: rows(stackRuns),
  };
}
