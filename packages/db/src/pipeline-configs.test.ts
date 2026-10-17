import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { createConnection, deleteConnection } from "./connections";
import { pgConstraint } from "./pg-error";
import { getPipelineConfig, savePipelineConfig } from "./pipeline-configs";
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
const hash = "a".repeat(64);

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
  const input = {
    organizationId: org.id,
    projectId: project.id,
    connectionId: connection.id,
    template: "bun-app",
    version: "1.0.0",
    params: { bunVersion: "1" },
    overrides: {},
    renderedHash: hash,
    mrIid: 3,
    mrUrl: "https://gitlab.example/g/p/-/merge_requests/3",
  };
  return { org, connection, project, input };
}

describe("pipeline configurations", () => {
  test("another organization cannot replace a project's configuration", async () => {
    const w = await world();
    const saved = await savePipelineConfig(t.db, w.input);
    const other = await createOrganization(t.db, { slug: `o${++n}`, name: "Other" });
    // the project and connection of the first organization, claimed under another: nothing is replaced
    await expect(
      savePipelineConfig(t.db, {
        ...w.input,
        organizationId: other.id,
        template: "node-app",
        renderedHash: "c".repeat(64),
      }),
    ).rejects.toThrow();
    expect(await getPipelineConfig(t.db, w.org.id, w.project.id)).toEqual(saved);
  });

  test("a project that was never set up has none", async () => {
    const w = await world();
    expect(await getPipelineConfig(t.db, w.org.id, w.project.id)).toBeUndefined();
  });

  test("the last save replaces the one before: one row per project, structures kept as structures", async () => {
    const w = await world();
    const first = await savePipelineConfig(t.db, w.input);
    expect(first).toMatchObject({ template: "bun-app", mrIid: 3, params: { bunVersion: "1" } });
    const second = await savePipelineConfig(t.db, {
      ...w.input,
      params: { bunVersion: "1.2" },
      overrides: { test: { retry: 2 } },
      renderedHash: "b".repeat(64),
      mrIid: null,
      mrUrl: null,
    });
    expect(second.id).toBe(first.id);
    const got = await getPipelineConfig(t.db, w.org.id, w.project.id);
    expect(got).toMatchObject({
      params: { bunVersion: "1.2" },
      overrides: { test: { retry: 2 } },
      renderedHash: "b".repeat(64),
      mrIid: null,
      mrUrl: null,
    });
  });

  test("a project of another organization, or its organization's id with another's project, finds nothing", async () => {
    const a = await world();
    const b = await world();
    await savePipelineConfig(t.db, a.input);
    expect(await getPipelineConfig(t.db, b.org.id, a.project.id)).toBeUndefined();
    expect(await getPipelineConfig(t.db, a.org.id, b.project.id)).toBeUndefined();
  });

  test("cannot be saved for a project that is not in the organization, nor with another organization's connection", async () => {
    const a = await world();
    const b = await world();
    const wrongProject = await savePipelineConfig(t.db, {
      ...a.input,
      projectId: b.project.id,
    }).catch((e) => pgConstraint(e));
    expect(wrongProject).toBe("pipeline_configs_project_org_fk");
    const wrongConnection = await savePipelineConfig(t.db, {
      ...a.input,
      connectionId: b.connection.id,
    }).catch((e) => pgConstraint(e));
    expect(wrongConnection).toBe("pipeline_configs_connection_org_fk");
  });

  test("the hash must be a SHA-256 in hex", async () => {
    const w = await world();
    const bad = await savePipelineConfig(t.db, { ...w.input, renderedHash: "nope" }).catch((e) =>
      pgConstraint(e),
    );
    expect(bad).toBe("pipeline_configs_hash_check");
  });

  test("goes with its project, and holds its connection in place", async () => {
    const w = await world();
    await savePipelineConfig(t.db, w.input);
    const refused = await deleteConnection(t.db, w.org.id, w.connection.id).catch((e) =>
      pgConstraint(e),
    );
    expect(refused).toBe("pipeline_configs_connection_org_fk");
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(await getPipelineConfig(t.db, w.org.id, w.project.id)).toBeUndefined();
    expect(await deleteConnection(t.db, w.org.id, w.connection.id)).toBeTruthy();
  });
});
