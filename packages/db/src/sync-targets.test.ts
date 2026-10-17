import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq } from "drizzle-orm";
import { createConnection, deleteConnection } from "./connections";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import { syncTargets } from "./schema";
import {
  createSyncTarget,
  deleteSyncTarget,
  getSyncTarget,
  listSyncTargets,
  updateSyncTarget,
} from "./sync-targets";
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
  return { org, project, connection };
}
const target = (s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) => ({
  organizationId: s.org.id,
  projectId: s.project.id,
  connectionId: s.connection.id,
  name: `t${++n}`,
  type: "gitlab-variables",
  config: { project: 7 },
  ...over,
});
const violated = (p: Promise<unknown>) => p.then(() => undefined, pgConstraint);

describe("sync targets", () => {
  test("defaults: ignore unmanaged items, no auto sync, no mapping", async () => {
    const s = await setup();
    const row = await createSyncTarget(t.db, target(s));
    expect(row).toMatchObject({
      type: "gitlab-variables",
      config: { project: 7 },
      environmentMapping: {},
      unmanagedPolicy: "ignore",
      autoSync: false,
    });
    expect(await getSyncTarget(t.db, s.org.id, s.project.id, row.id)).toEqual(row);
  });

  test("lookups need the right organization and project", async () => {
    const s = await setup();
    const other = await setup();
    const row = await createSyncTarget(t.db, target(s));
    expect(await getSyncTarget(t.db, other.org.id, s.project.id, row.id)).toBeUndefined();
    expect(await getSyncTarget(t.db, s.org.id, other.project.id, row.id)).toBeUndefined();
    expect(await listSyncTargets(t.db, other.org.id, s.project.id, { limit: 9 })).toEqual([]);
    expect(await listSyncTargets(t.db, s.org.id, other.project.id, { limit: 9 })).toEqual([]);
    const patch = { name: "stolen" };
    expect(await updateSyncTarget(t.db, other.org.id, s.project.id, row.id, patch)).toBeUndefined();
    expect(await updateSyncTarget(t.db, s.org.id, other.project.id, row.id, patch)).toBeUndefined();
    expect(await deleteSyncTarget(t.db, other.org.id, s.project.id, row.id)).toBe(false);
    expect(await deleteSyncTarget(t.db, s.org.id, other.project.id, row.id)).toBe(false);
    expect((await getSyncTarget(t.db, s.org.id, s.project.id, row.id))?.name).toBe(row.name);
  });

  test("lists in creation order and pages by id", async () => {
    const s = await setup();
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(await createSyncTarget(t.db, target(s)));
    const ids = rows.map((r) => r.id);
    const first = await listSyncTargets(t.db, s.org.id, s.project.id, { limit: 2 });
    expect(first.map((r) => r.id)).toEqual(ids.slice(0, 2));
    const rest = await listSyncTargets(t.db, s.org.id, s.project.id, { after: ids[1], limit: 2 });
    expect(rest.map((r) => r.id)).toEqual(ids.slice(2));
  });

  test("a patch changes only what it names, and an empty one changes nothing", async () => {
    const s = await setup();
    const row = await createSyncTarget(t.db, target(s));
    const same = await updateSyncTarget(t.db, s.org.id, s.project.id, row.id, {});
    expect(same).toEqual(row);
    const unset = await updateSyncTarget(t.db, s.org.id, s.project.id, row.id, { name: undefined });
    expect(unset).toEqual(row);
    const got = await updateSyncTarget(t.db, s.org.id, s.project.id, row.id, {
      unmanagedPolicy: "prune",
      autoSync: true,
      environmentMapping: { prod: "production" },
      config: { group: 3 },
      name: undefined,
    });
    expect(got).toMatchObject({
      name: row.name,
      type: row.type,
      unmanagedPolicy: "prune",
      autoSync: true,
      environmentMapping: { prod: "production" },
      config: { group: 3 },
    });
  });

  test("updated_at moves when a row changes", async () => {
    const s = await setup();
    const old = new Date("2000-01-01T00:00:00Z");
    const row = await createSyncTarget(t.db, { ...target(s), updatedAt: old } as never);
    await t.db.update(syncTargets).set({ autoSync: true }).where(eq(syncTargets.id, row.id));
    const after = await getSyncTarget(t.db, s.org.id, s.project.id, row.id);
    expect(after?.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("a name is unique within a project, not across projects", async () => {
    const s = await setup();
    await createSyncTarget(t.db, target(s, { name: "prod" }));
    expect(await violated(createSyncTarget(t.db, target(s, { name: "prod" })))).toBe(
      "sync_targets_project_name_key",
    );
    const second = await createProject(t.db, { organizationId: s.org.id, name: "web" });
    await createSyncTarget(t.db, target(s, { name: "prod", projectId: second.id }));
  });

  test("the connection and the project must be in the target's organization", async () => {
    const s = await setup();
    const other = await setup();
    expect(
      await violated(createSyncTarget(t.db, target(s, { connectionId: other.connection.id }))),
    ).toBe("sync_targets_connection_org_fk");
    expect(await violated(createSyncTarget(t.db, target(s, { projectId: other.project.id })))).toBe(
      "sync_targets_project_org_fk",
    );
    expect(
      await violated(
        updateSyncTarget(
          t.db,
          s.org.id,
          s.project.id,
          (await createSyncTarget(t.db, target(s))).id,
          {
            connectionId: other.connection.id,
          },
        ),
      ),
    ).toBe("sync_targets_connection_org_fk");
  });

  test("the type and the unmanaged policy are checked", async () => {
    const s = await setup();
    for (const type of ["", "GitLab", "1x", "a b", "a".repeat(65)]) {
      expect(await violated(createSyncTarget(t.db, target(s, { type })))).toBe(
        "sync_targets_type_check",
      );
    }
    await createSyncTarget(t.db, target(s, { type: "a".repeat(64) }));
    expect(
      await violated(createSyncTarget(t.db, target(s, { unmanagedPolicy: "delete" as never }))),
    ).toBe("sync_targets_unmanaged_policy_check");
    for (const unmanagedPolicy of ["ignore", "adopt", "prune"] as const) {
      await createSyncTarget(t.db, target(s, { unmanagedPolicy }));
    }
  });

  test("deleting a project takes its targets; a connection in use cannot be deleted", async () => {
    const s = await setup();
    const row = await createSyncTarget(t.db, target(s));
    expect(await violated(deleteConnection(t.db, s.org.id, s.connection.id))).toBe(
      "sync_targets_connection_org_fk",
    );
    expect(await deleteProject(t.db, s.org.id, s.project.id)).toBe(true);
    expect(await getSyncTarget(t.db, s.org.id, s.project.id, row.id)).toBeUndefined();
    expect(await deleteConnection(t.db, s.org.id, s.connection.id)).toBe(true);
  });

  test("a deleted target frees its connection", async () => {
    const s = await setup();
    const row = await createSyncTarget(t.db, target(s));
    expect(await deleteSyncTarget(t.db, s.org.id, s.project.id, row.id)).toBe(true);
    expect(await deleteSyncTarget(t.db, s.org.id, s.project.id, row.id)).toBe(false);
    expect(await deleteConnection(t.db, s.org.id, s.connection.id)).toBe(true);
  });
});
