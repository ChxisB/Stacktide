import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DomainError } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  recordDeployment,
  savePipelineConfig,
  setEnvironmentProtection,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { planPromotion, planRollback } from "./promotion";

// DEP-11: what a promotion would do, decided from the database alone before GitLab is asked anything.

const SHA = (c: string) => c.repeat(40);
const keys = envKeyProvider(`k1:${Buffer.alloc(32, 5).toString("base64")}`);

let t: TestDb;
let org: string;
let connection: string;
let n = 0;
let gitlabId = 0;

beforeAll(async () => {
  t = await createTestDb();
  org = (await createOrganization(t.db, { slug: "acme", name: "Acme" })).id;
  connection = (
    await createConnection(t.db, keys, {
      organizationId: org,
      type: "gitlab",
      name: "live",
      config: { baseUrl: "https://gitlab.example" },
      token: "glpat-not-used",
    })
  ).id;
});
afterAll(() => t.drop());

/** A project with environments qa, staging and production, set up with `docker-deploy` unless told otherwise. */
async function scene(
  o: { template?: string | null; environments?: string[]; defaultBranch?: string } = {},
) {
  const project = await createProject(t.db, {
    organizationId: org,
    name: `web${++n}`,
    defaultBranch: o.defaultBranch,
  });
  const env: Record<string, string> = {};
  for (const [i, slug] of (o.environments ?? ["qa", "staging", "production"]).entries()) {
    env[slug] = (
      await createEnvironment(t.db, {
        organizationId: org,
        projectId: project.id,
        name: slug,
        slug,
        sortOrder: i,
      })
    ).id;
  }
  if (o.template !== null)
    await savePipelineConfig(t.db, {
      organizationId: org,
      projectId: project.id,
      connectionId: connection,
      template: o.template ?? "docker-deploy",
      version: "1.0.0",
      renderedHash: "0".repeat(64),
    });
  /** A deployment as the worker stores it; `at` is its day of October 2026. */
  const deployed = (environment: string, status: string, sha: string, at = 1) =>
    recordDeployment(t.db, {
      organizationId: org,
      projectId: project.id,
      connectionId: null,
      gitlabDeploymentId: ++gitlabId,
      environment,
      sha,
      ref: "main",
      status,
      jobId: null,
      pipelineId: null,
      finishedAt: new Date(Date.UTC(2026, 9, at)),
      observedAt: new Date(Date.UTC(2026, 9, at)),
    });
  const plan = (environment: string, sha: string) =>
    planPromotion(t.db, { project, environment, sha });
  const refusal = async (environment: string, sha: string) => {
    const e = await plan(environment, sha).then(
      () => undefined,
      (x) => x,
    );
    expect(e).toBeInstanceOf(DomainError);
    return e as DomainError;
  };
  const rollback = (environment: string) => planRollback(t.db, { project, environment });
  const rollbackRefusal = async (environment: string) => {
    const e = await rollback(environment).then(
      () => undefined,
      (x) => x,
    );
    expect(e).toBeInstanceOf(DomainError);
    return e as DomainError;
  };
  return { project, env, deployed, plan, refusal, rollback, rollbackRefusal };
}

