import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { backoffMs, claim, complete, enqueue, fail, JobError } from "./jobs";
import { jobs } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const CANARY = "SECRET-CANARY-7741";
// One queue per test keeps the tests independent in one database.
const queueName = () => `q-${crypto.randomUUID().slice(0, 8)}`;
const T0 = new Date("2030-01-01T00:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const get = async (id: string) => (await t.db.select().from(jobs).where(eq(jobs.id, id)))[0];
const one = <T>(rows: T[]): T => {
  const [row] = rows;
  if (!row) throw new Error("expected a row");
  return row;
};

describe("enqueue", () => {
  test("stores a queued job with defaults", async () => {
    const queue = queueName();
    const job = await enqueue(t.db, { queue, payload: { projectId: "p1" } });
    expect(job).toMatchObject({
      queue,
      payload: { projectId: "p1" },
      status: "queued",
      attempts: 0,
      maxAttempts: 5,
      lastError: null,
      lockedBy: null,
    });
  });

  test("rejects a bad queue name, bad attempts, and a payload that looks like it holds a secret", async () => {
    const queue = queueName();
    for (const bad of ["", "Has Space", "x".repeat(65), "a/b"]) {
      expect(enqueue(t.db, { queue: bad })).rejects.toThrow(JobError);
    }
    for (const maxAttempts of [0, -1, 1.5, 101]) {
      expect(enqueue(t.db, { queue, maxAttempts })).rejects.toThrow(JobError);
    }
    const err = await enqueue(t.db, { queue, payload: { token: CANARY } }).catch((e) => e);
    expect(err).toBeInstanceOf(JobError);
    expect(String(err)).toContain("job payload");
    expect(String(err)).not.toContain(CANARY);
    expect(await t.db.select().from(jobs).where(eq(jobs.queue, queue))).toEqual([]);
  });

  test("runs inside the caller's transaction: a rollback takes the job with it", async () => {
    const queue = queueName();
    await t.db
      .transaction(async (tx) => {
        await enqueue(tx, { queue });
        throw new Error("abort");
      })
      .catch(() => {});
    expect(await t.db.select().from(jobs).where(eq(jobs.queue, queue))).toEqual([]);
  });
});

describe("claim", () => {
  test("hands out due jobs oldest first, once, and counts the attempt", async () => {
    const queue = queueName();
    const late = await enqueue(t.db, { queue, runAt: at(-1_000) });
    const early = await enqueue(t.db, { queue, runAt: at(-5_000) });
    await enqueue(t.db, { queue, runAt: at(60_000) }); // not due yet
    const got = await claim(t.db, { queues: [queue], workerId: "w1", limit: 5, now: T0 });
    expect(got.map((j) => j.id)).toEqual([early.id, late.id]);
    expect(got[0]).toMatchObject({ status: "running", attempts: 1, lockedBy: "w1" });
    expect(got[0]?.lockedAt).toEqual(T0);
    expect(await claim(t.db, { queues: [queue], workerId: "w2", now: T0 })).toEqual([]);
  });

  test("only takes the queues it is given, and respects the limit", async () => {
    const [a, b] = [queueName(), queueName()];
    await enqueue(t.db, { queue: a, runAt: at(-1) });
    const earlier = await enqueue(t.db, { queue: a, runAt: at(-2) }); // inserted second, due first
    await enqueue(t.db, { queue: b, runAt: at(-1) });
    const got = await claim(t.db, { queues: [a], workerId: "w", limit: 1, now: T0 });
    expect(got.map((j) => j.id)).toEqual([earlier.id]); // the limit cuts off the latest, not the first inserted
    expect(await claim(t.db, { queues: [], workerId: "w", now: T0 })).toEqual([]);
    expect((await claim(t.db, { queues: [b], workerId: "w", now: T0 })).length).toBe(1);
  });

  test("skips rows another transaction holds locked (SKIP LOCKED), instead of waiting", async () => {
    const queue = queueName();
    for (let i = 0; i < 4; i++) await enqueue(t.db, { queue, runAt: at(-1) });
    await t.db.transaction(async (tx) => {
      const first = await claim(tx, { queues: [queue], workerId: "a", limit: 2, now: T0 });
      // Uncommitted: a second connection must see those two as locked and take the others.
      const second = await claim(t.db, { queues: [queue], workerId: "b", limit: 4, now: T0 });
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(new Set([...first, ...second].map((j) => j.id)).size).toBe(4);
    });
  });

  test("a job whose worker vanished is handed out again after the lock times out", async () => {
    const queue = queueName();
    const job = await enqueue(t.db, { queue, runAt: at(-1) });
    await claim(t.db, { queues: [queue], workerId: "lost", lockTimeoutMs: 60_000, now: T0 });
    expect(
      await claim(t.db, { queues: [queue], workerId: "b", lockTimeoutMs: 60_000, now: at(59_000) }),
    ).toEqual([]);
    const again = await claim(t.db, {
      queues: [queue],
      workerId: "b",
      lockTimeoutMs: 60_000,
      now: at(61_000),
    });
    expect(again[0]).toMatchObject({ id: job.id, attempts: 2, lockedBy: "b" });
  });

  test("a job that keeps losing its worker goes dead instead of looping forever", async () => {
    const queue = queueName();
    const job = await enqueue(t.db, { queue, runAt: at(-1), maxAttempts: 2 });
    for (const now of [T0, at(61_000), at(122_000)]) {
      await claim(t.db, { queues: [queue], workerId: "w", lockTimeoutMs: 60_000, now });
    }
    expect(await get(job.id)).toMatchObject({ status: "dead", attempts: 2, lockedBy: null });
    expect((await get(job.id))?.lastError).toContain("lock expired");
  });
});

describe("complete and fail", () => {
  const claimed = async (opts: { maxAttempts?: number } = {}) => {
    const queue = queueName();
    await enqueue(t.db, { queue, runAt: at(-1), ...opts });
    return one(await claim(t.db, { queues: [queue], workerId: "w1", now: T0 }));
  };

  test("complete marks the job done and releases the lock", async () => {
    const job = await claimed();
    expect(await complete(t.db, job, "w1")).toBe(true);
    expect(await get(job.id)).toMatchObject({ status: "done", lockedBy: null, lockedAt: null });
    expect(await complete(t.db, job, "w1")).toBe(false); // already finished
  });

  test("fail requeues with exponential backoff", async () => {
    const job = await claimed({ maxAttempts: 4 });
    expect(await fail(t.db, job, "w1", new Error("boom"), { now: T0 })).toBe("queued");
    expect(await get(job.id)).toMatchObject({
      status: "queued",
      lockedBy: null,
      runAt: at(backoffMs(1)),
      lastError: "Error: boom",
    });
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(3));
  });

  test("backoff is capped and never overflows", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(50)).toBe(15 * 60_000);
    expect(backoffMs(100_000)).toBe(15 * 60_000);
    expect(backoffMs(1, { baseMs: 10, capMs: 5 })).toBe(5);
  });

  test("the last allowed attempt that fails is dead, and stays dead", async () => {
    const queue = queueName();
    await enqueue(t.db, { queue, runAt: at(-1), maxAttempts: 2 });
    let status: string | undefined;
    for (let i = 0, now = T0; i < 2; i++, now = at(10 * 60_000 * (i + 1))) {
      const job = one(await claim(t.db, { queues: [queue], workerId: "w", now }));
      status = await fail(t.db, job, "w", new Error("nope"), { now, backoff: () => 0 });
    }
    expect(status).toBe("dead");
    expect(await claim(t.db, { queues: [queue], workerId: "w", now: at(24 * 3_600_000) })).toEqual(
      [],
    );
  });

  test("last_error is scrubbed, one line, and bounded", async () => {
    const job = await claimed();
    const error = new Error(
      `GET https://oauth2:${CANARY}@gitlab.test/x failed\n password=${CANARY} Bearer ${CANARY} glpat-${CANARY}-zz ${"x".repeat(2_000)}`,
    );
    await fail(t.db, job, "w1", error, { now: T0 });
    const { lastError } = (await get(job.id)) ?? {};
    expect(lastError).not.toContain(CANARY);
    expect(lastError).toContain("gitlab.test");
    expect(lastError).not.toContain("\n");
    expect(lastError?.length).toBeLessThanOrEqual(500);
  });

  test("a thrown string or object is described, never dumped", async () => {
    const a = await claimed();
    await fail(t.db, a, "w1", `token=${CANARY}`, { now: T0 });
    expect((await get(a.id))?.lastError).not.toContain(CANARY);
    const b = await claimed();
    await fail(t.db, b, "w1", { secret: CANARY, toString: () => CANARY }, { now: T0 });
    expect((await get(b.id))?.lastError).not.toContain(CANARY);
  });

  test("a failed database query does not put its bound parameters into last_error", async () => {
    const job = await claimed();
    // A real driver error: Drizzle's message carries `params: ...` with the values it bound.
    const error = await t.db
      .insert(jobs)
      .values({ id: job.id, queue: job.queue, payload: { note: CANARY } })
      .then(
        () => new Error("the duplicate id should have been refused"),
        (e) => e,
      );
    expect(String(error.message)).toContain(CANARY); // the premise: the raw error does leak
    await fail(t.db, job, "w1", error, { now: T0 });
    const { lastError } = (await get(job.id)) ?? {};
    expect(lastError).toContain("Failed query");
    expect(lastError).not.toContain(CANARY);
  });

  test("a worker that lost the job cannot finish or fail it (fencing)", async () => {
    const queue = queueName();
    const job = await enqueue(t.db, { queue, runAt: at(-1) });
    const first = one(
      await claim(t.db, { queues: [queue], workerId: "slow", lockTimeoutMs: 60_000, now: T0 }),
    );
    const second = one(
      await claim(t.db, {
        queues: [queue],
        workerId: "fast",
        lockTimeoutMs: 60_000,
        now: at(61_000),
      }),
    );
    expect(second.attempts).toBe(2);
    expect(await complete(t.db, first, "slow")).toBe(false);
    expect(await fail(t.db, first, "slow", new Error("late"), { now: at(62_000) })).toBeUndefined();
    expect(await complete(t.db, second, "slow")).toBe(false); // right attempt, wrong worker
    expect(await get(job.id)).toMatchObject({ status: "running", lockedBy: "fast" });
    expect(await complete(t.db, second, "fast")).toBe(true);
  });

  test("a stale run cannot finish a job its own worker has claimed again (attempt is the fence)", async () => {
    const queue = queueName();
    await enqueue(t.db, { queue, runAt: at(-1) });
    const stale = one(
      await claim(t.db, { queues: [queue], workerId: "w", lockTimeoutMs: 60_000, now: T0 }),
    );
    // The handler is still running when its lock expires and the same worker's poll loop claims the job again.
    const again = one(
      await claim(t.db, { queues: [queue], workerId: "w", lockTimeoutMs: 60_000, now: at(61_000) }),
    );
    expect(again.attempts).toBe(2);
    expect(await complete(t.db, stale, "w")).toBe(false);
    expect(await fail(t.db, stale, "w", "late", { now: at(62_000) })).toBeUndefined();
    expect(await complete(t.db, again, "w")).toBe(true);
  });
});

