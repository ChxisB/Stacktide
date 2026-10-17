import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { createConnection, deleteConnection } from "./connections";
import {
  databaseTime,
  getPipelineRun,
  latestPipelineRuns,
  listPipelineRuns,
  type NewPipelineRun,
  recordPipelineRun,
} from "./pipeline-runs";
import { createOrganization, createProject, deleteProject } from "./repo";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));

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
  const run = (over: Partial<NewPipelineRun> = {}): NewPipelineRun => ({
    organizationId: org.id,
    projectId: project.id,
    connectionId: connection.id,
    gitlabPipelineId: 100,
    iid: 1,
    status: "running",
    ref: "main",
    sha: "a".repeat(40),
    webUrl: "https://gitlab.example/g/p/-/pipelines/100",
    failureReason: null,
    failedJob: null,
    observedAt: at(10),
    ...over,
  });
  return { org, connection, project, run };
}

describe("recording a pipeline run", () => {
  test("the first read inserts, a later one replaces", async () => {
    const w = await world();
    const first = await recordPipelineRun(t.db, w.run());
    expect(first.stored).toBe(true);
    const second = await recordPipelineRun(
      t.db,
      w.run({
        status: "failed",
        failureReason: "script_failure",
        failedJob: "test",
        observedAt: at(20),
      }),
    );
    expect(second.stored).toBe(true);
    expect(second.run).toMatchObject({
      id: first.run.id,
      status: "failed",
      failureReason: "script_failure",
      failedJob: "test",
    });
  });

  test("a read that began earlier than the stored one is dropped, whatever it says", async () => {
    const w = await world();
    await recordPipelineRun(t.db, w.run({ status: "success", observedAt: at(20) }));
    const late = await recordPipelineRun(t.db, w.run({ status: "running", observedAt: at(10) }));
    expect(late.stored).toBe(false);
    expect(late.run).toMatchObject({ status: "success", observedAt: at(20) });
    expect((await listPipelineRuns(t.db, w.org.id, w.project.id, { limit: 10 })).length).toBe(1);
  });

  test("a read from the same moment replaces (the later write wins a tie)", async () => {
    const w = await world();
    await recordPipelineRun(t.db, w.run({ status: "running", observedAt: at(10) }));
    const again = await recordPipelineRun(t.db, w.run({ status: "success", observedAt: at(10) }));
    expect([again.stored, again.run.status]).toEqual([true, "success"]);
  });

  test("a repeat changes nothing but is stored", async () => {
    const w = await world();
    const a = await recordPipelineRun(t.db, w.run());
    const b = await recordPipelineRun(t.db, w.run());
    expect(b.run).toMatchObject({ id: a.run.id, status: "running" });
    expect((await listPipelineRuns(t.db, w.org.id, w.project.id, { limit: 10 })).length).toBe(1);
  });

  test("another organization cannot replace a project's run", async () => {
    const w = await world();
    const saved = await recordPipelineRun(t.db, w.run());
    const other = await createOrganization(t.db, { slug: `o${++n}`, name: "Other" });
    // the project of the first organization, claimed under another: the composite key refuses it
    await expect(
      recordPipelineRun(
        t.db,
        w.run({ organizationId: other.id, status: "failed", observedAt: at(99) }),
      ),
    ).rejects.toThrow();
    expect(await getPipelineRun(t.db, w.org.id, w.project.id, saved.run.id)).toEqual(saved.run);
  });

  test("a status that is not a lower-case word is refused", async () => {
    const w = await world();
    await expect(recordPipelineRun(t.db, w.run({ status: "Running!" }))).rejects.toThrow();
  });
});

