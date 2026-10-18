import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq, sql } from "drizzle-orm";
import {
  disableForwarding,
  dueForwards,
  enableForwarding,
  FORWARD_SETTLE_MS,
  ForwardFailure,
  forwardBackoffMs,
  forwardStep,
  getForwarding,
  idAt,
} from "./audit-forwarding";
import type { AuditRow } from "./audit-log";
import { createSink, deleteSink } from "./notifications";
import { createOrganization } from "./repo";
import { auditEvents, auditForwards } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000);

/** A v7 uuid of the given millisecond; `tail` orders ids of one millisecond. */
const v7 = (ms: number, tail = 0) => {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${tail.toString(16).padStart(12, "0")}`;
};

let n = 0;
const world = async () => {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const sink = await createSink(t.db, keys, {
    organizationId: org.id,
    kind: "webhook",
    name: `s${++n}`,
    host: "logs.example.com",
    secret: '{"url":"https://logs.example.com/in?token=SINKTOKEN","secret":"whsec_X"}',
  });
  return { org: org.id, sink: sink.id };
};
type World = Awaited<ReturnType<typeof world>>;

/** The ids of one millisecond differ in their tail, and an id is unique in the whole table. */
let seq = 1000;

/** An event of the organization whose id was written `seconds` after T0. */
async function event(org: string | null, seconds: number, tail = seq++, action = "thing.update") {
  const id = v7(T0 + seconds * 1000, tail);
  await t.db.insert(auditEvents).values({
    id,
    organizationId: org,
    actorKind: "user",
    actorId: "u1",
    action,
    resourceType: "thing",
  });
  return id;
}

const enable = (w: World, from: "now" | "start", now = at(0)) =>
  enableForwarding(t.db, { organizationId: w.org, sinkId: w.sink, from, now });

/** Steps with a sink that records what it is handed. */
function receiver(
  over: (events: AuditRow[]) => Promise<void> | void = () => {},
  o: { batch?: number } = {},
) {
  const received: string[][] = [];
  return {
    received,
    step: (w: World, now: Date) =>
      forwardStep(t.db, {
        sinkId: w.sink,
        now,
        batch: o.batch ?? 100,
        send: async (_f, events) => {
          await over(events);
          received.push(events.map((e) => e.id));
        },
      }),
  };
}
const flat = (r: { received: string[][] }) => r.received.flat();

describe("where it starts", () => {
  test("from the start sends the whole log, from now only what is written after", async () => {
    const a = await world();
    const b = await world();
    const old = await event(a.org, -3600);
    await event(b.org, -3600);
    await enable(a, "start");
    await enable(b, "now");
    const fresh = await event(a.org, 5);
    const freshB = await event(b.org, 5);
    const ra = receiver();
    const rb = receiver();
    expect(await ra.step(a, at(120))).toEqual({ result: "sent", count: 2 });
    expect(await rb.step(b, at(120))).toEqual({ result: "sent", count: 1 });
    expect(flat(ra)).toEqual([old, fresh]);
    expect(flat(rb)).toEqual([freshB]);
  });

  test("enabling twice keeps the place it had, and a sink of another organization is refused", async () => {
    const w = await world();
    const other = await world();
    const first = await enable(w, "start");
    expect(first.created).toBe(true);
    await event(w.org, 1);
    await receiver().step(w, at(120));
    const moved = (await getForwarding(t.db, w.org, w.sink))?.cursor;
    const again = await enable(w, "now", at(300));
    expect([again.created, again.forwarding.cursor]).toEqual([false, moved ?? ""]);
    await expect(
      enableForwarding(t.db, {
        organizationId: other.org,
        sinkId: w.sink,
        from: "now",
        now: at(0),
      }),
    ).rejects.toThrow();
    expect(await getForwarding(t.db, other.org, w.sink)).toBeUndefined();

    // a sink with no forwarding yet is refused by the table itself, not found missing afterwards
    const fresh = await world();
    await expect(
      enableForwarding(t.db, {
        organizationId: other.org,
        sinkId: fresh.sink,
        from: "now",
        now: at(0),
      }),
    ).rejects.toThrow();
    expect(
      await t.db.select().from(auditForwards).where(eq(auditForwards.sinkId, fresh.sink)),
    ).toEqual([]);
  });

  test("the table refuses a count of failures below zero", async () => {
    const w = await world();
    await enable(w, "now");
    // a query builder is not a promise until it is awaited
    await expect(
      (async () =>
        await t.db
          .update(auditForwards)
          .set({ failures: -1 })
          .where(eq(auditForwards.sinkId, w.sink)))(),
    ).rejects.toThrow();
  });

  test("a forwarding is stopped by its organization only, and goes with its sink", async () => {
    const w = await world();
    const other = await world();
    await enable(w, "now");
    expect(await disableForwarding(t.db, other.org, w.sink)).toBe(false);
    expect(await getForwarding(t.db, w.org, w.sink)).toBeDefined();
    expect(await disableForwarding(t.db, w.org, w.sink)).toBe(true);
    expect(await disableForwarding(t.db, w.org, w.sink)).toBe(false);

    await enable(w, "now");
    expect(await deleteSink(t.db, w.org, w.sink)).toBe(true);
    expect(await t.db.select().from(auditForwards).where(eq(auditForwards.sinkId, w.sink))).toEqual(
      [],
    );
  });
});

describe("what is sent, and in what order", () => {
  test("the organization's events, in id order, in batches, none twice and none missed", async () => {
    const w = await world();
    await enable(w, "start");
    const ids = [];
    // written out of order on purpose: the order is the id's, not the insert's
    for (const [s, tail] of [
      [3, 0],
      [1, 0],
      [2, 9],
      [2, 1],
      [5, 0],
    ] as const) {
      ids.push(await event(w.org, s, tail));
    }
    const r = receiver(() => {}, { batch: 2 });
    const now = at(600);
    expect(await r.step(w, now)).toEqual({ result: "sent", count: 2 });
    expect(await r.step(w, now)).toEqual({ result: "sent", count: 2 });
    expect(await r.step(w, now)).toEqual({ result: "sent", count: 1 });
    expect(await r.step(w, now)).toEqual({ result: "idle" });
    expect(flat(r)).toEqual([...ids].sort());
    expect((await getForwarding(t.db, w.org, w.sink))?.cursor).toBe([...ids].sort().at(-1) ?? "");
  });

  test("the order is asked of the database, not left to the plan it happens to choose", async () => {
    const w = await world();
    await enable(w, "start");
    const ids = [];
    for (const s of [3, 1, 2]) ids.push(await event(w.org, s));
    const sent: string[] = [];
    await t.db.transaction(async (tx) => {
      // a sequential scan returns rows as they were inserted, so only an ORDER BY puts them right
      await tx.execute(sql`set local enable_indexscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      await forwardStep(tx, {
        sinkId: w.sink,
        now: at(600),
        send: async (_f, events) => {
          sent.push(...events.map((e) => e.id));
        },
      });
    });
    expect(sent).toEqual([...ids].sort());
  });

  test("never another organization's events, nor those of none", async () => {
    const w = await world();
    const other = await world();
    await enable(w, "start");
    const mine = await event(w.org, 1);
    await event(other.org, 2);
    await event(null, 3);
    const r = receiver();
    await r.step(w, at(600));
    expect(flat(r)).toEqual([mine]);
  });

  test("an event is held back until its id is old enough, and one that lands late behind a newer id still goes in order", async () => {
    const w = await world();
    await enable(w, "start");
    const newer = await event(w.org, 100);
    const r = receiver();
    // 100 s after T0 is not yet 30 s old at T0 + 110
    expect(await r.step(w, at(110))).toEqual({ result: "idle" });
    // a slower transaction commits an event whose id is lower than the one already there
    const older = await event(w.org, 95);
    expect(await r.step(w, at(110))).toEqual({ result: "idle" });
    expect(await r.step(w, at(100 + FORWARD_SETTLE_MS / 1000 + 1))).toEqual({
      result: "sent",
      count: 2,
    });
    expect(flat(r)).toEqual([older, newer]);
  });

  test("the cutoff id is above every id of its millisecond and below the next", () => {
    const ms = T0 + 123;
    expect(v7(ms, 0xffffffffffff) <= idAt(new Date(ms))).toBe(true);
    expect(v7(ms + 1, 0) > idAt(new Date(ms))).toBe(true);
    expect(v7(ms - 1, 0xffffffffffff) < idAt(new Date(ms))).toBe(true);
  });
});