describe("database clock", () => {
  test("without an injected `now`, due time, lock age and backoff all follow the database clock", async () => {
    const queue = queueName();
    const HOUR = 3_600_000;
    await enqueue(t.db, { queue, runAt: new Date(Date.now() + HOUR) });
    expect(await claim(t.db, { queues: [queue], workerId: "w1" })).toEqual([]);

    const due = await enqueue(t.db, { queue }); // run_at defaults to the database's now()
    const first = one(await claim(t.db, { queues: [queue], workerId: "w1", limit: 5 }));
    expect(first.id).toBe(due.id);
    expect(await claim(t.db, { queues: [queue], workerId: "w2" })).toEqual([]); // still locked

    await Bun.sleep(5);
    const second = one(await claim(t.db, { queues: [queue], workerId: "w2", lockTimeoutMs: 0 }));
    expect(second).toMatchObject({ id: due.id, attempts: 2, lockedBy: "w2" });

    expect(await fail(t.db, second, "w2", "boom", { backoff: () => HOUR })).toBe("queued");
    const after = one(await t.db.select().from(jobs).where(eq(jobs.id, due.id)));
    // Loose on purpose: the database container's clock may differ from this machine's.
    expect(Math.abs(after.runAt.getTime() - (Date.now() + HOUR))).toBeLessThan(5 * 60_000);
  });
});
