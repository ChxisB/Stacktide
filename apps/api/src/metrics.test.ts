import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { createDb, enqueue, type OperationalStats } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createApp } from "./app";
import { MAX_SERIES, newRegistry, renderStats } from "./metrics";
import { devPrincipal } from "./principal";

const TOKEN = "m".repeat(40);
const lines = (text: string) => text.split("\n").filter((l) => l && !l.startsWith("#"));

describe("registry", () => {
  test("renders counters and histograms in the Prometheus text format", () => {
    const r = newRegistry();
    const c = r.counter("orch_things_total", "Things done.", ["kind"]);
    c.inc({ kind: "a" });
    c.inc({ kind: "a" });
    c.inc({ kind: "b" });
    const h = r.histogram("orch_wait_seconds", "Waiting.", ["kind"], [0.1, 1]);
    h.observe({ kind: "a" }, 0.05);
    h.observe({ kind: "a" }, 0.5);
    h.observe({ kind: "a" }, 5);
    const text = r.render();
    expect(text).toContain(
      "# HELP orch_things_total Things done.\n# TYPE orch_things_total counter\n",
    );
    expect(lines(text)).toEqual(
      expect.arrayContaining([
        'orch_things_total{kind="a"} 2',
        'orch_things_total{kind="b"} 1',
        'orch_wait_seconds_bucket{kind="a",le="0.1"} 1',
        'orch_wait_seconds_bucket{kind="a",le="1"} 2',
        'orch_wait_seconds_bucket{kind="a",le="+Inf"} 3',
        'orch_wait_seconds_sum{kind="a"} 5.55',
        'orch_wait_seconds_count{kind="a"} 3',
      ]),
    );
    expect(text.endsWith("\n")).toBe(true);
  });

  test("escapes label values and help text", () => {
    const r = newRegistry();
    r.counter("orch_x_total", 'a\nb \\ "c"', ["v"]).inc({ v: 'q"\\\n' });
    const text = r.render();
    expect(text).toContain('# HELP orch_x_total a\\nb \\\\ "c"\n');
    expect(text).toContain('orch_x_total{v="q\\"\\\\\\n"} 1');
  });

  test("refuses names and labels that are not Prometheus's", () => {
    const r = newRegistry();
    expect(() => r.counter("1bad", "h", [])).toThrow(TypeError);
    expect(() => r.counter("orch_ok_total", "h", ["bad-label"])).toThrow(TypeError);
    expect(() => r.counter("orch_dup_total", "h", [])).not.toThrow();
    expect(() => r.counter("orch_dup_total", "h", [])).toThrow(/already/);
  });

  test("label cardinality guard: a family keeps at most MAX_SERIES series and counts what it drops", () => {
    const r = newRegistry();
    const c = r.counter("orch_wild_total", "Wild.", ["id"]);
    for (let i = 0; i < MAX_SERIES + 25; i++) c.inc({ id: `v${i}` });
    // an existing series still counts after the cap
    c.inc({ id: "v0" });
    const text = r.render();
    expect(lines(text).filter((l) => l.startsWith("orch_wild_total{"))).toHaveLength(MAX_SERIES);
    expect(lines(text)).toContain('orch_wild_total{id="v0"} 2');
    expect(lines(text)).toContain("orch_metrics_series_dropped_total 25");
  });

  test("an unknown label name is ignored, a missing one is empty", () => {
    const r = newRegistry();
    const c = r.counter("orch_l_total", "L.", ["a", "b"]);
    c.inc({ a: "1", secret: "hunter2" });
    const text = r.render();
    expect(text).toContain('orch_l_total{a="1",b=""} 1');
    expect(text).not.toContain("hunter2");
  });
});