describe("reading runs", () => {
  async function seeded() {
    const w = await world();
    const rows: [number, string, string][] = [
      [101, "main", "success"],
      [102, "dev", "failed"],
      [103, "main", "running"],
      [104, "dev", "success"],
      [105, "feature", "failed"],
    ];
    for (const [id, ref, status] of rows) {
      await recordPipelineRun(t.db, w.run({ gitlabPipelineId: id, iid: id - 100, ref, status }));
    }
    return w;
  }

  test("newest first by GitLab's pipeline id, with a cursor", async () => {
    const w = await seeded();
    const page = (before?: number) =>
      listPipelineRuns(t.db, w.org.id, w.project.id, { limit: 2, before });
    const a = await page();
    const b = await page(a.at(-1)?.gitlabPipelineId);
    const c = await page(b.at(-1)?.gitlabPipelineId);
    expect([a, b, c].map((p) => p.map((r) => r.gitlabPipelineId))).toEqual([
      [105, 104],
      [103, 102],
      [101],
    ]);
  });

  test("filters by ref and status", async () => {
    const w = await seeded();
    const ids = async (o: { ref?: string; status?: string }) =>
      (await listPipelineRuns(t.db, w.org.id, w.project.id, { limit: 10, ...o })).map(
        (r) => r.gitlabPipelineId,
      );
    expect(await ids({ ref: "main" })).toEqual([103, 101]);
    expect(await ids({ status: "failed" })).toEqual([105, 102]);
    expect(await ids({ ref: "dev", status: "failed" })).toEqual([102]);
  });

  test("the latest run of each ref, newest first, capped", async () => {
    const w = await seeded();
    const ids = async (limit: number) =>
      (await latestPipelineRuns(t.db, w.org.id, w.project.id, limit)).map(
        (r) => r.gitlabPipelineId,
      );
    expect(await ids(10)).toEqual([105, 104, 103]);
    expect(await ids(2)).toEqual([105, 104]);
  });

  test("only the project's own runs, in its own organization", async () => {
    const a = await seeded();
    const b = await world();
    expect(await listPipelineRuns(t.db, b.org.id, b.project.id, { limit: 10 })).toEqual([]);
    expect(await latestPipelineRuns(t.db, b.org.id, b.project.id, 10)).toEqual([]);
    // right project, wrong organization
    expect(await listPipelineRuns(t.db, b.org.id, a.project.id, { limit: 10 })).toEqual([]);
    expect(await latestPipelineRuns(t.db, b.org.id, a.project.id, 10)).toEqual([]);
    const [any] = await listPipelineRuns(t.db, a.org.id, a.project.id, { limit: 1 });
    expect(await getPipelineRun(t.db, b.org.id, a.project.id, any?.id ?? "")).toBeUndefined();
    expect(await getPipelineRun(t.db, a.org.id, b.project.id, any?.id ?? "")).toBeUndefined();
    expect(await getPipelineRun(t.db, a.org.id, a.project.id, any?.id ?? "")).toEqual(any);
  });
});

describe("what deleting takes with it", () => {
  test("a project's runs go with the project", async () => {
    const w = await world();
    await recordPipelineRun(t.db, w.run());
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(await listPipelineRuns(t.db, w.org.id, w.project.id, { limit: 10 })).toEqual([]);
  });

  test("a deleted connection leaves the runs, with no connection", async () => {
    const w = await world();
    const saved = await recordPipelineRun(t.db, w.run());
    expect(await deleteConnection(t.db, w.org.id, w.connection.id)).toBe(true);
    expect(await getPipelineRun(t.db, w.org.id, w.project.id, saved.run.id)).toMatchObject({
      status: "running",
      connectionId: null,
    });
  });
});

describe("the database clock", () => {
  test("is the present, and never runs backwards", async () => {
    const before = Date.now();
    const a = await databaseTime(t.db);
    const b = await databaseTime(t.db);
    expect(a.getTime()).toBeLessThanOrEqual(b.getTime());
    // the database runs on this machine's clock in tests; a minute is far more than any skew here
    expect(Math.abs(a.getTime() - before)).toBeLessThan(60_000);
  });
});
