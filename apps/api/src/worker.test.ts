import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { createDb, type Db, enqueue, jobs, schedules, upsertSchedule } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq, inArray } from "drizzle-orm";
import { createWorker, type JobHandler, type Worker } from "./worker";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const CANARY = "SECRET-CANARY-9034";
const queueName = () => `q-${crypto.randomUUID().slice(0, 8)}`;
const get = async (id: string) => (await t.db.select().from(jobs).where(eq(jobs.id, id)))[0];
const FAST = { pollMs: 10, backoff: () => 0 };

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function setup() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ write: (l) => lines.push(JSON.parse(l)), level: "debug" });
  const started: Worker[] = [];
  const dbs: Db[] = [];
  const worker = (handlers: Record<string, JobHandler>, extra: object = {}, db?: Db) => {
    const w = createWorker({ db: db ?? t.db, logger, handlers, ...FAST, ...extra });
    started.push(w);
    return w;
  };
  // Each worker gets its own pool, like separate processes would.
  const ownDb = () => {
    const db = createDb(t.url, 2);
    dbs.push(db);
    return db;
  };
  const cleanup = async () => {
    await Promise.all(started.map((w) => w.stop()));
    await Promise.all(dbs.map((d) => d.$client.close()));
  };
  return { lines, worker, ownDb, cleanup };
}