describe("the plan", () => {
  test("a build that succeeded in staging, into an unprotected production that has one", async () => {
    const s = await scene({ defaultBranch: "trunk" });
    await s.deployed("staging", "success", SHA("b"), 3);
    await s.deployed("production", "success", SHA("a"), 2);
    expect(await s.plan("production", SHA("b"))).toEqual({
      environment: "production",
      environmentId: s.env.production as string,
      protected: false,
      from: { sha: SHA("a"), finishedAt: new Date(Date.UTC(2026, 9, 2)) },
      to: SHA("b"),
      previous: SHA("a"),
      defaultBranch: "trunk",
      variables: ["ORCH_DEPLOY_ENV", "ORCH_DEPLOY_SHA", "ORCH_PREVIOUS_SHA"],
    });
  });

  test("into an environment with nothing deployed there is no previous build, and no third variable", async () => {
    const s = await scene();
    await s.deployed("staging", "success", SHA("b"));
    const plan = await s.plan("production", SHA("b"));
    expect(plan.from).toBeNull();
    expect(plan.previous).toBeNull();
    expect(plan.variables).toEqual(["ORCH_DEPLOY_ENV", "ORCH_DEPLOY_SHA"]);
    expect(plan.defaultBranch).toBe("main");
  });

  test("a failure after the current build does not change what the current build is", async () => {
    const s = await scene();
    await s.deployed("staging", "success", SHA("b"));
    await s.deployed("production", "success", SHA("a"));
    await s.deployed("production", "failed", SHA("c"));
    const plan = await s.plan("production", SHA("b"));
    expect(plan.previous).toBe(SHA("a"));
  });

  test("a build that is current in one environment may go to another and to a third", async () => {
    const s = await scene();
    await s.deployed("qa", "success", SHA("b"));
    expect((await s.plan("staging", SHA("b"))).to).toBe(SHA("b"));
    expect((await s.plan("production", SHA("b"))).to).toBe(SHA("b"));
  });

  test("a build that is no longer current anywhere still counts: it once succeeded", async () => {
    const s = await scene();
    await s.deployed("staging", "success", SHA("a"), 1);
    await s.deployed("staging", "success", SHA("b"), 2);
    expect((await s.plan("production", SHA("a"))).previous).toBeNull();
  });

  test("the plan holds a sha, a time and names: nothing a person or a commit said", async () => {
    const s = await scene();
    await s.deployed("staging", "success", SHA("b"));
    await s.deployed("production", "success", SHA("a"));
    const plan = await s.plan("production", SHA("b"));
    expect(Object.keys(plan).sort()).toEqual(
      [
        "defaultBranch",
        "environment",
        "environmentId",
        "from",
        "previous",
        "protected",
        "to",
        "variables",
      ].sort(),
    );
    expect(Object.keys(plan.from ?? {}).sort()).toEqual(["finishedAt", "sha"]);
    // names, never a value: the sha is in `to` and `previous`, not in the list
    expect(plan.variables.join(" ")).not.toMatch(/[0-9a-f]{40}|production/);
  });
});

describe("what it refuses, in the order the SPEC lists them", () => {
  test("an environment the project does not have is not found", async () => {
    const s = await scene();
    await s.deployed("staging", "success", SHA("b"));
    const e = await s.refusal("legacy", SHA("b"));
    expect([e.code, e.status]).toEqual(["not_found", 404]);
  });

  test("an environment of another project is not found", async () => {
    const s = await scene();
    const other = await scene({ environments: ["elsewhere"] });
    await s.deployed("staging", "success", SHA("b"));
    expect((await s.refusal(Object.keys(other.env)[0] as string, SHA("b"))).code).toBe("not_found");
  });

  // DEP-17: the plan no longer refuses a protected environment; it says so, and the start takes the approval
  test("a protected environment is planned and says it is protected: the start asks for its approval", async () => {
    const s = await scene();
    await s.deployed("staging", "success", SHA("b"));
    await setEnvironmentProtection(t.db, org, s.project.id, s.env.production as string, true);
    expect(await s.plan("production", SHA("b"))).toMatchObject({
      environment: "production",
      protected: true,
      to: SHA("b"),
    });
  });

  test("a build that never succeeded anywhere is unknown, however it ended", async () => {
    const s = await scene();
    await s.deployed("staging", "failed", SHA("b"));
    await s.deployed("staging", "canceled", SHA("c"));
    await s.deployed("staging", "running", SHA("d"));
    for (const sha of [SHA("b"), SHA("c"), SHA("d"), SHA("e")]) {
      const e = await s.refusal("production", sha);
      expect([sha.slice(0, 1), e.code, e.status]).toEqual([sha.slice(0, 1), "unknown_build", 422]);
    }
  });

  test("a build of another project is unknown here", async () => {
    const s = await scene();
    const other = await scene();
    await other.deployed("staging", "success", SHA("b"));
    expect((await s.refusal("production", SHA("b"))).code).toBe("unknown_build");
  });

  test("the build that is already current there is refused", async () => {
    const s = await scene();
    await s.deployed("production", "success", SHA("a"));
    const e = await s.refusal("production", SHA("a"));
    expect([e.code, e.status]).toEqual(["already_deployed", 409]);
  });

  test("an older build that is not current is not 'already deployed'", async () => {
    const s = await scene();
    await s.deployed("production", "success", SHA("a"), 1);
    await s.deployed("production", "success", SHA("b"), 2);
    expect((await s.plan("production", SHA("a"))).previous).toBe(SHA("b"));
  });

  test("a deployment still running or created there is refused, and a finished one is not", async () => {
    for (const status of ["running", "created"]) {
      const s = await scene();
      await s.deployed("staging", "success", SHA("b"));
      await s.deployed("production", status, SHA("c"));
      const e = await s.refusal("production", SHA("b"));
      expect([status, e.code, e.status]).toEqual([status, "deployment_in_progress", 409]);
    }
    const s = await scene();
    await s.deployed("staging", "success", SHA("b"));
    await s.deployed("production", "running", SHA("c"), 1);
    await s.deployed("production", "success", SHA("d"), 2); // newer ids are newer news
    expect((await s.plan("production", SHA("b"))).previous).toBe(SHA("d"));
  });

  test("a project set up with another template, or none, is refused", async () => {
    for (const template of ["bun-app", "docker-image", null]) {
      const s = await scene({ template });
      await s.deployed("staging", "success", SHA("b"));
      const e = await s.refusal("production", SHA("b"));
      expect([template, e.code, e.status]).toEqual([template, "no_deploy_pipeline", 422]);
    }
  });

  test("a value that is not a slug or a sha is a bad request, and is checked first", async () => {
    const s = await scene({ template: null });
    await s.deployed("staging", "success", SHA("b"));
    const badShas = [
      "",
      "abc",
      SHA("b").slice(1),
      `${SHA("b")}0`,
      SHA("B"),
      `${"b".repeat(39)}g`,
      `${"b".repeat(39)}\n`,
      `${SHA("b")} `,
      `-${"b".repeat(39)}`,
      "$(id)".padEnd(40, "b"),
    ];
    for (const sha of badShas) {
      const e = await s.refusal("production", sha);
      expect([sha, e.code, e.status]).toEqual([sha, "invalid_sha", 400]);
    }
    const badSlugs = [
      "",
      "Production",
      "prod uction",
      "-production",
      "production-",
      "pro--duction",
      "production;id",
      "$(id)",
      "production\n",
      "a".repeat(64),
    ];
    for (const environment of badSlugs) {
      const e = await s.refusal(environment, SHA("b"));
      expect([environment, e.code, e.status]).toEqual([environment, "invalid_environment", 400]);
    }
  });
});

