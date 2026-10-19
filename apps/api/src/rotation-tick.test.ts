import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  AUTO_SYNC_QUEUE,
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  createSink,
  createSyncTarget,
  createVariable,
  getRotation,
  jobs,
  NOTIFY_QUEUE,
  setRotation,
  setSubscriptions,
  variableRotations,
  variables,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { fakeRotator, RotationError, type Rotator } from "@orch/rotation";
import { and, eq, sql } from "drizzle-orm";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  FAILING_AFTER,
  rotationTickHandler,
} from "./rotation-tick";
import type { JobContext } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const actor = { kind: "user", id: "u1" };
const T0 = new Date();
const MIN = 60_000;
const DAY = 86_400_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const CANARY = "tick-canary-9c1e7b";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
// claimDue takes whatever is due, so a row left by an earlier test would be handed to this one
beforeEach(async () => {
  await t.db.delete(variableRotations);
});

const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
beforeEach(() => {
  lines.length = 0;
});

const ctx = (over: Partial<JobContext> = {}): JobContext => ({
  id: "0198d6f0-0000-7000-8000-000000000002",
  queue: "rotation.tick",
  payload: {},
  attempt: 1,
  maxAttempts: 3,
  log: logger,
  signal: new AbortController().signal,
  ...over,
});
/** One run of the schedule's job, as of `now`. */
const tick = (rotators: Record<string, Rotator>, now: Date, over: { batch?: number } = {}) =>
  rotationTickHandler({
    db: t.db,
    keys,
    rotators: new Map(Object.entries(rotators)),
    logger,
    now: () => now,
    ...over,
  })(ctx());

let n = 0;
async function world() {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: "api" });
  const scope = { organizationId: org.id, projectId: project.id };
  const rotating = async (
    over: { provider?: string; graceDays?: number; level?: "org" | "project" } = {},
  ) => {
    const where = over.level === "org" ? { organizationId: org.id } : scope;
    const variable = await createVariable(t.db, keys, {
      ...where,
      key: `K${++n}`,
      kind: "secret",
      value: "old-value",
      actor,
    });
    const set = await setRotation(t.db, {
      organizationId: org.id,
      variableId: variable.id,
      provider: over.provider ?? "fake",
      config: { name: "a" },
      intervalDays: 30,
      graceDays: over.graceDays ?? 0,
      now: T0,
    });
    if ("error" in set) throw new Error(set.error);
    return { variable, rotationId: set.row.id };
  };
  const row = async (variableId: string) => {
    const r = await getRotation(t.db, org.id, variableId);
    if (!r) throw new Error("no rotation");
    return r;
  };
  const version = async (variableId: string) =>
    (
      await t.db
        .select({ v: variables.currentVersion })
        .from(variables)
        .where(eq(variables.id, variableId))
    )[0]?.v;
  const sink = async (events: ("rotation.failing" | "stack.drift")[] = ["rotation.failing"]) => {
    const url = "https://hooks.slack.com/services/T000/B000/XXXX";
    const s = await createSink(t.db, keys, {
      organizationId: org.id,
      kind: "slack",
      name: `s${++n}`,
      host: "hooks.slack.com",
      secret: JSON.stringify({ url }),
    });
    await setSubscriptions(t.db, {
      organizationId: org.id,
      projectId: project.id,
      sinkId: s.id,
      events,
    });
    return s;
  };
  const told = async (sinkId: string) =>
    (await t.db.select().from(jobs).where(eq(jobs.queue, NOTIFY_QUEUE))).filter(
      (j) => (j.payload as { sinkId: string }).sinkId === sinkId,
    );
  const events = async (action: string) =>
    (
      await t.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.organizationId, org.id), eq(auditEvents.action, action)))
    ).length;
  return { org, project, scope, rotating, row, version, sink, told, events };
}

