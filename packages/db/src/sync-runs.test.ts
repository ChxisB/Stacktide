import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq } from "drizzle-orm";
import { createConnection } from "./connections";
import { enqueue } from "./jobs";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject } from "./repo";
import { jobs, syncRunItems, syncRuns } from "./schema";
import {
  claimSyncRun,
  createSyncRun,
  failStuckApplies,
  finishSyncRun,
  getSyncRun,
  listSyncRunItems,
  recordSyncItem,
} from "./sync-runs";
import { createSyncTarget, deleteSyncTarget } from "./sync-targets";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let n = 0;
async function setup() {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: "api" });
  const connection = await createConnection(t.db, keys, {
    organizationId: org.id,
    type: "gitlab",
    name: "gl",
    token: "glpat-SECRET-TOKEN-0123456789",
  });
  const target = await createSyncTarget(t.db, {
    organizationId: org.id,
    projectId: project.id,
    connectionId: connection.id,
    name: "main",
    type: "gitlab-variables",
    config: { project: 7 },
  });
  return { org, project, target };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const run = (s: Setup, over: Record<string, unknown> = {}) => ({
  organizationId: s.org.id,
  projectId: s.project.id,
  targetId: s.target.id,
  expiresAt: new Date(Date.now() + 60_000),
  desiredDigest: "d".repeat(64),
  counts: { create: 1, update: 0, delete: 0, noop: 0, adopt: 0 },
  skipped: {},
  ...over,
});
/** What a freshly planned line looks like when listed: nothing done to it yet. */
const listed = <T extends object>(items: T[]) =>
  items.map((item, position) => ({ ...item, position, result: null, error: null }));
const violated = (p: Promise<unknown>) => p.then(() => undefined, pgConstraint);