describe("the plan of a rollback", () => {
  test("goes back to the newest success there that is not the current build: failures and redeploys are skipped", async () => {
    const s = await scene({ defaultBranch: "trunk" });
    await s.deployed("production", "success", SHA("a"), 1);
    await s.deployed("production", "success", SHA("b"), 2);
    await s.deployed("production", "failed", SHA("x"), 3);
    await s.deployed("production", "success", SHA("c"), 4);
    await s.deployed("production", "success", SHA("c"), 5);
    expect(await s.rollback("production")).toEqual({
      environment: "production",
      environmentId: s.env.production as string,
      protected: false,
      from: { sha: SHA("c"), finishedAt: new Date(Date.UTC(2026, 9, 5)) },
      to: SHA("b"),
      previous: SHA("c"),
      defaultBranch: "trunk",
      variables: ["ORCH_DEPLOY_ENV", "ORCH_DEPLOY_SHA", "ORCH_PREVIOUS_SHA"],
    });
  });

  test("a failure after the current build is not in the way, and another environment's history is not used", async () => {
    const s = await scene();
    await s.deployed("staging", "success", SHA("s"), 1);
    await s.deployed("production", "success", SHA("a"), 2);
    await s.deployed("production", "success", SHA("b"), 3);
    await s.deployed("production", "failed", SHA("c"), 4);
    expect((await s.rollback("production")).to).toBe(SHA("a"));
  });

  test("with nothing before the current build, or no current build, there is nothing to roll back to", async () => {
    const s = await scene();
    await s.deployed("production", "success", SHA("a"), 1);
    await s.deployed("production", "success", SHA("a"), 2); // a redeploy is not an earlier build
    await s.deployed("staging", "failed", SHA("b"), 3);
    await s.deployed("staging", "running", SHA("c"), 4);
    await s.deployed("qa", "success", SHA("d"), 5);
    for (const environment of ["production", "staging", "qa"]) {
      const e = await s.rollbackRefusal(environment);
      expect([environment, e.code, e.status]).toEqual([environment, "nothing_to_roll_back", 409]);
    }
  });

  test("the environment's own refusals apply, in the promotion's order", async () => {
    const s = await scene();
    expect((await s.rollbackRefusal("legacy")).code).toBe("not_found");
    expect((await s.rollbackRefusal("Production")).code).toBe("invalid_environment");
    // an unknown environment is not 'nothing to roll back'
    await s.deployed("production", "success", SHA("a"), 1);
    await s.deployed("production", "success", SHA("b"), 2);
    await s.deployed("production", "running", SHA("c"), 3);
    const busy = await s.rollbackRefusal("production");
    expect([busy.code, busy.status]).toEqual(["deployment_in_progress", 409]);
    const other = await scene({ template: "bun-app" });
    await other.deployed("production", "success", SHA("a"), 1);
    await other.deployed("production", "success", SHA("b"), 2);
    expect((await other.rollbackRefusal("production")).code).toBe("no_deploy_pipeline");
  });
});
