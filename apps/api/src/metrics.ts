import { createHash, timingSafeEqual } from "node:crypto";
import type { OperationalStats } from "@orch/db";
import type { RateLimitSample } from "@orch/gitlab";
import { z } from "zod";

/** Series one metric may hold. A label whose values come from callers must not be able to grow memory or a scrape without end. */
export const MAX_SERIES = 500;

/** `/metrics` answers only to this bearer token; unset, it answers 404. At least 32 characters: it is a password. */
export const metricsEnv = { ORCH_METRICS_TOKEN: z.string().min(32).optional() };

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Labels = Readonly<Record<string, string | undefined>>;
const escapeValue = (v: string) => v.replace(/[\\"\n]/g, (c) => (c === "\n" ? "\\n" : `\\${c}`));
const escapeHelp = (v: string) => v.replace(/[\\\n]/g, (c) => (c === "\n" ? "\\n" : "\\\\"));
const show = (names: readonly string[], values: readonly string[]) =>
  names.length === 0
    ? ""
    : `{${names.map((n, i) => `${n}="${escapeValue(values[i] ?? "")}"`).join(",")}}`;
const head = (name: string, help: string, type: string) =>
  `# HELP ${name} ${escapeHelp(help)}\n# TYPE ${name} ${type}\n`;

export interface Counter {
  inc(labels?: Labels): void;
}
export interface Histogram {
  observe(labels: Labels, value: number): void;
}

/**
 * Counters and histograms held in this process, and the text they render. Labels are declared
 * up front: a label the family does not declare is dropped, and a family keeps at most
 * `MAX_SERIES` label sets (the rest are counted in `orch_metrics_series_dropped_total`).
 */
export function newRegistry() {
  const families = new Map<string, () => string>();
  let dropped = 0;

  function declare(name: string, names: readonly string[]) {
    if (!NAME.test(name)) throw new TypeError(`bad metric name "${name}"`);
    for (const n of names) {
      if (!LABEL.test(n) || n === "le") throw new TypeError(`bad label name "${n}"`);
    }
    if (families.has(name)) throw new TypeError(`metric "${name}" is already registered`);
  }

  /** The series of one family, found by their label values; a new one is refused past the cap. */
  function seriesOf<V>(names: readonly string[], init: () => V) {
    const all = new Map<string, { values: string[]; v: V }>();
    return {
      all,
      at(labels: Labels): V | undefined {
        const values = names.map((n) => labels[n] ?? "");
        const key = values.join("\0");
        let s = all.get(key);
        if (!s) {
          if (all.size >= MAX_SERIES) {
            dropped++;
            return undefined;
          }
          s = { values, v: init() };
          all.set(key, s);
        }
        return s.v;
      },
    };
  }

  return {
    counter(name: string, help: string, names: readonly string[]): Counter {
      declare(name, names);
      const s = seriesOf(names, () => ({ n: 0 }));
      families.set(
        name,
        () =>
          head(name, help, "counter") +
          [...s.all.values()].map((x) => `${name}${show(names, x.values)} ${x.v.n}\n`).join(""),
      );
      return {
        inc(labels = {}) {
          const x = s.at(labels);
          if (x) x.n++;
        },
      };
    },

    histogram(
      name: string,
      help: string,
      names: readonly string[],
      buckets: readonly number[] = BUCKETS,
    ): Histogram {
      declare(name, names);
      const s = seriesOf(names, () => ({ counts: buckets.map(() => 0), sum: 0, n: 0 }));
      families.set(name, () => {
        let out = head(name, help, "histogram");
        for (const { values, v } of s.all.values()) {
          // `counts[i]` is the observations that fit bucket i and no smaller one
          let running = 0;
          buckets.forEach((le, i) => {
            running += v.counts[i] ?? 0;
            out += `${name}_bucket${show([...names, "le"], [...values, String(le)])} ${running}\n`;
          });
          out += `${name}_bucket${show([...names, "le"], [...values, "+Inf"])} ${v.n}\n`;
          out += `${name}_sum${show(names, values)} ${v.sum}\n`;
          out += `${name}_count${show(names, values)} ${v.n}\n`;
        }
        return out;
      });
      return {
        observe(labels, value) {
          const x = s.at(labels);
          if (!x || !Number.isFinite(value)) return;
          const i = buckets.findIndex((le) => value <= le);
          if (i >= 0) x.counts[i] = (x.counts[i] ?? 0) + 1;
          x.sum += value;
          x.n++;
        },
      };
    },

    render(): string {
      return (
        [...families.values()].map((f) => f()).join("") +
        head(
          "orch_metrics_series_dropped_total",
          "Label sets refused because a metric was full.",
          "counter",
        ) +
        `orch_metrics_series_dropped_total ${dropped}\n`
      );
    },
  };
}
export type Registry = ReturnType<typeof newRegistry>;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * What the HTTP layer reports for each request. Labels are the method (one of a fixed set), the
 * route as it was registered (`/organizations/:orgId/...`, never the path asked for: a path holds
 * ids and anything a client types) and the status. A request no route matched has the route
 * `unmatched`.
 */
export function requestMetrics(r: Registry) {
  const total = r.counter("orch_http_requests_total", "HTTP requests handled.", [
    "method",
    "route",
    "status",
  ]);
  const duration = r.histogram(
    "orch_http_request_duration_seconds",
    "HTTP request duration in seconds.",
    ["method", "route"],
  );
  return (m: { method: string; route: string | undefined; status: number; seconds: number }) => {
    const method = METHODS.has(m.method) ? m.method : "other";
    const route = m.route ? m.route : "unmatched";
    total.inc({ method, route, status: String(m.status) });
    duration.observe({ method, route }, m.seconds);
  };
}

interface Gauge {
  name: string;
  help: string;
  rows: { labels: Record<string, string>; value: number }[];
}

function renderGauges(gauges: readonly Gauge[]) {
  let out = "";
  for (const g of gauges) {
    if (g.rows.length === 0) continue;
    out += head(g.name, g.help, "gauge");
    for (const { labels, value } of g.rows.slice(0, MAX_SERIES)) {
      const names = Object.keys(labels);
      out += `${g.name}${show(names, Object.values(labels))} ${value}\n`;
    }
  }
  return out;
}

/**
 * The queue, run and GitLab figures that are read at scrape time. Only names (a queue, a state, a
 * GitLab host) and numbers: never an id, a payload or a value.
 */
export function renderStats(stats: OperationalStats, limits: readonly RateLimitSample[]) {
  const aged = <T extends { oldestSeconds: number | null }>(rows: T[]) =>
    rows.filter((r): r is T & { oldestSeconds: number } => r.oldestSeconds !== null);
  return renderGauges([
    {
      name: "orch_jobs",
      help: "Jobs per queue and state.",
      rows: stats.jobs.map((j) => ({
        labels: { queue: j.queue, status: j.status },
        value: j.count,
      })),
    },
    {
      name: "orch_job_oldest_age_seconds",
      help: "Age of the oldest due queued job, or running job, of a queue.",
      rows: aged(stats.jobs).map((j) => ({
        labels: { queue: j.queue, status: j.status },
        value: j.oldestSeconds,
      })),
    },
    {
      name: "orch_sync_runs",
      help: "Sync runs per state.",
      rows: stats.syncRuns.map((r) => ({ labels: { status: r.status }, value: r.count })),
    },
    {
      name: "orch_sync_run_oldest_age_seconds",
      help: "Seconds the longest running apply of a sync target has been applying.",
      rows: aged(stats.syncRuns).map((r) => ({
        labels: { status: r.status },
        value: r.oldestSeconds,
      })),
    },
    {
      name: "orch_stack_runs",
      help: "IaC stacks of runs per state.",
      rows: stats.stackRuns.map((r) => ({ labels: { status: r.status }, value: r.count })),
    },
    {
      name: "orch_stack_run_oldest_age_seconds",
      help: "Seconds the longest waiting, planning or applying IaC stack has been in that state.",
      rows: aged(stats.stackRuns).map((r) => ({
        labels: { status: r.status },
        value: r.oldestSeconds,
      })),
    },
    {
      name: "orch_gitlab_ratelimit_remaining",
      help: "Requests left in the window, as the instance last said (this process only).",
      rows: limits.map((l) => ({ labels: { host: l.host }, value: l.remaining })),
    },
    {
      name: "orch_gitlab_ratelimit_limit",
      help: "Requests allowed in the window, as the instance last said (this process only).",
      rows: limits.flatMap((l) =>
        l.limit === undefined ? [] : [{ labels: { host: l.host }, value: l.limit }],
      ),
    },
  ]);
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Whether the `Authorization` header carries this bearer token. Compares digests, so time says nothing of the token. */
export function bearerMatches(header: string | null, token: string): boolean {
  const given = header?.match(/^Bearer +(\S+)$/i)?.[1] ?? "";
  return timingSafeEqual(digest(given), digest(token)) && given !== "";
}