describe("sync runs", () => {
  test("keeps a plan longer than one statement can bind, in order", async () => {
    const s = await setup();
    const items = Array.from({ length: 11_000 }, (_, i) => ({
      key: `K${String(i).padStart(5, "0")}`,
      scope: "*",
      action: "create",
      changed: [],
    }));
    const made = await createSyncRun(t.db, run(s), items);
    expect(await listSyncRunItems(t.db, made.id)).toEqual(listed(items));
  });

  test("keeps a plan with its lines in order, found only by its own target", async () => {
    const s = await setup();
    const items = [
      { key: "B", scope: "*", action: "create", changed: [] },
      { key: "A", scope: "production", action: "update", changed: ["value", "secret"] },
      { key: "A", scope: "*", action: "noop", changed: [] },
    ];
    const made = await createSyncRun(t.db, run(s), items);
    expect(made).toMatchObject({ status: "planned", desiredDigest: "d".repeat(64) });

    expect(await listSyncRunItems(t.db, made.id)).toEqual(listed(items));
    const found = await getSyncRun(t.db, s.org.id, s.project.id, s.target.id, made.id);
    expect(found?.id).toBe(made.id);

    const other = await setup();
    const miss = (org: string, project: string, target: string) =>
      getSyncRun(t.db, org, project, target, made.id);
    expect(await miss(other.org.id, s.project.id, s.target.id)).toBeUndefined();
    expect(await miss(s.org.id, other.project.id, s.target.id)).toBeUndefined();
    expect(await miss(s.org.id, s.project.id, other.target.id)).toBeUndefined();
  });

  test("a plan with no lines is a plan", async () => {
    const s = await setup();
    const made = await createSyncRun(t.db, run(s), []);
    expect(await listSyncRunItems(t.db, made.id)).toEqual([]);
  });

  test("cannot name a target of another project or organization", async () => {
    const a = await setup();
    const b = await setup();
    expect(await violated(createSyncRun(t.db, run(a, { targetId: b.target.id }), []))).toBe(
      "sync_runs_target_fk",
    );
    expect(await violated(createSyncRun(t.db, run(a, { projectId: b.project.id }), []))).toBe(
      "sync_runs_target_fk",
    );
  });

  test("refuses a status or an action the code does not know", async () => {
    const s = await setup();
    expect(await violated(createSyncRun(t.db, run(s, { status: "weird" }), []))).toBe(
      "sync_runs_status_check",
    );
    const made = await createSyncRun(t.db, run(s), []);
    expect(
      await violated(
        t.db.insert(syncRunItems).values({
          runId: made.id,
          position: 0,
          key: "K",
          scope: "*",
          action: "weird",
          changed: [],
        }),
      ),
    ).toBe("sync_run_items_action_check");
  });

  test("is claimed once, by a plan that is still planned and not expired", async () => {
    const s = await setup();
    const claim = (id: string, over: Partial<Setup> = {}) =>
      claimSyncRun(t.db, (over.org ?? s.org).id, s.project.id, s.target.id, id, Bun.randomUUIDv7());
    const made = await createSyncRun(t.db, run(s), []);
    const job = Bun.randomUUIDv7();
    const got = await claimSyncRun(t.db, s.org.id, s.project.id, s.target.id, made.id, job);
    expect(got).toMatchObject({ id: made.id, status: "applying", jobId: job });
    expect(await claim(made.id)).toBeUndefined(); // not planned any more

    const old = await createSyncRun(t.db, run(s, { expiresAt: new Date(Date.now() - 1000) }), []);
    expect(await claim(old.id)).toBeUndefined();
    expect((await getSyncRun(t.db, s.org.id, s.project.id, s.target.id, old.id))?.status).toBe(
      "planned",
    );

    const fresh = await createSyncRun(t.db, run(s), []);
    const other = await setup();
    expect(await claim(fresh.id, other)).toBeUndefined(); // another organization's id matches nothing
  });

  test("one run of a target applies at a time; another target is free", async () => {
    const s = await setup();
    const a = await createSyncRun(t.db, run(s), []);
    const b = await createSyncRun(t.db, run(s), []);
    const claim = (target: Setup["target"], id: string) =>
      claimSyncRun(t.db, s.org.id, s.project.id, target.id, id, Bun.randomUUIDv7());
    await claim(s.target, a.id);
    expect(await violated(claim(s.target, b.id))).toBe("sync_runs_one_applying");

    const done = await finishSyncRun(t.db, a.id, { status: "applied" });
    expect(done).toMatchObject({ status: "applied", error: null });
    expect(await claim(s.target, b.id)).toMatchObject({ status: "applying" });
  });

  test("ends once, and only an applying run", async () => {
    const s = await setup();
    const made = await createSyncRun(t.db, run(s), []);
    expect(await finishSyncRun(t.db, made.id, { status: "applied" })).toBeUndefined();
    await claimSyncRun(t.db, s.org.id, s.project.id, s.target.id, made.id, Bun.randomUUIDv7());
    const failed = await finishSyncRun(t.db, made.id, { status: "failed", error: "2 failed" });
    expect(failed).toMatchObject({ status: "failed", error: "2 failed" });
    expect(await finishSyncRun(t.db, made.id, { status: "applied" })).toBeUndefined();
  });

  test("records what happened to a line", async () => {
    const s = await setup();
    const made = await createSyncRun(t.db, run(s), [
      { key: "A", scope: "*", action: "create", changed: [] },
      { key: "B", scope: "*", action: "update", changed: ["value"] },
    ]);
    await recordSyncItem(t.db, made.id, 1, { result: "failed", error: "refused" });
    await recordSyncItem(t.db, made.id, 0, { result: "applied", error: null });
    const lines = await listSyncRunItems(t.db, made.id);
    expect(lines.map((l) => [l.key, l.result, l.error])).toEqual([
      ["A", "applied", null],
      ["B", "failed", "refused"],
    ]);
    expect(
      await violated(
        recordSyncItem(t.db, made.id, 0, { result: "weird" as "failed", error: null }),
      ),
    ).toBe("sync_run_items_result_check");
  });

  test("an apply whose job is dead, or that has been going too long, is ended; one that is alive is not", async () => {
    const s = await setup();
    const dead = await enqueue(t.db, { queue: "sync.apply" });
    const live = await enqueue(t.db, { queue: "sync.apply" });
    await t.db.update(jobs).set({ status: "dead" }).where(eq(jobs.id, dead.id));
    const claimed = async (job: string) => {
      const made = await createSyncRun(t.db, run(s), []);
      await claimSyncRun(t.db, s.org.id, s.project.id, s.target.id, made.id, job);
      return made.id;
    };
    const ids = (r: typeof syncRuns.$inferSelect | undefined) => [r?.status, r?.error];
    const get = async (id: string) => getSyncRun(t.db, s.org.id, s.project.id, s.target.id, id);
    const stuck = "the apply did not finish: its job died or was never taken";
    const sweep = (o = s, ms?: number) =>
      failStuckApplies(t.db, o.org.id, o.project.id, o.target.id, ms);

    const alive = await claimed(live.id);
    expect(await sweep()).toEqual([]);
    expect(ids(await get(alive))).toEqual(["applying", null]);
    // a job nobody took for longer than the limit: the same end
    expect(await sweep(s, 0)).toEqual([alive]);
    expect(ids(await get(alive))).toEqual(["failed", stuck]);

    const lost = await claimed(dead.id);
    expect(await sweep(await setup())).toEqual([]);
    expect(await sweep()).toEqual([lost]);
    expect(ids(await get(lost))).toEqual(["failed", stuck]);

    // a run that finished stays as it ended, whatever became of its job or how long ago
    const done = await claimed(dead.id);
    await finishSyncRun(t.db, done, { status: "applied" });
    expect(await sweep()).toEqual([]);
    expect(await sweep(s, 0)).toEqual([]);
    expect(ids(await get(done))).toEqual(["applied", null]);
  });

  test("goes, with its lines, when its target does", async () => {
    const s = await setup();
    const made = await createSyncRun(t.db, run(s), [
      { key: "K", scope: "*", action: "create", changed: [] },
    ]);
    expect(await deleteSyncTarget(t.db, s.org.id, s.project.id, s.target.id)).toBe(true);
    expect(await t.db.select().from(syncRuns).where(eq(syncRuns.id, made.id))).toEqual([]);
    expect(await t.db.select().from(syncRunItems).where(eq(syncRunItems.runId, made.id))).toEqual(
      [],
    );
  });
});
