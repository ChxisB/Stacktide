import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq } from "drizzle-orm";
import { AUTO_SYNC_DELAY_MS, AUTO_SYNC_QUEUE, queueAutoSync } from "./auto-sync";
import { createConnection } from "./connections";
import { claim } from "./jobs";
import { createEnvironment, createOrganization, createProject } from "./repo";
import { jobs } from "./schema";
import { createSyncTarget, updateSyncTarget } from "./sync-targets";
import { createTestDb, type TestDb } from "./testing";
import { bulkLevel, createVariable, deleteVariable, type Scope, setVariable } from "./variables";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const actor = { kind: "user", id: "u1" };
const CANARY = "s3cr3t-CANARY-value-0123456789";

let n = 0;
async function world() {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const connection = await createConnection(t.db, keys, {
    organizationId: org.id,
    type: "gitlab",
    name: "gl",
    token: "glpat-SECRET-TOKEN-0123456789",
  });
  const project = async () => {
    const p = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
    const env = await createEnvironment(t.db, {
      organizationId: org.id,
      projectId: p.id,
      name: "Prod",
      slug: "prod",
    });
    const target = (autoSync: boolean) =>
      createSyncTarget(t.db, {
        organizationId: org.id,
        projectId: p.id,
        connectionId: connection.id,
        name: `t${++n}`,
        type: "gitlab-variables",
        config: { project: 7 },
        autoSync,
      });
    return {
      id: p.id,
      target,
      at: { organizationId: org.id, projectId: p.id },
      env: { organizationId: org.id, projectId: p.id, environmentId: env.id },
    };
  };
  const one = await project();
  const two = await project();
  return {
    org,
    one,
    two,
    orgAt: { organizationId: org.id },
    auto: await one.target(true),
    auto2: await one.target(true),
    manual: await one.target(false),
    elsewhere: await two.target(true),
    // jobs of this organization only, by the target they name
    queued: async () =>
      (await t.db.select().from(jobs).where(eq(jobs.queue, AUTO_SYNC_QUEUE)))
        .filter((j) => (j.payload as { organizationId: string }).organizationId === org.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    targets: async () =>
      (await t.db.select().from(jobs).where(eq(jobs.queue, AUTO_SYNC_QUEUE)))
        .map((j) => j.payload as { organizationId: string; targetId: string })
        .filter((p) => p.organizationId === org.id)
        .map((p) => p.targetId)
        .sort(),
  };
}
const ids = (...ts: { id: string }[]) => ts.map((x) => x.id).sort();
const make = (scope: Scope, key = `K${++n}`) =>
  createVariable(t.db, keys, { ...scope, key, kind: "secret", value: CANARY, actor });

describe("auto-sync on change", () => {
  test("a project's variable queues its auto-sync targets, and only those", async () => {
    const w = await world();
    await make(w.one.at);
    expect(await w.targets()).toEqual(ids(w.auto, w.auto2));
  });

  test("a variable of an environment reaches the project's targets, not another project's", async () => {
    const w = await world();
    await make(w.one.env);
    expect(await w.targets()).toEqual(ids(w.auto, w.auto2));
  });

  test("an organization's variable reaches the auto-sync targets of all its projects", async () => {
    const other = await world();
    const w = await world();
    await make(w.orgAt);
    expect(await w.targets()).toEqual(ids(w.auto, w.auto2, w.elsewhere));
    expect(await other.targets()).toEqual([]);
  });

  test("a change in another project leaves the first alone", async () => {
    const w = await world();
    await make(w.two.at);
    expect(await w.targets()).toEqual(ids(w.elsewhere));
  });

  test("create, new value, delete and rename each queue; 10 rapid changes make one job per target", async () => {
    const w = await world();
    const a = await make(w.one.at, "A");
    const b = await make(w.one.at, "B");
    const c = await make(w.one.at, "C");
    for (let i = 0; i < 4; i++) {
      await setVariable(t.db, keys, w.one.at, a.id, { value: `v${i}`, actor });
    }
    await deleteVariable(t.db, w.one.at, b.id);
    await bulkLevel(t.db, keys, w.one.at, [{ op: "rename", key: "C", to: "D" }], { actor });
    await make(w.one.at, "E");
    await deleteVariable(t.db, w.one.at, c.id);
    const queued = await w.queued();
    expect(queued.map((j) => (j.payload as { targetId: string }).targetId).sort()).toEqual(
      ids(w.auto, w.auto2),
    );
    // ids only: no variable, no value
    expect(JSON.stringify(queued)).not.toContain(CANARY);
    for (const j of queued) {
      expect(Object.keys(j.payload as object).sort()).toEqual([
        "organizationId",
        "projectId",
        "targetId",
      ]);
      expect(j.payload).toMatchObject({ organizationId: w.org.id, projectId: w.one.id });
    }
  });

  test("each kind of change queues on its own, not only the first of a burst", async () => {
    const w = await world();
    const v = await make(w.one.at, "A");
    const steps: Record<string, () => Promise<unknown>> = {
      "a new value": () => setVariable(t.db, keys, w.one.at, v.id, { value: "next", actor }),
      "a rename": () =>
        bulkLevel(t.db, keys, w.one.at, [{ op: "rename", key: "A", to: "B" }], { actor }),
      "a delete": () => deleteVariable(t.db, w.one.at, v.id),
      "a create": () => make(w.one.at),
    };
    for (const [name, step] of Object.entries(steps)) {
      await t.db.delete(jobs).where(eq(jobs.queue, AUTO_SYNC_QUEUE));
      await step();
      expect([name, await w.targets()]).toEqual([name, ids(w.auto, w.auto2)]);
    }
  });

  test("the job waits for the quiet time, from the first change", async () => {
    const w = await world();
    const before = Date.now();
    await make(w.one.at);
    const [job] = await w.queued();
    const wait = (job?.runAt.getTime() ?? 0) - before;
    expect(wait).toBeGreaterThanOrEqual(AUTO_SYNC_DELAY_MS - 1000);
    expect(wait).toBeLessThanOrEqual(AUTO_SYNC_DELAY_MS + 5000);
    // not yet due, so a worker does not take it
    expect(await claim(t.db, { queues: [AUTO_SYNC_QUEUE], workerId: "w" })).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ id: job?.id })]),
    );
  });

  test("once a job is taken, the next change queues another", async () => {
    const w = await world();
    await t.db.delete(jobs).where(eq(jobs.queue, AUTO_SYNC_QUEUE));
    await make(w.one.at);
    const later = new Date(Date.now() + 2 * AUTO_SYNC_DELAY_MS);
    const taken = await claim(t.db, {
      queues: [AUTO_SYNC_QUEUE],
      workerId: "w",
      limit: 10,
      now: later,
    });
    expect(taken).toHaveLength(2);
    await make(w.one.at);
    const all = await w.queued();
    expect(all.map((j) => j.status).sort()).toEqual(["queued", "queued", "running", "running"]);
  });

  test("a target that is manual stays manual, and one switched on is queued from then on", async () => {
    const w = await world();
    await make(w.one.at);
    expect(await w.targets()).not.toContain(w.manual.id);
    await updateSyncTarget(t.db, w.org.id, w.one.id, w.manual.id, { autoSync: true });
    await make(w.one.at);
    expect(await w.targets()).toContain(w.manual.id);
  });

  test("changes that change nothing for a target queue nothing", async () => {
    const w = await world();
    const v = await make(w.two.at);
    await t.db.delete(jobs).where(eq(jobs.queue, AUTO_SYNC_QUEUE));
    // only the description, nothing at all, a variable that is not there or already gone
    await setVariable(t.db, keys, w.two.at, v.id, { description: "new words", actor });
    await setVariable(t.db, keys, w.two.at, v.id, { actor });
    await setVariable(t.db, keys, w.two.at, crypto.randomUUID(), { value: "x", actor });
    expect(await deleteVariable(t.db, w.two.at, crypto.randomUUID())).toBe(false);
    expect(await w.targets()).toEqual([]);
    await deleteVariable(t.db, w.two.at, v.id);
    await t.db.delete(jobs).where(eq(jobs.queue, AUTO_SYNC_QUEUE));
    expect(await deleteVariable(t.db, w.two.at, v.id)).toBe(false);
    expect(await w.targets()).toEqual([]);
  });

  test("goes or stays with the change's transaction", async () => {
    const w = await world();
    await t.db
      .transaction(async (tx) => {
        await createVariable(tx, keys, { ...w.one.at, key: "X", kind: "plain", value: "1", actor });
        throw new Error("rollback");
      })
      .catch(() => undefined);
    expect(await w.targets()).toEqual([]);
    await queueAutoSync(t.db, w.one.at);
    await queueAutoSync(t.db, w.one.at);
    expect(await w.targets()).toEqual(ids(w.auto, w.auto2));
  });
});