describe("a rotation that is due", () => {
  test("two workers at once rotate it once", async () => {
    const w = await world();
    const { variable } = await w.rotating();
    const f = fakeRotator();

    await Promise.all([
      tick({ fake: f.rotator }, at(31 * DAY)),
      tick({ fake: f.rotator }, at(31 * DAY)),
    ]);

    expect(f.calls.filter((c) => c.op === "mint")).toHaveLength(1);
    expect(await w.version(variable.id)).toBe(2);
    const r = await w.row(variable.id);
    expect([r.lastStatus, r.attempts]).toEqual(["ok", 0]);
    // not due again for a month
    await tick({ fake: f.rotator }, at(32 * DAY));
    expect(f.calls.filter((c) => c.op === "mint")).toHaveLength(1);
  });

  test("one that is not due yet is left alone", async () => {
    const w = await world();
    const { variable } = await w.rotating();
    const f = fakeRotator();
    await tick({ fake: f.rotator }, at(29 * DAY));
    expect(f.calls).toEqual([]);
    expect(await w.version(variable.id)).toBe(1);
  });

  test("the new version queues the sync of an auto-sync target (SYNC-7)", async () => {
    const w = await world();
    const connection = await createConnection(t.db, keys, {
      organizationId: w.org.id,
      type: "gitlab",
      name: "gl",
      token: "glpat-SECRET-TOKEN-0123456789",
    });
    const target = await createSyncTarget(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      connectionId: connection.id,
      name: "t",
      type: "gitlab-variables",
      config: { project: 7 },
      autoSync: true,
    });
    await w.rotating();
    // creating the variable queued one already, and a job that waits is not queued twice
    await t.db.delete(jobs).where(eq(jobs.queue, AUTO_SYNC_QUEUE));
    const waiting = () =>
      t.db
        .select()
        .from(jobs)
        .where(eq(jobs.queue, AUTO_SYNC_QUEUE))
        .then((all) =>
          all.filter((j) => (j.payload as { targetId: string }).targetId === target.id),
        );
    expect(await waiting()).toHaveLength(0);

    await tick({ fake: fakeRotator().rotator }, at(31 * DAY));

    expect(await waiting()).toHaveLength(1);
  });

  test("an aborted run stops between rotations and leaves the rest for later", async () => {
    const w = await world();
    const a = await w.rotating();
    await w.rotating();
    const f = fakeRotator();
    const controller = new AbortController();
    controller.abort();
    await rotationTickHandler({
      db: t.db,
      keys,
      rotators: new Map([["fake", f.rotator]]),
      logger,
      now: () => at(31 * DAY),
    })(ctx({ signal: controller.signal }));
    expect(f.calls).toEqual([]);
    expect(await w.version(a.variable.id)).toBe(1);
  });
});

