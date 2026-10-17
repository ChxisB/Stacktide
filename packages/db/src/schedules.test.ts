import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "./index";
import { JobError } from "./jobs";
import { fireDue, upsertSchedule } from "./schedules";
import { jobs, schedules } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
const extra: Db[] = [];
beforeAll(async () => {
  t = await createTestDb();
});
// fireDue fires everything that is due, so each test starts without the others' schedules.
beforeEach(async () => {
  await t.db.delete(schedules);
});
afterAll(async () => {
  await Promise.all(extra.map((d) => d.$client.close()));
  await t.drop();
});

const CANARY = "SECRET-CANARY-3318";
const uniq = () => crypto.randomUUID().slice(0, 8);
const T0 = new Date("2030-01-01T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const sched = async (name: string) =>
  (await t.db.select().from(schedules).where(eq(schedules.name, name)))[0];
const jobsOf = (queue: string) => t.db.select().from(jobs).where(eq(jobs.queue, queue));
const own = () => {
  const db = createDb(t.url, 2);
  extra.push(db);
  return db;
};

describe("upsertSchedule", () => {
  test("an interval schedule first fires one interval from now; a cron one at its next match", async () => {
    const [a, b] = [`a-${uniq()}`, `b-${uniq()}`];
    const interval = await upsertSchedule(t.db, {
      name: a,
      intervalSeconds: 300,
      queue: "q",
      payload: { scope: "all" },
      now: T0,
    });
    expect(interval).toMatchObject({
      name: a,
      cron: null,
      intervalSeconds: 300,
      payload: { scope: "all" },
      enabled: true,
      lastRunAt: null,
    });
    expect(interval.nextRunAt).toEqual(at(5 * MIN));
    const cron = await upsertSchedule(t.db, { name: b, cron: "*/15 * * * *", queue: "q", now: T0 });
    expect(cron).toMatchObject({ cron: "*/15 * * * *", intervalSeconds: null });
    expect(cron.nextRunAt).toEqual(at(15 * MIN));
  });

  test("rejects bad input without touching the table", async () => {
    const ok = { name: `ok-${uniq()}`, intervalSeconds: 60, queue: "q", now: T0 };
    const bad: Record<string, object> = {
      "no schedule": { cron: undefined, intervalSeconds: undefined },
      "both cron and interval": { cron: "* * * * *" },
      "interval 0": { intervalSeconds: 0 },
      "interval 1.5": { intervalSeconds: 1.5 },
      "interval a year and a day": { intervalSeconds: 366 * 86_400 + 1 },
      "bad cron": { intervalSeconds: undefined, cron: "61 * * * *" },
      "cron that never fires": { intervalSeconds: undefined, cron: "0 0 30 2 *" },
      "bad name": { name: "Has Space" },
      "empty name": { name: "" },
      "bad queue": { queue: "A/B" },
      "secret-looking payload key": { payload: { token: CANARY } },
    };
    for (const [what, patch] of Object.entries(bad)) {
      const err = await upsertSchedule(t.db, { ...ok, ...patch }).catch((e) => e);
      expect([what, err instanceof JobError]).toEqual([what, true]);
      expect(String(err)).not.toContain(CANARY);
    }
    expect(await sched(ok.name)).toBeUndefined();
  });

  test("is idempotent: the same spec keeps the schedule's place, a changed one restarts it", async () => {
    const name = `i-${uniq()}`;
    const first = await upsertSchedule(t.db, { name, intervalSeconds: 600, queue: "q", now: T0 });
    // A process restarting an hour later registers the same schedule again.
    const again = await upsertSchedule(t.db, {
      name,
      intervalSeconds: 600,
      queue: "q",
      payload: { v: 2 },
      now: at(10 * MIN - SEC),
    });
    expect(again.id).toBe(first.id);
    expect(again.nextRunAt).toEqual(first.nextRunAt);
    expect(again.payload).toEqual({ v: 2 }); // other fields are updated

    const faster = await upsertSchedule(t.db, {
      name,
      intervalSeconds: 60,
      queue: "q",
      now: at(10 * MIN - SEC),
    });
    expect(faster.nextRunAt).toEqual(at(11 * MIN - SEC));
    const asCron = await upsertSchedule(t.db, { name, cron: "0 * * * *", queue: "q", now: T0 });
    expect(asCron).toMatchObject({ cron: "0 * * * *", intervalSeconds: null });
    expect(asCron.nextRunAt).toEqual(at(60 * MIN));
  });

  test("a disabled schedule never fires, and re-enabling starts it afresh instead of firing a backlog", async () => {
    const [name, queue] = [`d-${uniq()}`, `q-${uniq()}`];
    await upsertSchedule(t.db, { name, intervalSeconds: 60, queue, enabled: false, now: T0 });
    expect(await fireDue(t.db, { now: at(10 * MIN) })).toBe(0);
    const back = await upsertSchedule(t.db, {
      name,
      intervalSeconds: 60,
      queue,
      now: at(30 * MIN),
    });
    expect(back.enabled).toBe(true);
    expect(back.nextRunAt).toEqual(at(31 * MIN));
    expect(await jobsOf(queue)).toEqual([]);
  });
});

describe("fireDue", () => {
  test("enqueues the job of every due schedule once and moves it on", async () => {
    const [name, queue] = [`f-${uniq()}`, `q-${uniq()}`];
    await upsertSchedule(t.db, {
      name,
      intervalSeconds: 60,
      queue,
      payload: { project: "p1" },
      now: T0,
    });
    expect(await fireDue(t.db, { now: at(59 * SEC) })).toBe(0); // not due yet
    expect(await jobsOf(queue)).toEqual([]);

    expect(await fireDue(t.db, { now: at(60 * SEC) })).toBe(1);
    const [job, ...rest] = await jobsOf(queue);
    expect(rest).toEqual([]);
    expect(job).toMatchObject({
      queue,
      payload: { project: "p1" },
      status: "queued",
      runAt: at(60 * SEC),
    });
    expect(await sched(name)).toMatchObject({ nextRunAt: at(120 * SEC), lastRunAt: at(60 * SEC) });

    expect(await fireDue(t.db, { now: at(60 * SEC) })).toBe(0); // the same tick again
    expect(await jobsOf(queue)).toHaveLength(1);
  });

  test("missed ticks are skipped, not replayed: one job, next run on the original grid", async () => {
    const [name, queue] = [`m-${uniq()}`, `q-${uniq()}`];
    await upsertSchedule(t.db, { name, intervalSeconds: 60, queue, now: T0 });
    // The workers were down for ten and a half intervals.
    expect(await fireDue(t.db, { now: at(10 * MIN + 30 * SEC) })).toBe(1);
    expect(await jobsOf(queue)).toHaveLength(1);
    expect((await sched(name))?.nextRunAt).toEqual(at(11 * MIN));
  });

  test("cron schedules move on to the next match after now", async () => {
    const [name, queue] = [`c-${uniq()}`, `q-${uniq()}`];
    await upsertSchedule(t.db, { name, cron: "*/5 * * * *", queue, now: T0 });
    expect(await fireDue(t.db, { now: at(7 * MIN) })).toBe(1); // due since 10:05
    expect((await sched(name))?.nextRunAt).toEqual(at(10 * MIN));
  });

  test("without an injected clock the database clock decides", async () => {
    const [name, queue] = [`k-${uniq()}`, `q-${uniq()}`];
    const due = Date.now() - 30 * MIN;
    await t.db
      .insert(schedules)
      .values({ name, intervalSeconds: 3600, queue, nextRunAt: new Date(due) });
    expect(await fireDue(t.db)).toBeGreaterThanOrEqual(1);
    expect(await jobsOf(queue)).toHaveLength(1);
    // Loose on purpose: the database container's clock may differ from this machine's.
    const next = (await sched(name))?.nextRunAt.getTime() ?? 0;
    expect(Math.abs(next - (due + 3_600_000))).toBeLessThan(MIN);
  });

  test("two workers firing at once enqueue exactly one job per tick", async () => {
    const [name, queue] = [`w-${uniq()}`, `q-${uniq()}`];
    const [a, b] = [own(), own()];
    await upsertSchedule(t.db, { name, intervalSeconds: 60, queue, now: T0 });
    for (let tick = 1; tick <= 12; tick++) {
      const now = at(tick * MIN);
      const fired = await Promise.all([fireDue(a, { now }), fireDue(b, { now })]);
      expect([tick, fired[0] + fired[1]]).toEqual([tick, 1]);
    }
    const rows = await jobsOf(queue);
    expect(rows.map((j) => j.runAt.getTime()).sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => at((i + 1) * MIN).getTime()),
    );
  });

  test("a worker that finds the schedule locked by another skips it instead of waiting or doubling", async () => {
    const [name, queue] = [`l-${uniq()}`, `q-${uniq()}`];
    const [a, b] = [own(), own()];
    await upsertSchedule(t.db, { name, intervalSeconds: 60, queue, now: T0 });
    const now = at(60 * SEC);
    let during = -1;
    await a.transaction(async (tx) => {
      expect(await fireDue(tx, { now })).toBe(1); // locked and moved on, not yet committed
      during = await fireDue(b, { now }); // must neither wait for the commit nor fire again
    });
    expect(during).toBe(0);
    expect(await fireDue(b, { now })).toBe(0);
    expect(await jobsOf(queue)).toHaveLength(1);
  });

  test("the job and the schedule's move commit together: a failure changes neither", async () => {
    const [name, queue] = [`x-${uniq()}`, `q-${uniq()}`];
    // Only a direct insert can produce a schedule `upsertSchedule` would refuse. The enqueue
    // succeeds, then working out the next run fails: the job must go with it.
    await t.db.insert(schedules).values({ name, cron: "not a cron", queue, nextRunAt: at(-MIN) });
    const failed: string[] = [];
    expect(await fireDue(t.db, { now: T0, onError: (n) => failed.push(n) })).toBe(0);
    expect(failed).toEqual([name]);
    expect(await jobsOf(queue)).toEqual([]);
    expect((await sched(name))?.nextRunAt).toEqual(at(-MIN));
    expect((await sched(name))?.lastRunAt).toBeNull();
  });

  test("a schedule that cannot fire does not stop the others, and is reported", async () => {
    const [bad, good, queue] = [`a-${uniq()}`, `b-${uniq()}`, `q-${uniq()}`];
    // Sorts first (oldest next_run_at), so a batch-wide rollback would starve `good`.
    await t.db
      .insert(schedules)
      .values({ name: bad, intervalSeconds: 60, queue: "Not A Queue", nextRunAt: at(-HOUR) });
    await upsertSchedule(t.db, { name: good, intervalSeconds: 60, queue, now: T0 });
    const errors: [string, unknown][] = [];
    const fired = await fireDue(t.db, {
      now: at(60 * SEC),
      onError: (n, e) => errors.push([n, e]),
    });
    expect(fired).toBe(1);
    expect(errors.map(([n]) => n)).toEqual([bad]);
    expect(errors[0]?.[1]).toBeInstanceOf(JobError);
    expect(await jobsOf(queue)).toHaveLength(1);
    expect((await sched(good))?.nextRunAt).toEqual(at(120 * SEC));
    expect((await sched(bad))?.nextRunAt).toEqual(at(-HOUR)); // still due: reported again next time
  });

  test("without an onError a failing schedule is skipped quietly", async () => {
    await t.db
      .insert(schedules)
      .values({ name: `q-${uniq()}`, cron: "x", queue: "q", nextRunAt: at(-MIN) });
    expect(await fireDue(t.db, { now: T0 })).toBe(0);
  });
});
