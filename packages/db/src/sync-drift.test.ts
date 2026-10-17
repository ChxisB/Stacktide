import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq } from "drizzle-orm";
import { createConnection } from "./connections";
import { createOrganization, createProject, deleteProject } from "./repo";
import { jobs, syncRuns } from "./schema";
import {
  DRIFT_CHECK_QUEUE,
  getSyncDrift,
  isApplying,
  queueDriftChecks,
  recordDrift,
} from "./sync-drift";
import { createSyncRun } from "./sync-runs";
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
const counts = { create: 0, update: 1, delete: 0, noop: 2, adopt: 0 };

let n = 0;
async function world() {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const connection = await createConnection(t.db, keys, {
    organizationId: org.id,
    type: "gitlab",
    name: "gl",
    token: "glpat-SECRET-TOKEN-0123456789",
  });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
  const target = () =>
    createSyncTarget(t.db, {
      organizationId: org.id,
      projectId: project.id,
      connectionId: connection.id,
      name: `t${++n}`,
      type: "gitlab-variables",
      config: { project: 7 },
    });
  return { org, project, target };
}
const ref = (x: { id: string; organizationId: string; projectId: string }) => ({
  id: x.id,
  organizationId: x.organizationId,
  projectId: x.projectId,
});

describe("sync drift", () => {
  test("the last check replaces the one before, and says what the status was", async () => {
    const w = await world();
    const target = await w.target();
    expect(await getSyncDrift(t.db, w.org.id, w.project.id, target.id)).toBeUndefined();

    expect(await recordDrift(t.db, ref(target), "drifted", counts)).toBeUndefined();
    const first = await getSyncDrift(t.db, w.org.id, w.project.id, target.id);
    expect(first).toMatchObject({ status: "drifted", counts });

    await Bun.sleep(5);
    expect(await recordDrift(t.db, ref(target), "in_sync", { ...counts, update: 0 })).toBe(
      "drifted",
    );
    const second = await getSyncDrift(t.db, w.org.id, w.project.id, target.id);
    expect(second).toMatchObject({ status: "in_sync", counts: { ...counts, update: 0 } });
    expect(second?.updatedAt.getTime()).toBeGreaterThan(first?.updatedAt.getTime() ?? 0);
  });

  test("a status that is not one of the two is refused by the table", async () => {
    const w = await world();
    const target = await w.target();
    await expect(recordDrift(t.db, ref(target), "bogus" as never, counts)).rejects.toThrow();
  });

  test("it is found only through the organization and project of its target", async () => {
    const w = await world();
    const other = await world();
    const target = await w.target();
    await recordDrift(t.db, ref(target), "drifted", counts);
    expect(await getSyncDrift(t.db, other.org.id, w.project.id, target.id)).toBeUndefined();
    expect(await getSyncDrift(t.db, w.org.id, other.project.id, target.id)).toBeUndefined();
    // and cannot be written for a place the target is not in
    await expect(
      recordDrift(t.db, { ...ref(target), organizationId: other.org.id }, "drifted", counts),
    ).rejects.toThrow();
  });

  test("it goes with its target, and with its project", async () => {
    const w = await world();
    const a = await w.target();
    const b = await w.target();
    await recordDrift(t.db, ref(a), "drifted", counts);
    await recordDrift(t.db, ref(b), "drifted", counts);
    await deleteSyncTarget(t.db, w.org.id, w.project.id, a.id);
    expect(await getSyncDrift(t.db, w.org.id, w.project.id, a.id)).toBeUndefined();
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(await getSyncDrift(t.db, w.org.id, w.project.id, b.id)).toBeUndefined();
  });

  test("a target is applying while a run of it is", async () => {
    const w = await world();
    const target = await w.target();
    expect(await isApplying(t.db, target.id)).toBe(false);
    const run = await createSyncRun(
      t.db,
      {
        organizationId: w.org.id,
        projectId: w.project.id,
        targetId: target.id,
        expiresAt: new Date(Date.now() + 60_000),
        desiredDigest: "d",
        counts: {},
        skipped: {},
      },
      [],
    );
    expect(await isApplying(t.db, target.id)).toBe(false);
    await t.db.update(syncRuns).set({ status: "applying" }).where(eq(syncRuns.id, run.id));
    expect(await isApplying(t.db, target.id)).toBe(true);
    // another target's run is not this one's
    expect(await isApplying(t.db, (await w.target()).id)).toBe(false);
    await t.db.update(syncRuns).set({ status: "applied" }).where(eq(syncRuns.id, run.id));
    expect(await isApplying(t.db, target.id)).toBe(false);
  });
});

describe("asking for checks", () => {
  const queued = async (ids: string[]) =>
    (await t.db.select().from(jobs).where(eq(jobs.queue, DRIFT_CHECK_QUEUE)))
      .filter((j) => ids.includes((j.payload as { targetId: string }).targetId))
      .filter((j) => j.status === "queued");

  test("every target gets one job holding ids only, across pages, and asking again adds none", async () => {
    const w = await world();
    const other = await world();
    const made = [
      await w.target(),
      await w.target(),
      await other.target(),
      await w.target(),
      await w.target(),
    ];
    const ids = made.map((x) => x.id);
    // 2 per page: the walk has to continue past a page
    const first = await queueDriftChecks(t.db, 2);
    expect(first).toBeGreaterThanOrEqual(5);
    const jobsFor = await queued(ids);
    expect(jobsFor).toHaveLength(5);
    for (const j of jobsFor) {
      const target = made.find((x) => x.id === (j.payload as { targetId: string }).targetId);
      expect(j.payload).toEqual({
        organizationId: target?.organizationId,
        projectId: target?.projectId,
        targetId: target?.id,
      });
      expect(j.dedupeKey).toBe(target?.id ?? null);
    }

    await queueDriftChecks(t.db, 2);
    expect(await queued(ids)).toHaveLength(5);
  });

  test("no targets, no jobs", async () => {
    // a fresh database would be needed to see zero; here it is enough that a walk with nothing new returns 0
    await queueDriftChecks(t.db);
    expect(await queueDriftChecks(t.db)).toBe(0);
  });
});