describe("a rotation that fails", () => {
  test("keeps the old value, backs off by doubling, and is tried again when its time comes", async () => {
    const w = await world();
    const { variable } = await w.rotating();
    const f = fakeRotator();
    f.failWith("failed");

    await tick({ fake: f.rotator }, at(31 * DAY));
    let r = await w.row(variable.id);
    expect([r.attempts, r.lastError, r.lastStatus]).toEqual([1, "failed", "never"]);
    expect(r.nextAt).toEqual(at(31 * DAY + BACKOFF_BASE_MS));
    expect(await w.version(variable.id)).toBe(1);

    // before its time: nothing
    await tick({ fake: f.rotator }, at(31 * DAY + 5 * MIN));
    expect((await w.row(variable.id)).attempts).toBe(1);

    await tick({ fake: f.rotator }, at(31 * DAY + BACKOFF_BASE_MS));
    r = await w.row(variable.id);
    expect(r.attempts).toBe(2);
    expect(r.nextAt).toEqual(at(31 * DAY + BACKOFF_BASE_MS + 2 * BACKOFF_BASE_MS));
    expect(await w.version(variable.id)).toBe(1);
  });

  test("the wait is capped", async () => {
    const w = await world();
    const { variable, rotationId } = await w.rotating();
    await t.db
      .update(variableRotations)
      .set({ attempts: 30 })
      .where(eq(variableRotations.id, rotationId));
    const f = fakeRotator();
    f.failWith("failed");
    await tick({ fake: f.rotator }, at(31 * DAY));
    expect((await w.row(variable.id)).nextAt).toEqual(at(31 * DAY + BACKOFF_CAP_MS));
  });

  test("after N failures it is `failing`, the sinks that asked are told once, and a success clears it", async () => {
    const w = await world();
    const { variable } = await w.rotating();
    const hears = await w.sink();
    const driftOnly = await w.sink(["stack.drift"]);
    const f = fakeRotator();
    f.failWith("denied");

    let now = at(31 * DAY);
    for (let i = 1; i < FAILING_AFTER; i++) {
      await tick({ fake: f.rotator }, now);
      expect((await w.row(variable.id)).lastStatus).toBe("never");
      expect(await w.told(hears.id)).toHaveLength(0);
      now = (await w.row(variable.id)).nextAt;
    }
    await tick({ fake: f.rotator }, now);
    let r = await w.row(variable.id);
    expect([r.lastStatus, r.attempts, r.lastError]).toEqual(["failing", FAILING_AFTER, "denied"]);

    const [job, ...more] = await w.told(hears.id);
    expect(more).toEqual([]);
    expect(job?.payload).toMatchObject({
      event: "rotation.failing",
      projectName: "api",
      provider: "fake",
      attempts: FAILING_AFTER,
    });
    expect(await w.told(driftOnly.id)).toHaveLength(0);
    expect(await w.events("variable.rotate_failing")).toBe(1);

    // still failing, not told again
    await tick({ fake: f.rotator }, r.nextAt);
    r = await w.row(variable.id);
    expect([r.lastStatus, r.attempts]).toEqual(["failing", FAILING_AFTER + 1]);
    expect(await w.told(hears.id)).toHaveLength(1);
    expect(await w.events("variable.rotate_failing")).toBe(1);

    f.failWith(null);
    await tick({ fake: f.rotator }, r.nextAt);
    r = await w.row(variable.id);
    expect([r.lastStatus, r.attempts, r.lastError]).toEqual(["ok", 0, null]);
    expect(await w.version(variable.id)).toBe(2);
  });

  test("an alert that cannot be made does not undo the count: the rotation is still `failing` and backs off", async () => {
    const w = await world();
    const { variable } = await w.rotating();
    const f = fakeRotator();
    f.failWith("denied");
    await t.db.execute(sql`create function refuse_alert() returns trigger language plpgsql as $$
      begin
        if new.action = 'variable.rotate_failing' then raise exception 'no alerts today'; end if;
        return new;
      end $$`);
    await t.db.execute(
      sql`create trigger refuse_alert before insert on audit_events for each row execute function refuse_alert()`,
    );
    try {
      let now = at(31 * DAY);
      let last = now;
      for (let i = 0; i < FAILING_AFTER; i++) {
        last = now;
        await tick({ fake: f.rotator }, now);
        now = (await w.row(variable.id)).nextAt;
      }
      const r = await w.row(variable.id);
      // counted, marked, and waiting out its backoff rather than the 15 minutes of the claim
      expect([r.lastStatus, r.attempts]).toEqual(["failing", FAILING_AFTER]);
      expect(r.nextAt.getTime() - last.getTime()).toBe(BACKOFF_BASE_MS * 2 ** (FAILING_AFTER - 1));
      expect(lines.join("\n")).toContain("could not record its failure or tell of it");
    } finally {
      await t.db.execute(sql`drop trigger refuse_alert on audit_events`);
      await t.db.execute(sql`drop function refuse_alert()`);
    }
  });

  test("a failure of one does not stop the others, and a provider this deployment lacks is a config failure", async () => {
    const w = await world();
    const gone = await w.rotating({ provider: "unheard-of" });
    const fine = await w.rotating();
    const f = fakeRotator();

    await tick({ fake: f.rotator }, at(31 * DAY));

    expect((await w.row(gone.variable.id)).lastError).toBe("invalid_config");
    expect(await w.version(fine.variable.id)).toBe(2);
  });

  test("what is not a provider's error is `internal`; the row and the news carry no text of it and the log only what the scrubber lets through", async () => {
    const w = await world();
    const { variable } = await w.rotating();
    const hears = await w.sink();
    const f = fakeRotator();
    const broken: Rotator = {
      ...f.rotator,
      rotate: async () => {
        throw new Error(`boom token=${CANARY}`);
      },
    };
    let now = at(31 * DAY);
    for (let i = 0; i < FAILING_AFTER; i++) {
      await tick({ fake: broken }, now);
      now = (await w.row(variable.id)).nextAt;
    }
    const r = await w.row(variable.id);
    expect(r.lastError).toBe("internal");
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(await w.told(hears.id))).not.toContain(CANARY);
    expect(lines.join("\n")).not.toContain(CANARY);
  });

  test("a provider error's own message stays out of the row and the news", async () => {
    const w = await world();
    const { variable } = await w.rotating();
    const hears = await w.sink();
    const f = fakeRotator();
    const leaky: Rotator = {
      ...f.rotator,
      rotate: async () => {
        throw new RotationError("failed", `upstream said ${CANARY}`);
      },
    };
    let now = at(31 * DAY);
    for (let i = 0; i < FAILING_AFTER; i++) {
      await tick({ fake: leaky }, now);
      now = (await w.row(variable.id)).nextAt;
    }
    const r = await w.row(variable.id);
    expect(r.lastError).toBe("failed");
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(await w.told(hears.id))).not.toContain(CANARY);
  });

  test("an organization's variable is `failing` and audited, but no project hears of it", async () => {
    const w = await world();
    const { variable } = await w.rotating({ level: "org" });
    const hears = await w.sink();
    const f = fakeRotator();
    f.failWith("failed");
    let now = at(31 * DAY);
    for (let i = 0; i < FAILING_AFTER; i++) {
      await tick({ fake: f.rotator }, now);
      now = (await w.row(variable.id)).nextAt;
    }
    expect((await w.row(variable.id)).lastStatus).toBe("failing");
    expect(await w.events("variable.rotate_failing")).toBe(1);
    expect(await w.told(hears.id)).toHaveLength(0);
  });
});

