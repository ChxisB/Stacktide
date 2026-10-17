import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { createConnection, deleteConnection } from "./connections";
import { pgConstraint } from "./pg-error";
import { getPipelineConfig, listPinnedPipelines, savePipelineConfig } from "./pipeline-configs";
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

  test("is delivered inline unless it includes a templates project; switching back clears the project", async () => {
    const w = await world();
    const first = await savePipelineConfig(t.db, w.input);
    expect(first).toMatchObject({ mode: "inline", includeProject: null, includeRef: null });
    const included = await savePipelineConfig(t.db, {
      ...w.input,
      mode: "include",
      includeProject: "grp/ci-templates",
      includeRef: "main",
    });
    expect(included.id).toBe(first.id);
    expect(await getPipelineConfig(t.db, w.org.id, w.project.id)).toMatchObject({
      mode: "include",
      includeProject: "grp/ci-templates",
      includeRef: "main",
    });
    const ejected = await savePipelineConfig(t.db, {
      ...w.input,
      mode: "inline",
      includeProject: null,
      includeRef: null,
    });
    expect(ejected).toMatchObject({ mode: "inline", includeProject: null, includeRef: null });
  });

  test("the mode is one of two, and a templates project goes with the include mode alone", async () => {
    const w = await world();
    const refused = (over: Record<string, unknown>) =>
      savePipelineConfig(t.db, { ...w.input, ...over } as typeof w.input).catch((e) =>
        pgConstraint(e),
      );
    expect(await refused({ mode: "thin" })).toBe("pipeline_configs_mode_check");
    expect(await refused({ mode: "include" })).toBe("pipeline_configs_include_check");
    expect(await refused({ mode: "inline", includeProject: "grp/x" })).toBe(
      "pipeline_configs_include_check",
    );
    expect(await refused({ mode: "inline", includeRef: "main" })).toBe(
      "pipeline_configs_include_check",
    );
    expect(await refused({ mode: "include", includeRef: "main" })).toBe(
      "pipeline_configs_include_check",
    );
    // a ref is optional: the default branch of the templates project
    expect(await refused({ mode: "include", includeProject: "grp/x" })).toMatchObject({
      mode: "include",
      includeRef: null,
    });
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

  test("lists an organization's projects on a template at another version, by project id, a page at a time", async () => {
    const w = await world();
    const pin = async (template: string, version: string) => {
      const p = await createProject(t.db, { organizationId: w.org.id, name: `q${++n}` });
      await savePipelineConfig(t.db, { ...w.input, projectId: p.id, template, version });
      return { id: p.id, name: p.name };
    };
    const a = await pin("bun-app", "1.0.0");
    await pin("bun-app", "1.1.0"); // already there
    const c = await pin("bun-app", "0.9.0");
    await pin("node-app", "1.0.0"); // another template
    await savePipelineConfig(t.db, (await world()).input); // another organization's bun-app 1.0.0
    const ask = (after?: string, limit = 10) =>
      listPinnedPipelines(t.db, w.org.id, {
        template: "bun-app",
        notVersion: "1.1.0",
        after,
        limit,
      });

    const all = await ask();
    expect(all.map((r) => [r.config.projectId, r.projectName, r.config.version])).toEqual(
      [
        [a.id, a.name, "1.0.0"],
        [c.id, c.name, "0.9.0"],
      ].sort((x, y) => (x[0] ?? "").localeCompare(y[0] ?? "")),
    );
    const ids = all.map((r) => r.config.projectId);
    const first = await ask(undefined, 1);
    expect(first.map((r) => r.config.projectId)).toEqual(ids.slice(0, 1));
    expect((await ask(ids[0])).map((r) => r.config.projectId)).toEqual(ids.slice(1));
    expect(await ask(ids[1])).toEqual([]);
  });
});