describe("renderStats", () => {
  test("a gauge shows at most MAX_SERIES rows", () => {
    const stats: OperationalStats = {
      jobs: Array.from({ length: MAX_SERIES + 25 }, (_, i) => ({
        queue: `q${i}`,
        status: "queued",
        count: 1,
        oldestSeconds: null,
      })),
      syncRuns: [],
      stackRuns: [],
    };
    const shown = lines(renderStats(stats, [])).filter((l) => l.startsWith("orch_jobs{"));
    expect(shown).toHaveLength(MAX_SERIES);
  });

  test("names only: queue, state and numbers", () => {
    const text = renderStats(
      {
        jobs: [
          { queue: "audit.purge", status: "queued", count: 3, oldestSeconds: 12.5 },
          { queue: "audit.purge", status: "done", count: 9, oldestSeconds: null },
        ],
        syncRuns: [{ status: "applying", count: 1, oldestSeconds: 40 }],
        stackRuns: [{ status: "planning", count: 2, oldestSeconds: 7 }],
      },
      [{ host: "gitlab.example.com", remaining: 17, limit: 2000, observedAt: new Date() }],
    );
    expect(lines(text)).toEqual([
      'orch_jobs{queue="audit.purge",status="queued"} 3',
      'orch_jobs{queue="audit.purge",status="done"} 9',
      'orch_job_oldest_age_seconds{queue="audit.purge",status="queued"} 12.5',
      'orch_sync_runs{status="applying"} 1',
      'orch_sync_run_oldest_age_seconds{status="applying"} 40',
      'orch_stack_runs{status="planning"} 2',
      'orch_stack_run_oldest_age_seconds{status="planning"} 7',
      'orch_gitlab_ratelimit_remaining{host="gitlab.example.com"} 17',
      'orch_gitlab_ratelimit_limit{host="gitlab.example.com"} 2000',
    ]);
  });
});

const unusedDb = createDb("postgres://unused:unused@127.0.0.1:1/unused", 1);
const EMPTY: OperationalStats = { jobs: [], syncRuns: [], stackRuns: [] };

