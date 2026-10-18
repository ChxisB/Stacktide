import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DomainError } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  createSyncTarget,
  createVariable,
  deleteVariable,
  updateSyncTarget,
  type VariableKind,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { loadTemplates, render, type Template } from "@orch/pipelines";
import type { GuardrailConfig } from "@orch/sync";
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
  let connection: string | undefined;
  /** A sync target of the project: GitLab variables, mapping environments to scopes. */
  const target = async (
    mapping: Record<string, string>,
    config: Record<string, unknown> = { project: "fx/p" },
    name = `t${++n}`,
  ) => {
    connection ??= (
      await createConnection(t.db, keys, {
        organizationId: org.id,
        type: "gitlab",
        name: "c",
        token: CANARY,
      })
    ).id;
    return createSyncTarget(t.db, {
      organizationId: org.id,
      projectId: project.id,
      name,
      type: "gitlab-variables",
      connectionId: connection,
      config,
      environmentMapping: mapping,
    });
  };
  return { org, project, at, set, target };
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
      violations: [],
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

describe("the guardrails (POL-4)", () => {
  const check = (
    w: Awaited<ReturnType<typeof world>>,
    over: { environments?: string[]; guardrails?: GuardrailConfig } = {},
  ) => {
    const template = needing();
    return validatePipeline(t.db, {
      ...w.at.project,
      template,
      text: render(template),
      lint: linter(),
      ...over,
    });
  };

  test("an environment that a target that does not protect its variables syncs to production is a violation, in words", async () => {
    const w = await world();
    await w.target({ prod: "production" }, { project: "fx/p" }, "main");
    const r = await check(w);
    expect(r.ok).toBe(false);
    expect(r.lint.valid).toBe(true);
    expect(r.violations).toEqual([
      {
        rule: "production-variable-protected",
        message:
          'environment "prod" is synced to the production scope "production" by the target "main", which does not protect its variables',
      },
    ]);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  test("a target that protects them, or maps the environment elsewhere, or not at all, is fine", async () => {
    const w = await world();
    await w.target({ prod: "production" }, { project: "fx/p", protected: true });
    await w.target({ prod: "staging", dev: "*" });
    await w.target({});
    const r = await check(w);
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test("only the environments asked for are looked at", async () => {
    const w = await world();
    await w.target({ prod: "production" });
    expect((await check(w, { environments: ["dev"] })).violations).toEqual([]);
    expect((await check(w, { environments: ["dev", "prod"] })).violations).toHaveLength(1);
  });

  test("a project with no environments has nothing to break", async () => {
    const w = await world([]);
    await w.target({ prod: "production" });
    expect((await check(w)).violations).toEqual([]);
  });

  test("each target is named, and the setting decides what production is and which rules hold", async () => {
    const w = await world();
    await w.target({ prod: "production" }, { project: "fx/a" }, "a");
    await w.target({ prod: "live" }, { project: "fx/b" }, "b");
    const both = await check(w);
    expect(both.violations.map((v) => v.message.match(/target "(\w+)"/)?.[1])).toEqual(["a"]);
    const live = await check(w, { guardrails: { off: [], production: ["live"] } });
    expect(live.violations.map((v) => v.message.match(/target "(\w+)"/)?.[1])).toEqual(["b"]);
    const off = await check(w, {
      guardrails: { off: ["production-variable-protected"], production: ["production", "live"] },
    });
    expect(off.violations).toEqual([]);
    expect(off.ok).toBe(true);
  });

  test("a target of any type is judged by what its config says, an AWS one too", async () => {
    const w = await world();
    const connection = await createConnection(t.db, keys, {
      organizationId: w.org.id,
      type: "aws_assume_role",
      name: "aws",
      config: { roleArn: "arn:aws:iam::111122223333:role/orch", region: "eu-west-1" },
      token: CANARY,
    });
    const ssm = (name: string, config: Record<string, unknown>) =>
      createSyncTarget(t.db, {
        organizationId: w.org.id,
        projectId: w.project.id,
        name,
        type: "aws-ssm",
        connectionId: connection.id,
        config: { region: "eu-west-1", prefix: "/app", ...config },
        environmentMapping: { prod: "production" },
      });
    await ssm("loose", {});
    await ssm("tight", { protected: true });
    expect((await check(w)).violations.map((v) => v.message)).toEqual([
      'environment "prod" is synced to the production scope "production" by the target "loose", which does not protect its variables',
    ]);
  });

  test("a target whose config the adapter refuses breaks nothing", async () => {
    const w = await world();
    const bad = await w.target({ prod: "production" });
    await updateSyncTarget(t.db, w.org.id, w.project.id, bad.id, { config: { nonsense: true } });
    expect((await check(w)).violations).toEqual([]);
  });

  test("targets are read page after page: one past the first page is still seen", async () => {
    const w = await world();
    for (let i = 0; i < 100; i++) await w.target({}, { project: "fx/p", protected: true });
    await w.target({ prod: "production" }, { project: "fx/p" }, "last");
    expect((await check(w)).violations.map((v) => v.message)).toEqual([
      expect.stringContaining('target "last"'),
    ]);
  });
});