describe("worker", () => {
  test("three workers drain 100 jobs and each job runs exactly once", async () => {
    const s = setup();
    const queue = queueName();
    const ran = new Map<string, number>();
    const busiest: number[] = [];
    // One handler (and counter) per worker, to check each worker's own concurrency limit.
    const handlerFor = (): JobHandler => {
      let inflight = 0;
      const slot = busiest.push(0) - 1;
      return async ({ id }) => {
        inflight++;
        busiest[slot] = Math.max(busiest[slot] ?? 0, inflight);
        ran.set(id, (ran.get(id) ?? 0) + 1);
        await Bun.sleep(Math.random() * 5);
        inflight--;
      };
    };
    const ids = await Promise.all(
      Array.from({ length: 100 }, (_, n) =>
        enqueue(t.db, { queue, payload: { n } }).then((j) => j.id),
      ),
    );
    const workers = [0, 1, 2].map(() =>
      s.worker({ [queue]: handlerFor() }, { concurrency: 4 }, s.ownDb()),
    );
    for (const w of workers) w.start();
    await until(async () => {
      const rows = await t.db.select().from(jobs).where(eq(jobs.queue, queue));
      return rows.every((r) => r.status === "done");
    }, "all jobs done");
    await s.cleanup();

    expect([...ran.keys()].sort()).toEqual([...ids].sort());
    expect([...ran.values()].every((n) => n === 1)).toBe(true);
    expect(busiest.every((n) => n >= 1 && n <= 4)).toBe(true);
    const rows = await t.db.select().from(jobs).where(eq(jobs.queue, queue));
    expect(rows.every((r) => r.attempts === 1 && r.lockedBy === null)).toBe(true);
  });

  test("a failing job is retried, then goes dead after its last attempt", async () => {
    const s = setup();
    const queue = queueName();
    let calls = 0;
    const job = await enqueue(t.db, { queue, maxAttempts: 3 });
    s.worker({
      [queue]: async ({ attempt }) => {
        calls++;
        throw new Error(`boom ${attempt}`);
      },
    }).start();
    await until(async () => (await get(job.id))?.status === "dead", "the job to go dead");
    await s.cleanup();

    expect(calls).toBe(3);
    expect(await get(job.id)).toMatchObject({
      attempts: 3,
      lastError: "Error: boom 3",
      lockedBy: null,
    });
  });

  test("a job that fails and then succeeds ends up done", async () => {
    const s = setup();
    const queue = queueName();
    const job = await enqueue(t.db, { queue });
    s.worker({
      [queue]: async ({ attempt }) => {
        if (attempt === 1) throw new Error("flaky");
      },
    }).start();
    await until(async () => (await get(job.id))?.status === "done", "the retry to succeed");
    await s.cleanup();
    expect(await get(job.id)).toMatchObject({ attempts: 2, lastError: "Error: flaky" });
  });

  test("a secret in a thrown error reaches neither last_error nor the logs; payloads are never logged", async () => {
    const s = setup();
    const queue = queueName();
    const job = await enqueue(t.db, { queue, maxAttempts: 1, payload: { ref: "PAYLOAD-MARK-77" } });
    s.worker({
      [queue]: async ({ log }) => {
        log.info("working");
        throw new Error(`GET https://oauth2:${CANARY}@gitlab.test/x failed, password=${CANARY}`);
      },
    }).start();
    await until(async () => (await get(job.id))?.status === "dead", "the job to go dead");
    await s.cleanup();

    const row = await get(job.id);
    expect(row?.lastError).toContain("failed");
    expect(row?.lastError).not.toContain(CANARY);
    const logged = JSON.stringify(s.lines);
    expect(logged).toContain("job failed for good");
    expect(logged).not.toContain(CANARY);
    expect(logged).not.toContain("PAYLOAD-MARK-77");
  });

  test("stop() lets a running job finish and claims nothing more", async () => {
    const s = setup();
    const queue = queueName();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered = false;
    const first = await enqueue(t.db, { queue });
    const worker = s.worker(
      {
        [queue]: async () => {
          entered = true;
          await gate;
        },
      },
      { concurrency: 1 },
    );
    worker.start();
    await until(() => entered, "the job to start");
    const second = await enqueue(t.db, { queue });

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(100);
    expect(stopped).toBe(false); // still waiting for the running job
    release();
    await stopping;

    expect((await get(first.id))?.status).toBe("done");
    expect(await get(second.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  test("the handler's signal aborts when the drain time runs out", async () => {
    const s = setup();
    const queue = queueName();
    let aborted = false;
    let entered = false;
    const job = await enqueue(t.db, { queue });
    const worker = s.worker(
      {
        [queue]: ({ signal }) =>
          new Promise<void>((_, reject) => {
            entered = true;
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      },
      { drainMs: 50 },
    );
    worker.start();
    await until(() => entered, "the job to start");
    await worker.stop();
    expect(aborted).toBe(true);
    // stop() waited for the aborted job to record its failure, so no polling is needed here.
    expect((await get(job.id))?.status).toBe("queued");
    expect((await get(job.id))?.lastError).toBe("Error: aborted");
  });

  test("the handler's signal aborts when the lock timeout passes", async () => {
    const s = setup();
    const queue = queueName();
    let aborted = false;
    const job = await enqueue(t.db, { queue });
    s.worker(
      {
        [queue]: ({ signal }) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }),
          ),
      },
      { lockTimeoutMs: 50 },
    ).start();
    await until(async () => (await get(job.id))?.status === "done", "the job to finish");
    await s.cleanup();
    expect(aborted).toBe(true);
  });

  test("queues without a handler are left alone", async () => {
    const s = setup();
    const mine = queueName();
    const other = queueName();
    const a = await enqueue(t.db, { queue: mine });
    const b = await enqueue(t.db, { queue: other });
    s.worker({ [mine]: async () => {} }).start();
    await until(async () => (await get(a.id))?.status === "done", "my job");
    await s.cleanup();
    expect(await get(b.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  test("a database that fails does not crash the loop, and the error carries no connection string", async () => {
    const s = setup();
    const broken = s.ownDb();
    await broken.$client.close();
    const worker = s.worker({ [queueName()]: async () => {} }, {}, broken);
    worker.start();
    await until(
      () => s.lines.some((l) => l.msg === "job claim failed"),
      "a claim failure to be logged",
    );
    await s.cleanup();
    expect(JSON.stringify(s.lines)).not.toContain(t.url);
  });

  test("two workers running a schedule enqueue and run one job per tick", async () => {
    const s = setup();
    const queue = queueName();
    const T0 = new Date("2030-01-01T00:00:00Z");
    let clock = T0;
    await upsertSchedule(t.db, { name: `s-${queue}`, intervalSeconds: 60, queue, now: T0 });
    const ran: number[] = [];
    const handler: JobHandler = async () => {
      ran.push(clock.getTime());
    };
    const fake = { now: () => clock };
    for (const w of [
      s.worker({ [queue]: handler }, fake, s.ownDb()),
      s.worker({ [queue]: handler }, fake, s.ownDb()),
    ])
      w.start();

    const count = async () => (await t.db.select().from(jobs).where(eq(jobs.queue, queue))).length;
    await Bun.sleep(100);
    expect(ran).toEqual([]); // not due yet
    for (const tick of [1, 2, 3]) {
      clock = new Date(T0.getTime() + tick * 60_000);
      await until(() => ran.length === tick, `tick ${tick} to run`);
      await Bun.sleep(100); // several more polls of both workers: nothing may fire twice
      expect(ran.length).toBe(tick);
      expect(await count()).toBe(tick);
    }
    await s.cleanup();
    await t.db.delete(schedules).where(eq(schedules.queue, queue));
    expect(ran).toEqual([60_000, 120_000, 180_000].map((ms) => T0.getTime() + ms));
  });

  test("a failing schedule does not stop the worker from running jobs or other schedules", async () => {
    const s = setup();
    const [queue, other] = [queueName(), queueName()];
    const name = `bad-${queue}`;
    try {
      // Only a direct insert can produce a schedule `upsertSchedule` would refuse. Oldest first.
      await t.db.insert(schedules).values({
        name,
        intervalSeconds: 60,
        queue: "Not A Queue",
        nextRunAt: new Date(0),
      });
      await upsertSchedule(t.db, { name: `ok-${other}`, intervalSeconds: 60, queue: other });
      await t.db
        .update(schedules)
        .set({ nextRunAt: new Date(1) })
        .where(eq(schedules.queue, other));
      const job = await enqueue(t.db, { queue });
      const ran: string[] = [];
      s.worker({
        [queue]: async () => {},
        [other]: async () => {
          ran.push(other);
        },
      }).start();
      await until(async () => (await get(job.id))?.status === "done", "the job to run anyway");
      await until(() => ran.length > 0, "the other schedule to fire and run");
      await s.cleanup();
      expect(s.lines.some((l) => l.msg === "schedule failed to fire" && l.schedule === name)).toBe(
        true,
      );
    } finally {
      await t.db.delete(schedules).where(inArray(schedules.queue, ["Not A Queue", other]));
    }
  });
});