function setup(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  const app = createApp({
    logger: createLogger({ write: () => {}, level: "error" }),
    db: unusedDb,
    // nobody is signed in: a guarded route stops at 401 before it reaches a query
    principal: () => undefined,
    ready: async () => {},
    metrics: { token: TOKEN, stats: async () => EMPTY },
    ...over,
  });
  const call = (path: string, init?: RequestInit) =>
    app.handle(new Request(`http://localhost${path}`, init));
  const scrape = async () => {
    const res = await call("/metrics", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    return lines(await res.text());
  };
  /** `onAfterResponse` runs once `handle()` has returned. */
  const settled = () => Bun.sleep(20);
  return { app, call, scrape, settled };
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("GET /metrics", () => {
  test("answers 404 when no token is configured, whatever the caller sends", async () => {
    const { call } = setup({ metrics: undefined });
    for (const headers of [{}, auth]) {
      const res = await call("/metrics", { headers });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("orch_");
    }
  });

  test("answers 401 with a challenge unless the bearer token is exactly the configured one", async () => {
    const { call } = setup();
    const wrong = [
      undefined,
      "",
      "Bearer",
      "Bearer ",
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${"n".repeat(40)}`,
      `Basic ${TOKEN}`,
      // the scheme must be the whole start of the header
      `xBearer ${TOKEN}`,
      `Basic Bearer ${TOKEN}`,
      TOKEN,
      `Bearer ${TOKEN} extra`,
    ];
    for (const authorization of wrong) {
      const res = await call("/metrics", { headers: authorization ? { authorization } : {} });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.text()).not.toContain("orch_");
    }
  });

  test("the dev principal is not enough: only the token opens it", async () => {
    const { call } = setup({ principal: devPrincipal });
    expect((await call("/metrics")).status).toBe(401);
  });

  test("serves the Prometheus text format to the right token", async () => {
    const { call } = setup();
    const res = await call("/metrics", { headers: { authorization: `bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("# TYPE orch_metrics_series_dropped_total counter");
    expect(text).not.toContain(TOKEN);
  });

  test("counts requests by method, registered route and status, and times them", async () => {
    const { call, scrape, settled } = setup();
    await call("/health");
    await call("/health");
    await call("/ready");
    await call("/organizations");
    await settled();
    const text = await scrape();
    expect(text).toContain('orch_http_requests_total{method="GET",route="/health",status="200"} 2');
    expect(text).toContain('orch_http_requests_total{method="GET",route="/ready",status="200"} 1');
    expect(text).toContain(
      'orch_http_requests_total{method="GET",route="/organizations",status="401"} 1',
    );
    expect(text).toContain(
      'orch_http_request_duration_seconds_count{method="GET",route="/health"} 2',
    );
    expect(text).toContain(
      'orch_http_request_duration_seconds_bucket{method="GET",route="/health",le="+Inf"} 2',
    );
  });

  test("labels never carry ids or paths a client made up, and the series stay few", async () => {
    const { call, scrape, settled } = setup();
    const made: string[] = [];
    for (let i = 0; i < 40; i++) {
      const org = crypto.randomUUID();
      const project = crypto.randomUUID();
      const junk = `zz-${crypto.randomUUID().slice(0, 8)}`;
      made.push(org, project, junk);
      // a registered route with ids in the path, an unmatched one, and a verb outside the usual set
      await call(`/organizations/${org}/projects/${project}`);
      await call(`/${junk}/${org}`);
      await call("/health", { method: "PURGE" });
    }
    await settled();
    const text = await scrape();
    for (const value of made) expect(text.join("\n")).not.toContain(value);
    const requests = text.filter((l) => l.startsWith("orch_http_requests_total{"));
    expect(requests.length).toBeLessThanOrEqual(4);
    expect(requests.join("\n")).toContain('route="/organizations/:orgId/projects/:projectId"');
    expect(requests.join("\n")).toContain('route="unmatched"');
    expect(requests.join("\n")).toContain('method="other"');
    expect(text).toContain("orch_metrics_series_dropped_total 0");
  });

  test("shows the queue and GitLab figures, and nothing else about them", async () => {
    const { scrape } = setup({
      metrics: {
        token: TOKEN,
        stats: async () => ({
          ...EMPTY,
          jobs: [{ queue: "audit.purge", status: "queued", count: 2, oldestSeconds: 31 }],
        }),
      },
    });
    const text = await scrape();
    expect(text).toContain('orch_jobs{queue="audit.purge",status="queued"} 2');
    expect(text).toContain('orch_job_oldest_age_seconds{queue="audit.purge",status="queued"} 31');
  });

  test("reads the database once for scrapes close together, and does not keep a failure", async () => {
    let reads = 0;
    const written: string[] = [];
    const { call, scrape } = setup({
      logger: createLogger({ write: (l) => written.push(l), level: "debug" }),
      metrics: {
        token: TOKEN,
        stats: async () => {
          reads++;
          if (reads === 1) throw new Error(`connect postgres://orch:${TOKEN}@db/orch`);
          return EMPTY;
        },
      },
    });
    const failed = await call("/metrics", { headers: auth });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain(TOKEN);
    expect(written.some((l) => l.includes("metrics could not be read"))).toBe(true);
    expect(written.join("\n")).not.toContain(TOKEN);
    await scrape();
    await scrape();
    expect(reads).toBe(2);
  });
});

describe("GET /metrics against the database", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.drop();
  });

  test("reports the jobs that are queued", async () => {
    await enqueue(t.db, { queue: "metrics-probe", runAt: new Date(Date.now() - 90_000) });
    const { scrape } = setup({ db: t.db, metrics: { token: TOKEN } });
    const text = await scrape();
    expect(text).toContain('orch_jobs{queue="metrics-probe",status="queued"} 1');
    const age = text.find((l) => l.startsWith('orch_job_oldest_age_seconds{queue="metrics-probe"'));
    expect(Number(age?.split(" ").at(-1))).toBeGreaterThanOrEqual(90);
  });
});
