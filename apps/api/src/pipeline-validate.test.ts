import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DomainError } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createEnvironment,
  createOrganization,
  createProject,
  createVariable,
  deleteVariable,
  type VariableKind,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { loadTemplates, render, type Template } from "@orch/pipelines";
import { validatePipeline } from "./pipeline-validate";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const CANARY = "s3cr3t-CANARY-value-0123456789";
const actor = { kind: "user", id: "u1" };

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let bun: Template;
beforeAll(async () => {
  t = await createTestDb();
  bun = (await loadTemplates()).find((x) => x.manifest.name === "bun-app") as Template;
});
afterAll(async () => {
  mock?.stop();
  await t.drop();
});

/** A template that needs these variables; the pipeline is the shipped one. */
const needing = (...requiresVariables: string[]): Template => ({
  ...bun,
  manifest: { ...bun.manifest, requiresVariables },
});

let n = 0;
async function world(environments = ["dev", "prod"]) {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${n}` });
  const envs: Record<string, string> = {};
  for (const slug of environments) {
    envs[slug] = (
      await createEnvironment(t.db, {
        organizationId: org.id,
        projectId: project.id,
        name: slug,
        slug,
      })
    ).id;
  }
  const at = {
    org: { organizationId: org.id },
    project: { organizationId: org.id, projectId: project.id },
    env: (slug: string) => ({ ...at.project, environmentId: envs[slug] }),
  };
  const set = (
    scope: { organizationId: string; projectId?: string; environmentId?: string },
    key: string,
    kind: VariableKind = "secret",
  ) => createVariable(t.db, keys, { ...scope, key, kind, value: CANARY, actor });
  return { org, project, at, set };
}

/** Lint through the mock, as the route will through a connection's client. */
function linter(options: Parameters<typeof createMockGitlab>[0] = {}) {
  mock?.stop();
  mock = createMockGitlab(options);
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const project = mock.addProject({ path: "fx/p" });
  return (content: string) => api.ci.lint(project.id, content);
}

describe("validatePipeline", () => {
  test("a rendered starter pipeline with every required variable set is ok", async () => {
    const w = await world();
    await w.set(w.at.org, "REGION", "plain");
    await w.set(w.at.project, "DEPLOY_TOKEN");
    const template = needing("REGION", "DEPLOY_TOKEN");
    const r = await validatePipeline(t.db, {
      ...w.at.project,
      template,
      text: render(template),
      lint: linter(),
    });
    expect(r).toEqual({
      ok: true,
      lint: { valid: true, errors: [], warnings: [] },
      missingVariables: [],
    });
  });

  test("names, per environment, what the template needs and is not set there", async () => {
    const w = await world(["dev", "prod", "stage"]);
    await w.set(w.at.org, "REGION");
    await w.set(w.at.project, "DEPLOY_TOKEN");
    await w.set(w.at.env("prod"), "DB_URL");
    await w.set(w.at.env("stage"), "REGION"); // set twice is still set
    const template = needing("DB_URL", "DEPLOY_TOKEN", "REGION");
    const r = await validatePipeline(t.db, {
      ...w.at.project,
      template,
      text: render(template),
      lint: linter(),
    });
    expect(r.ok).toBe(false);
    expect(r.lint.valid).toBe(true);
    expect(r.missingVariables).toEqual([
      { environment: "dev", keys: ["DB_URL"] },
      { environment: "stage", keys: ["DB_URL"] },
    ]);
  });

  test("lint errors and warnings come from GitLab", async () => {
    const w = await world();
    const bad = await validatePipeline(t.db, {
      ...w.at.project,
      template: bun,
      text: "build:\n  stage: build\n",
      lint: linter(),
    });
    expect(bad.ok).toBe(false);
    expect(bad.lint.valid).toBe(false);
    expect(bad.lint.errors.join("\n")).toContain("build");

    const warned = await validatePipeline(t.db, {
      ...w.at.project,
      template: bun,
      text: render(bun),
      lint: linter({ lintWarnings: ["jobs:test may allow multiple pipelines"] }),
    });
    expect(warned.ok).toBe(true);
    expect(warned.lint.warnings).toEqual(["jobs:test may allow multiple pipelines"]);
  });

  test("only the environments asked for are checked; one that does not exist is refused", async () => {
    const w = await world();
    await w.set(w.at.env("prod"), "TOKEN");
    const template = needing("TOKEN");
    const input = { ...w.at.project, template, text: render(template), lint: linter() };
    expect(
      (await validatePipeline(t.db, { ...input, environments: ["prod"] })).missingVariables,
    ).toEqual([]);
    expect(
      (await validatePipeline(t.db, { ...input, environments: ["dev"] })).missingVariables,
    ).toEqual([{ environment: "dev", keys: ["TOKEN"] }]);

    const refused = await validatePipeline(t.db, {
      ...input,
      environments: ["prod", "qa", "uat"],
    }).catch((e) => e);
    expect(refused).toBeInstanceOf(DomainError);
    expect(refused).toMatchObject({ code: "unknown_environment", status: 422 });
    expect(refused.message).toContain("qa, uat");
  });

  test("an empty list of environments means all of them", async () => {
    const w = await world();
    const template = needing("TOKEN");
    const r = await validatePipeline(t.db, {
      ...w.at.project,
      template,
      text: render(template),
      lint: linter(),
      environments: [],
    });
    expect(r.missingVariables.map((m) => m.environment)).toEqual(["dev", "prod"]);
  });

  test("a project that is not in the organization is not found, not a pass", async () => {
    const w = await world();
    const w2 = await world();
    const input = { template: bun, text: render(bun), lint: linter() };
    const wrongOrg = { organizationId: w2.org.id, projectId: w.project.id };
    expect(await validatePipeline(t.db, { ...input, ...wrongOrg }).catch((e) => e)).toMatchObject({
      code: "not_found",
      status: 404,
    });
    const nobody = { organizationId: w.org.id, projectId: Bun.randomUUIDv7() };
    expect(await validatePipeline(t.db, { ...input, ...nobody }).catch((e) => e)).toMatchObject({
      code: "not_found",
    });
  });

  test("a project with no environments is checked at its own level, once", async () => {
    const w = await world([]);
    await w.set(w.at.org, "A");
    const template = needing("A", "B");
    const r = await validatePipeline(t.db, {
      ...w.at.project,
      template,
      text: render(template),
      lint: linter(),
    });
    expect(r.missingVariables).toEqual([{ environment: null, keys: ["B"] }]);
  });

  test("a deleted variable, another environment's, another project's and another organization's do not count", async () => {
    const w = await world();
    const w2 = await world();
    const gone = await w.set(w.at.project, "GONE");
    await deleteVariable(t.db, w.at.project, gone.id);
    await w.set(w.at.env("dev"), "ONLY_DEV");
    await w2.set(w2.at.project, "THEIRS");
    await w2.set(w2.at.org, "THEIR_ORG");
    const sibling = await createProject(t.db, { organizationId: w.org.id, name: "sibling" });
    await w.set({ organizationId: w.org.id, projectId: sibling.id }, "SIBLING");
    const template = needing("GONE", "ONLY_DEV", "THEIRS", "THEIR_ORG", "SIBLING");
    const r = await validatePipeline(t.db, {
      ...w.at.project,
      template,
      text: render(template),
      lint: linter(),
    });
    expect(r.missingVariables).toEqual([
      { environment: "dev", keys: ["GONE", "THEIRS", "THEIR_ORG", "SIBLING"] },
      { environment: "prod", keys: ["GONE", "ONLY_DEV", "THEIRS", "THEIR_ORG", "SIBLING"] },
    ]);
  });

  test("the report holds names only: no value, and no master key is needed to make it", async () => {
    const w = await world();
    await w.set(w.at.project, "DEPLOY_TOKEN");
    const template = needing("DEPLOY_TOKEN", "OTHER");
    const lint = linter();
    const r = await validatePipeline(t.db, {
      ...w.at.project,
      template,
      text: render(template),
      lint,
    });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(mock.requests)).not.toContain(CANARY);
    expect(validatePipeline.length).toBe(2); // (db, input): there is no key provider to open anything with
  });
});
