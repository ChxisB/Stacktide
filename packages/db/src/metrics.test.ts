import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { createConnection } from "./connections";
import { operationalStats } from "./metrics";
import { createOrganization, createProject } from "./repo";
import { jobs, runStacks, runs, syncRuns } from "./schema";
import { createSyncTarget } from "./sync-targets";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const ago = (s: number) => new Date(Date.now() - s * 1000);
const between = (v: number | null | undefined, lo: number, hi: number) => {
  expect(v).not.toBeNull();
  expect(v ?? -1).toBeGreaterThanOrEqual(lo);
  expect(v ?? -1).toBeLessThan(hi);
};

describe("operationalStats", () => {
  test("an empty database has nothing to report", async () => {
    expect(await operationalStats(t.db)).toEqual({ jobs: [], syncRuns: [], stackRuns: [] });
  });

  test("counts jobs per queue and state, and ages only the ones that are waiting or running", async () => {
    const row = (queue: string, status: "queued" | "running" | "done" | "dead", extra = {}) => ({
      queue,
      status,
      ...extra,
    });
    await t.db.insert(jobs).values([
      row("mail", "queued", { runAt: ago(300) }),
      row("mail", "queued", { runAt: ago(60) }),
      // not due yet (a retry waiting out its backoff): counted, not aged
      row("later", "queued", { runAt: new Date(Date.now() + 3_600_000) }),
      row("mail", "running", { runAt: ago(900), lockedBy: "w1", lockedAt: ago(120) }),
      row("mail", "done", { runAt: ago(5000) }),
      row("mail", "dead", { runAt: ago(5000) }),
    ]);
    const { jobs: got } = await operationalStats(t.db);
    const of = (queue: string, status: string) =>
      got.find((r) => r.queue === queue && r.status === status);
    expect(of("mail", "queued")?.count).toBe(2);
    between(of("mail", "queued")?.oldestSeconds, 300, 360);
    expect(of("mail", "running")?.count).toBe(1);
    between(of("mail", "running")?.oldestSeconds, 120, 180);
    expect(of("mail", "done")).toMatchObject({ count: 1, oldestSeconds: null });
    expect(of("mail", "dead")).toMatchObject({ count: 1, oldestSeconds: null });
    expect(of("later", "queued")).toMatchObject({ count: 1, oldestSeconds: null });
    expect(got).toHaveLength(5);
  });

  test("an age is never negative, whatever the clock of the worker that locked the job said", async () => {
    await t.db.insert(jobs).values({
      queue: "skew",
      status: "running",
      runAt: ago(60),
      lockedBy: "w2",
      lockedAt: new Date(Date.now() + 3_600_000),
    });
    const { jobs: got } = await operationalStats(t.db);
    expect(got.find((r) => r.queue === "skew")).toMatchObject({ count: 1, oldestSeconds: 0 });
  });

  test("counts sync runs per status and ages the ones being applied", async () => {
    const org = await createOrganization(t.db, { slug: "m1", name: "O" });
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
    const run = (status: string, updatedAt = new Date()) => ({
      organizationId: org.id,
      projectId: project.id,
      targetId: target.id,
      status,
      expiresAt: new Date(Date.now() + 60_000),
      desiredDigest: "d".repeat(64),
      counts: {},
      updatedAt,
    });
    await t.db
      .insert(syncRuns)
      .values([
        run("planned", ago(5000)),
        run("planned", ago(5000)),
        run("applying", ago(240)),
        run("applied", ago(5000)),
        run("failed", ago(5000)),
      ]);
    const { syncRuns: got } = await operationalStats(t.db);
    expect(got.map((r) => [r.status, r.count])).toEqual([
      ["applied", 1],
      ["applying", 1],
      ["failed", 1],
      ["planned", 2],
    ]);
    between(got.find((r) => r.status === "applying")?.oldestSeconds, 240, 300);
    expect(got.filter((r) => r.status !== "applying").map((r) => r.oldestSeconds)).toEqual([
      null,
      null,
      null,
    ]);

    const [made] = await t.db
      .insert(runs)
      .values({ organizationId: org.id, projectId: project.id, ref: "main", sha: "a".repeat(40) })
      .returning();
    if (!made) throw new Error("no run");
    const stack = (name: string, status: string, updatedAt: Date) => ({
      runId: made.id,
      organizationId: org.id,
      projectId: project.id,
      stack: name,
      status,
      updatedAt,
    });
    await t.db
      .insert(runStacks)
      .values([
        stack("a", "queued", ago(30)),
        stack("b", "planning", ago(600)),
        stack("c", "applying", ago(90)),
        stack("d", "applied", ago(9000)),
        stack("e", "applied", ago(9000)),
        stack("f", "discarded", ago(9000)),
      ]);
    const { stackRuns } = await operationalStats(t.db);
    expect(stackRuns.map((r) => [r.status, r.count])).toEqual([
      ["applied", 2],
      ["applying", 1],
      ["discarded", 1],
      ["planning", 1],
      ["queued", 1],
    ]);
    between(stackRuns.find((r) => r.status === "planning")?.oldestSeconds, 600, 660);
    between(stackRuns.find((r) => r.status === "applying")?.oldestSeconds, 90, 150);
    between(stackRuns.find((r) => r.status === "queued")?.oldestSeconds, 30, 90);
    expect(stackRuns.find((r) => r.status === "applied")?.oldestSeconds).toBeNull();
    expect(stackRuns.find((r) => r.status === "discarded")?.oldestSeconds).toBeNull();
  });
});
