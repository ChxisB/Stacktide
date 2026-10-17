import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq } from "drizzle-orm";
import { createConnection } from "./connections";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject } from "./repo";
import { syncRunItems, syncRuns } from "./schema";
import { createSyncRun, getSyncRun, listSyncRunItems } from "./sync-runs";
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
    expect(await listSyncRunItems(t.db, made.id)).toEqual(items);
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

    expect(await listSyncRunItems(t.db, made.id)).toEqual(items);
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