describe("a sink that does not take it", () => {
  test("the cursor stays, the failure is recorded as a fixed sentence, and the same events are sent again when it is time", async () => {
    const w = await world();
    await enable(w, "start");
    const ids = [await event(w.org, 1), await event(w.org, 2)];
    let up = false;
    const r = receiver((events) => {
      if (!up) throw new ForwardFailure("sink answered 500");
      expect(events).toHaveLength(2);
    });
    const now = at(120);
    expect(await r.step(w, now)).toEqual({ result: "failed" });
    const failed = await getForwarding(t.db, w.org, w.sink);
    expect(failed).toMatchObject({
      failures: 1,
      lastError: "sink answered 500",
      deliveredAt: null,
    });
    expect(failed?.cursor).toBe("00000000-0000-0000-0000-000000000000");
    expect(failed?.nextAttemptAt.getTime()).toBe(now.getTime() + 30_000);
    // not asked again before its time, and due at it
    expect(await dueForwards(t.db, new Date(now.getTime() + 29_999), 1000)).not.toContain(w.sink);
    expect(await r.step(w, new Date(now.getTime() + 29_999))).toEqual({ result: "skipped" });
    expect(await dueForwards(t.db, new Date(now.getTime() + 30_000), 1000)).toContain(w.sink);

    up = true;
    const later = new Date(now.getTime() + 30_000);
    expect(await r.step(w, later)).toEqual({ result: "sent", count: 2 });
    expect(flat(r)).toEqual(ids);
    expect(await getForwarding(t.db, w.org, w.sink)).toMatchObject({
      cursor: ids[1],
      failures: 0,
      lastError: null,
    });
  });

  test("each failure waits twice as long as the one before, to an hour", async () => {
    expect([1, 2, 3, 4, 8, 9, 20].map(forwardBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    const w = await world();
    await enable(w, "start");
    await event(w.org, 1);
    const r = receiver(() => {
      throw new ForwardFailure("sink could not be reached");
    });
    let now = at(120);
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await r.step(w, now);
      const f = await getForwarding(t.db, w.org, w.sink);
      waits.push((f?.nextAttemptAt.getTime() ?? 0) - now.getTime());
      now = f?.nextAttemptAt ?? now;
    }
    expect(waits).toEqual([30_000, 60_000, 120_000]);
  });

  test("whatever else goes wrong is recorded as a plain sentence: nothing a sink or a library said is kept", async () => {
    const w = await world();
    await enable(w, "start");
    await event(w.org, 1);
    const r = receiver(() => {
      throw new Error("connect ECONNREFUSED https://logs.example.com/in?token=SINKTOKEN");
    });
    expect(await r.step(w, at(120))).toEqual({ result: "failed" });
    const f = await getForwarding(t.db, w.org, w.sink);
    expect(f?.lastError).toBe("delivery failed");
    expect(JSON.stringify(f)).not.toContain("SINKTOKEN");
  });

  test("after downtime it resumes where it stopped: everything written meanwhile arrives, in order", async () => {
    const w = await world();
    await enable(w, "now", at(0));
    let up = true;
    const r = receiver(() => {
      if (!up) throw new ForwardFailure("sink could not be reached");
    });
    const ids = [await event(w.org, 10)];
    expect(await r.step(w, at(60))).toEqual({ result: "sent", count: 1 });
    up = false;
    // down for three tries, each later than the backoff of the one before, with the log growing
    ids.push(await event(w.org, 70));
    expect(await r.step(w, at(120))).toEqual({ result: "failed" });
    ids.push(await event(w.org, 170));
    expect(await r.step(w, at(200))).toEqual({ result: "failed" });
    ids.push(await event(w.org, 270));
    expect(await r.step(w, at(330))).toEqual({ result: "failed" });
    expect(flat(r)).toEqual(ids.slice(0, 1));
    expect((await getForwarding(t.db, w.org, w.sink))?.failures).toBe(3);
    up = true;
    ids.push(await event(w.org, 400));
    expect(await r.step(w, at(450))).toEqual({ result: "sent", count: 4 });
    expect(flat(r)).toEqual(ids);
    expect(await r.step(w, at(500))).toEqual({ result: "idle" });
  });

  test("a batch the sink took but did not answer for is sent again: duplicates arrive, and deduping by event id gives the log", async () => {
    const w = await world();
    await enable(w, "start");
    const ids = [await event(w.org, 1), await event(w.org, 2), await event(w.org, 3)];
    const seen: string[] = [];
    let lost = true;
    const step = (now: Date) =>
      forwardStep(t.db, {
        sinkId: w.sink,
        now,
        send: async (_f, events) => {
          // the collector has the batch ...
          seen.push(...events.map((e) => e.id));
          // ... but its answer never comes back
          if (lost) {
            lost = false;
            throw new Error("timeout");
          }
        },
      });
    expect(await step(at(120))).toEqual({ result: "failed" });
    expect(await step(at(150))).toEqual({ result: "sent", count: 3 });
    expect(seen).toEqual([...ids, ...ids]);
    expect([...new Set(seen)]).toEqual(ids);
  });

  test("two workers at once: one sends, the other leaves it to it", async () => {
    const w = await world();
    await enable(w, "start");
    await event(w.org, 1);
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let started = () => {};
    const running = new Promise<void>((r) => {
      started = r;
    });
    const sent: number[] = [];
    const first = forwardStep(t.db, {
      sinkId: w.sink,
      now: at(120),
      send: async (_f, events) => {
        started();
        await held;
        sent.push(events.length);
      },
    });
    await running;
    const second = await forwardStep(t.db, {
      sinkId: w.sink,
      now: at(120),
      send: async () => {
        sent.push(-1);
      },
    });
    expect(second).toEqual({ result: "skipped" });
    release();
    expect(await first).toEqual({ result: "sent", count: 1 });
    expect(sent).toEqual([1]);
  });
});

describe("whose turn it is", () => {
  test("the sinks that have waited longest come first, up to the limit", async () => {
    // ten days before everything else here, so no other test's sink is due
    const early = (seconds: number) => new Date(T0 - 10 * 86_400_000 + seconds * 1000);
    const a = await world();
    const b = await world();
    const c = await world();
    await enable(a, "now", early(30));
    await enable(b, "now", early(10));
    await enable(c, "now", early(20));
    expect(await dueForwards(t.db, early(100), 2)).toEqual([b.sink, c.sink]);
    expect(await dueForwards(t.db, early(15), 5)).toEqual([b.sink]);
  });
});