describe("a replaced credential past its grace", () => {
  test("a credential in its grace stays valid until its time, then goes", async () => {
    const w = await world();
    const { variable } = await w.rotating({ graceDays: 2 });
    const f = fakeRotator();
    // a first rotation has nothing to replace; the second does
    await tick({ fake: f.rotator }, at(31 * DAY));
    const second = (await w.row(variable.id)).nextAt;
    await tick({ fake: f.rotator }, second);
    const r = await w.row(variable.id);
    expect(r.previousHandle).toBe("a-handle-1");
    expect(f.live.has("a-handle-1")).toBe(true);

    await tick({ fake: f.rotator }, new Date((r.revokeAt as Date).getTime() - MIN));
    expect(f.live.has("a-handle-1")).toBe(true);

    await tick({ fake: f.rotator }, r.revokeAt as Date);
    expect(f.live.has("a-handle-1")).toBe(false);
    expect((await w.row(variable.id)).previousHandle).toBeNull();
  });

  test("a revoke that fails is logged, leaves the credential recorded, and is tried again next tick", async () => {
    const w = await world();
    const { variable } = await w.rotating({ graceDays: 2 });
    const f = fakeRotator();
    await tick({ fake: f.rotator }, at(31 * DAY));
    await tick({ fake: f.rotator }, (await w.row(variable.id)).nextAt);
    const { revokeAt } = await w.row(variable.id);
    const due = revokeAt as Date;

    f.failWith("failed");
    await tick({ fake: f.rotator }, due);
    expect((await w.row(variable.id)).previousHandle).toBe("a-handle-1");
    expect(f.live.has("a-handle-1")).toBe(true);
    expect(lines.some((l) => l.includes("could not revoke"))).toBe(true);

    f.failWith(null);
    await tick({ fake: f.rotator }, due);
    expect(f.live.has("a-handle-1")).toBe(false);
    expect((await w.row(variable.id)).previousHandle).toBeNull();
  });
});
