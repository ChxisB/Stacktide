/** One finished deployment as the numbers see it: where, how it ended, and when. */
export interface StatsRow {
  environment: string;
  status: string;
  at: Date;
}

export interface EnvironmentStats {
  environment: string;
  /** deployments that succeeded in the window */
  deployments: number;
  /** deployments that failed in the window */
  failed: number;
  /** successes per week; null when nothing succeeded or failed in the window */
  perWeek: number | null;
  /** failed over succeeded plus failed; null when neither happened */
  failureRate: number | null;
  /** median seconds from a failure to the next success there; null when no failure has been fixed */
  medianRestoreSeconds: number | null;
}

const DAY_MS = 86_400_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Deployment frequency, failure rate and time to restore over the `days` before `now`, per environment.
 * A deployment is in the window when its time is at or after `now - days` and not after `now` (both edges in).
 * Only `success` and `failed` are outcomes; every other status is ignored. The time to restore runs from the
 * first failure of a run of failures to the next success in the same environment, so two failures before one
 * success count once, from the first; a failure not yet followed by a success counts for nothing. The median
 * of an even number is the mean of the middle two, in whole seconds. `environments` are reported in that order
 * even with nothing to say about them; any other environment found in `rows` follows, by name.
 */
export function deploymentStats(
  rows: StatsRow[],
  o: { now: Date; days: number; environments?: string[] },
): EnvironmentStats[] {
  if (!Number.isFinite(o.days) || o.days <= 0) throw new Error("days must be a positive number");
  const from = o.now.getTime() - o.days * DAY_MS;
  const to = o.now.getTime();
  const by = new Map<string, { at: number; ok: boolean }[]>();
  for (const name of o.environments ?? []) by.set(name, []);
  for (const r of rows) {
    const at = r.at.getTime();
    if ((r.status !== "success" && r.status !== "failed") || at < from || at > to) continue;
    const list = by.get(r.environment) ?? [];
    list.push({ at, ok: r.status === "success" });
    by.set(r.environment, list);
  }
  const listed = new Set(o.environments ?? []);
  const names = [...by.keys()].filter((n) => !listed.has(n)).sort();
  return [...(o.environments ?? []), ...names].map((environment) => {
    const list = (by.get(environment) ?? []).sort((a, b) => a.at - b.at);
    const deployments = list.filter((d) => d.ok).length;
    const failed = list.length - deployments;
    const restores: number[] = [];
    let brokenSince: number | undefined;
    for (const d of list) {
      if (!d.ok) brokenSince ??= d.at;
      else if (brokenSince !== undefined) {
        restores.push((d.at - brokenSince) / 1000);
        brokenSince = undefined;
      }
    }
    return {
      environment,
      deployments,
      failed,
      perWeek: list.length === 0 ? null : deployments / (o.days / 7),
      failureRate: list.length === 0 ? null : failed / list.length,
      medianRestoreSeconds: restores.length === 0 ? null : Math.round(median(restores)),
    };
  });
}

const tenth = (n: number) => Math.round(n * 10) / 10;

/** A time to restore in the unit it reads best in: seconds, minutes, hours (to two days) or days. */
export function restoreText(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (Math.round(seconds / 60) < 60) return `${Math.round(seconds / 60)} min`;
  const hours = tenth(seconds / 3600);
  return hours < 48 ? `${hours} h` : `${tenth(seconds / 86_400)} d`;
}

/**
 * The numbers of one environment as one quiet line: `4 deployments a week · 1 failed in 12 · back in 8 min`.
 * An environment with no deployment that succeeded or failed (or none at all, `undefined`) is a dash; a time
 * to restore that does not exist yet is a dash in its place.
 */
export function statsLine(s: EnvironmentStats | undefined): string {
  if (!s || s.perWeek === null) return "-";
  const week = s.perWeek >= 10 ? Math.round(s.perWeek) : tenth(s.perWeek);
  return [
    `${week} deployment${week === 1 ? "" : "s"} a week`,
    `${s.failed} failed in ${s.deployments + s.failed}`,
    `back in ${s.medianRestoreSeconds === null ? "-" : restoreText(s.medianRestoreSeconds)}`,
  ].join(" · ");
}
