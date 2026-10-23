import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@orch/api";
import { callerPrincipal } from "@orch/api/credentials";
import { newApiToken } from "@orch/api/tokens";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createApiToken,
  createConnection,
  createDeployRequest,
  createEnvironment,
  createOrganization,
  createProject,
  recordDeployment,
  savePipelineConfig,
  setEnvironmentProtection,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab } from "@orch/gitlab/mock";
import { eq } from "drizzle-orm";
import { runCli } from "./cli";
import { deployCommands } from "./deploy";

// DEP-8: `orch deploy status`, what is deployed where, from the terminal.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);

let t: TestDb;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
let orgId: string;
let projectId: string;
const tokens = {} as Record<"admin" | "viewer" | "stranger" | "approver", string>;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();

const makeApp = () =>
  createApp({
    logger: createLogger({ level: "error", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
    hardening: { rateLimitScale: 100 },
  });

const SHA = (c: string) => c.repeat(40);
let gitlabDeploymentId = 0;
/** A deployment as the worker stores it, finished at `at`. */
const deployed = (environment: string, status: string, sha: string, at: string, ref = "main") =>
  recordDeployment(t.db, {
    organizationId: orgId,
    projectId,
    connectionId: null,
    gitlabDeploymentId: ++gitlabDeploymentId,
    environment,
    sha,
    ref,
    status,
    jobId: null,
    pipelineId: null,
    finishedAt: new Date(at),
    observedAt: new Date(at),
  });

beforeAll(async () => {
  t = await createTestDb();
  orgId = (await createOrganization(t.db, { slug: "acme", name: "Acme Inc" })).id;
  projectId = (await createProject(t.db, { organizationId: orgId, name: "web" })).id;
  for (const [sortOrder, slug] of [
    [0, "qa"],
    [1, "staging"],
    [2, "production"],
  ] as const) {
    await createEnvironment(t.db, {
      organizationId: orgId,
      projectId,
      name: slug,
      slug,
      sortOrder,
    });
  }
  await deployed("staging", "success", SHA("a"), "2026-10-01T10:00:00.000Z");
  await deployed("staging", "failed", SHA("b"), "2026-10-01T11:00:00.000Z");
  await deployed("production", "success", SHA("c"), "2026-10-02T09:00:00.000Z", "release");
  await deployed("legacy-prod", "success", SHA("d"), "2026-09-01T09:00:00.000Z");
  let gitlabId = 770;
  for (const [name, orgRoles] of [
    ["admin", { [orgId]: "admin" }],
    ["viewer", { [orgId]: "viewer" }],
    ["stranger", {}],
    ["approver", { [orgId]: "admin" }],
  ] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const fresh = newApiToken();
    await createApiToken(t.db, {
      userId: user.id,
      name: "test",
      prefix: fresh.prefix,
      tokenHash: fresh.tokenHash,
      scopes: ["*"],
      ttlMs: 3_600_000,
    });
    tokens[name] = fresh.token;
    roleTable.set(gitlabId, { orgRoles, projectRoles: {} });
  }
  app = makeApp().listen({ port: 0, hostname: "127.0.0.1" });
  api = `http://127.0.0.1:${app.server?.port}`;
  dir = await mkdtemp(join(tmpdir(), "orch-deploy-"));
});
afterAll(async () => {
  await app.stop(true);
  await t.drop();
  await rm(dir, { recursive: true, force: true });
});

/** What `confirm` was asked, in order; the answer it gives is `answer`. */
const asked: string[] = [];
async function orch(argv: string[], who: keyof typeof tokens = "admin", answer = true) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: { ORCH_CONFIG: join(dir, "no-config.json"), ORCH_API_URL: api, ORCH_TOKEN: tokens[who] },
    cwd: dir,
    home: dir,
    stdin: async () => "",
    open: async () => {},
    confirm: async (question) => {
      asked.push(question);
      return answer;
    },
    version: "0.0.0",
    commands: deployCommands(),
  });
  return { code, out, err, text: out.join("\n") };
}
const web = ["--org", "acme", "--project", "web"];

describe("orch deploy status", () => {
  test("a line for each environment in order: what is deployed, and the last attempt when it differs", async () => {
    const r = await orch(["deploy", "status", ...web]);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.text.split("\n")).toEqual([
      "qa  current -",
      "staging  current aaaaaaaa main success 2026-10-01T10:00:00.000Z  last bbbbbbbb main failed 2026-10-01T11:00:00.000Z",
      "production  current cccccccc release success 2026-10-02T09:00:00.000Z",
      "in GitLab and not environments here: legacy-prod",
    ]);
  });

  test("--env narrows to one environment, and a name that is not one says what is", async () => {
    const one = await orch(["deploy", "status", "--env", "production", ...web]);
    expect(one.text).toBe("production  current cccccccc release success 2026-10-02T09:00:00.000Z");
    const none = await orch(["deploy", "status", "--env", "nowhere", ...web]);
    expect(none.code).toBe(2);
    expect(none.out).toEqual([]);
    expect(none.err.join(" ")).toContain(
      "no environment 'nowhere'; known: qa, staging, production",
    );
  });

  test("--json is the API's answer, narrowed by --env, and holds exactly the allow-listed keys", async () => {
    const answer = (await (
      await fetch(`${api}/organizations/${orgId}/projects/${projectId}/deployments/environments`, {
        headers: { authorization: `Bearer ${tokens.admin}` },
      })
    ).json()) as Record<string, unknown>;
    const all = JSON.parse((await orch(["--json", "deploy", "status", ...web])).text);
    expect(all).toEqual({ project: "acme/web", ...answer });
    const [staging] = all.environments.filter((e: { slug: string }) => e.slug === "staging");
    expect(Object.keys(staging.current).sort()).toEqual(
      [
        "environment",
        "finishedAt",
        "gitlabDeploymentId",
        "id",
        "jobId",
        "observedAt",
        "pipelineId",
        "ref",
        "sha",
        "status",
      ].sort(),
    );
    const narrowed = JSON.parse(
      (await orch(["--json", "deploy", "status", "--env", "qa", ...web])).text,
    );
    expect(narrowed.environments.map((e: { slug: string }) => e.slug)).toEqual(["qa"]);
    expect(narrowed.unmatched).toEqual([]);
  });

  test("a viewer may read", async () => {
    expect((await orch(["deploy", "status", ...web], "viewer")).code).toBe(0);
  });

  test("a refusal prints the problem's code and nothing else", async () => {
    // a stranger may not look up names, so it gives the ids
    const r = await orch(["deploy", "status", "--org", orgId, "--project", projectId], "stranger");
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.join(" ")).toContain("(not_found)");
  });

  test("a mistake in the words is a usage error and prints nothing on stdout", async () => {
    for (const argv of [
      ["deploy"],
      ["deploy", "nope", ...web],
      ["deploy", "status", "extra", ...web],
      ["deploy", "status", "--tag", "x", ...web],
    ]) {
      const r = await orch(argv);
      expect([argv, r.code, r.out]).toEqual([argv, 2, []]);
    }
  });

  test("what GitLab wrote in a ref or a name cannot move the terminal's cursor or colour it", async () => {
    await deployed("qa", "success", SHA("e"), "2026-10-03T00:00:00.000Z", "main\u001b[31m\u0007");
    await deployed("evil\u001b]0;x\u0007name", "success", SHA("f"), "2026-10-03T00:00:00.000Z");
    const r = await orch(["deploy", "status", ...web]);
    expect(r.code).toBe(0);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the check
    expect(r.text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    expect(r.text).toContain("qa  current eeeeeeee main [31m");
  });
});

// DEP-15: `orch deploy promote` and `orch deploy rollback`, against a project that has the docker-deploy pipeline.
describe("orch deploy status --stats", () => {
  const HOUR = 3_600_000;
  let numbersId: string;
  const numbers = ["--org", "acme", "--project", "numbers"];
  const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);
  const iso = (d: Date) => d.toISOString();
  const done = (environment: string, status: string, sha: string, when: Date) =>
    recordDeployment(t.db, {
      organizationId: orgId,
      projectId: numbersId,
      connectionId: null,
      gitlabDeploymentId: ++gitlabDeploymentId,
      environment,
      sha,
      ref: "main",
      status,
      jobId: null,
      pipelineId: null,
      finishedAt: when,
      observedAt: when,
    });
  const stamps = [at(72), at(48), at(36), at(1)];
  beforeAll(async () => {
    numbersId = (await createProject(t.db, { organizationId: orgId, name: "numbers" })).id;
    for (const [sortOrder, slug] of [
      [0, "staging"],
      [1, "production"],
    ] as const) {
      await createEnvironment(t.db, {
        organizationId: orgId,
        projectId: numbersId,
        name: slug,
        slug,
        sortOrder,
      });
    }
    // one failure, fixed twelve hours later: three that succeeded and one that failed
    await done("staging", "success", SHA("a"), stamps[0] as Date);
    await done("staging", "failed", SHA("b"), stamps[1] as Date);
    await done("staging", "success", SHA("c"), stamps[2] as Date);
    await done("staging", "success", SHA("d"), stamps[3] as Date);
  });

  test("each environment's line gains what the card says under its box, with units; none is a dash", async () => {
    const r = await orch(["deploy", "status", "--stats", ...numbers]);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.text.split("\n")).toEqual([
      `staging  current dddddddd main success ${iso(stamps[3] as Date)}  numbers 0.7 deployments a week · 1 failed in 4 · back in 12 h`,
      "production  current -  numbers -",
    ]);
  });

  test("without the flag there are no numbers in the line", async () => {
    const r = await orch(["deploy", "status", ...numbers]);
    expect(r.text).not.toContain("numbers");
  });

  test("--env narrows the numbers too, and --json adds them beside the API's own answer", async () => {
    const one = await orch(["deploy", "status", "--stats", "--env", "production", ...numbers]);
    expect(one.text).toBe("production  current -  numbers -");
    const json = JSON.parse(
      (await orch(["--json", "deploy", "status", "--stats", "--env", "staging", ...numbers])).text,
    );
    expect(Object.keys(json).sort()).toEqual(["environments", "project", "stats", "unmatched"]);
    expect(json.stats.days).toBe(30);
    expect(json.stats.environments).toEqual([
      {
        environment: "staging",
        deployments: 3,
        failed: 1,
        perWeek: 3 / (30 / 7),
        failureRate: 0.25,
        medianRestoreSeconds: 12 * 3600,
      },
    ]);
    const plain = JSON.parse((await orch(["--json", "deploy", "status", ...numbers])).text);
    expect(Object.keys(plain)).not.toContain("stats");
  });

  test("a viewer may read them, and no commit text or person reaches the terminal", async () => {
    const r = await orch(["deploy", "status", "--stats", ...numbers], "viewer");
    expect(r.code).toBe(0);
    expect(r.text).toContain("0.7 deployments a week");
    expect(r.text).not.toContain("@");
  });

  test("the flag belongs to status: with anything else it is a usage error that prints and sends nothing", async () => {
    for (const argv of [
      ["deploy", "promote", "staging", "--stats", ...numbers],
      ["deploy", "rollback", "staging", "--stats", ...numbers],
      ["deploy", "approve", "staging", "x", "--stats", ...numbers],
      ["deploy", "status", "staging", "--stats", ...numbers],
    ]) {
      const r = await orch(argv);
      expect([argv, r.code, r.out]).toEqual([argv, 2, []]);
    }
  });
});

describe("orch deploy promote and rollback", () => {
  let mock: ReturnType<typeof createMockGitlab>;
  let shop: string;
  const BUILD = (c: string) => SHA(c);
  const started = () =>
    mock.requests.filter((r) => r.method === "POST" && r.path.includes("/pipeline"));
  const rows = async () =>
    (await t.db.select().from(auditEvents).where(eq(auditEvents.projectId, shop))).filter((r) =>
      r.action.startsWith("deployment."),
    );
  const shopArgs = ["--org", "acme", "--project", "shop"];

  beforeAll(async () => {
    mock = createMockGitlab({ scopes: ["api"] });
    const connection = await createConnection(t.db, keys, {
      organizationId: orgId,
      type: "gitlab",
      name: "live",
      config: { baseUrl: mock.url },
      token: mock.token,
    });
    const gl = mock.addProject({
      path: "fx/shop",
      files: { ".gitlab-ci.yml": "deploy:\n  script: [echo deploy]\n" },
    });
    shop = (
      await createProject(t.db, { organizationId: orgId, name: "shop", gitlabProjectId: gl.id })
    ).id;
    await savePipelineConfig(t.db, {
      organizationId: orgId,
      projectId: shop,
      connectionId: connection.id,
      template: "docker-deploy",
      version: "1.0.0",
      renderedHash: "0".repeat(64),
    });
    // dev is first and never has anything: promoting to qa has nothing to default to
    for (const [sortOrder, slug] of [
      [0, "dev"],
      [1, "qa"],
      [2, "staging"],
      [3, "production"],
    ] as const) {
      await createEnvironment(t.db, {
        organizationId: orgId,
        projectId: shop,
        name: slug,
        slug,
        sortOrder,
      });
    }
    const on = (environment: string, status: string, sha: string, at: string) =>
      recordDeployment(t.db, {
        organizationId: orgId,
        projectId: shop,
        connectionId: null,
        gitlabDeploymentId: ++gitlabDeploymentId,
        environment,
        sha,
        ref: "main",
        status,
        jobId: null,
        pipelineId: null,
        finishedAt: new Date(at),
        observedAt: new Date(at),
      });
    await on("staging", "success", BUILD("b"), "2026-10-01T10:00:00.000Z");
    await on("staging", "success", BUILD("c"), "2026-10-02T10:00:00.000Z");
    await on("qa", "success", BUILD("a"), "2026-10-03T10:00:00.000Z");
  });
  afterAll(() => mock.stop());

  test("a dry run prints the plan and starts nothing; the build is the earlier environment's", async () => {
    mock.requests.splice(0);
    const r = await orch(["deploy", "promote", "production", "--dry-run", ...shopArgs]);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.text).toContain("production");
    expect(r.text).toContain("cccccccc");
    expect(r.text).toContain("nothing is deployed there yet");
    expect(started()).toEqual([]);
    expect(asked).toEqual([]);
    const [row] = (await rows()).filter((x) => x.action === "deployment.promote");
    expect(row?.metadata).toMatchObject({ dryRun: true, environment: "production" });
  });

  test("without a yes it asks, and a no sends nothing", async () => {
    mock.requests.splice(0);
    asked.splice(0);
    const before = (await rows()).length;
    const r = await orch(["deploy", "promote", "production", ...shopArgs], "admin", false);
    expect(r.code).toBe(1);
    expect(r.err.join(" ")).toContain("cancelled; nothing was started");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("production");
    expect(started()).toEqual([]);
    // the plan was read (a dry run is audited, as the API says); nothing else was written
    expect((await rows()).length).toBe(before + 1);
  });

  test("a yes starts one pipeline with exactly the three variables, without asking", async () => {
    mock.requests.splice(0);
    asked.splice(0);
    const r = await orch(["deploy", "promote", "production", "--yes", ...shopArgs]);
    expect(r.code).toBe(0);
    expect(asked).toEqual([]);
    expect(started()).toHaveLength(1);
    const id = Number(/pipeline (\d+)/.exec(r.text)?.[1]);
    expect(mock.pipelineVariables(id)).toEqual([
      { key: "ORCH_DEPLOY_ENV", value: "production", type: "env_var" },
      { key: "ORCH_DEPLOY_SHA", value: BUILD("c"), type: "env_var" },
    ]);
    expect(r.text).toContain("http");
  });

  test("an answer of yes to the question starts it once, with --sha and the build that was there", async () => {
    mock.requests.splice(0);
    asked.splice(0);
    const r = await orch(["deploy", "promote", "staging", "--sha", BUILD("a"), ...shopArgs]);
    expect(r.code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(started()).toHaveLength(1);
    const id = Number(/pipeline (\d+)/.exec(r.text)?.[1]);
    expect(mock.pipelineVariables(id)?.map((v) => [v.key, v.value])).toEqual([
      ["ORCH_DEPLOY_ENV", "staging"],
      ["ORCH_DEPLOY_SHA", BUILD("a")],
      ["ORCH_PREVIOUS_SHA", BUILD("c")],
    ]);
    // a build put back when the health check fails is said before it is asked
    expect(r.text).toContain("cccccccc is put back");
  });

  test("no build to default to is a usage error that says why", async () => {
    mock.requests.splice(0);
    for (const [env, words] of [
      ["dev", "no environment comes before dev; give --sha"],
      ["qa", "nothing is deployed to dev; give --sha"],
      ["nowhere", "no environment 'nowhere'; known: dev, qa, staging, production"],
    ] as const) {
      const r = await orch(["deploy", "promote", env, "--yes", ...shopArgs]);
      expect([env, r.code, r.out]).toEqual([env, 2, []]);
      expect(r.err.join(" ")).toContain(words);
    }
    expect(started()).toEqual([]);
  });

  test("a refusal prints the problem's code, exits non-zero and starts nothing", async () => {
    mock.requests.splice(0);
    const unknown = await orch([
      "deploy",
      "promote",
      "production",
      "--sha",
      BUILD("9"),
      "--yes",
      ...shopArgs,
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toEqual([]);
    expect(unknown.err.join(" ")).toContain("(unknown_build)");
    const badSha = await orch([
      "deploy",
      "promote",
      "production",
      "--sha",
      "abc",
      "--yes",
      ...shopArgs,
    ]);
    expect(badSha.err.join(" ")).toContain("(invalid_sha)");
    const none = await orch(["deploy", "rollback", "dev", "--yes", ...shopArgs]);
    expect(none.code).toBe(1);
    expect(none.err.join(" ")).toContain("(nothing_to_roll_back)");
    expect(started()).toEqual([]);
  });

  test("a rollback names its target and says data is not undone; a yes starts it", async () => {
    mock.requests.splice(0);
    const dry = await orch(["deploy", "rollback", "staging", "--dry-run", ...shopArgs]);
    expect(dry.code).toBe(0);
    expect(dry.text).toContain("bbbbbbbb");
    expect(dry.text).toContain("data changes are not undone");
    expect(started()).toEqual([]);
    const r = await orch(["deploy", "rollback", "staging", "--yes", ...shopArgs]);
    expect(r.code).toBe(0);
    const id = Number(/pipeline (\d+)/.exec(r.text)?.[1]);
    expect(mock.pipelineVariables(id)?.map((v) => [v.key, v.value])).toEqual([
      ["ORCH_DEPLOY_ENV", "staging"],
      ["ORCH_DEPLOY_SHA", BUILD("b")],
      ["ORCH_PREVIOUS_SHA", BUILD("c")],
    ]);
    expect((await rows()).some((x) => x.action === "deployment.rollback")).toBe(true);
  });

  test("--json is the API's answer with the project, and holds only ids, names, shas and times", async () => {
    const dry = JSON.parse(
      (await orch(["--json", "deploy", "rollback", "staging", "--dry-run", ...shopArgs])).text,
    );
    expect(Object.keys(dry).sort()).toEqual(["dryRun", "pipeline", "plan", "project"]);
    expect(dry).toMatchObject({ project: "acme/shop", dryRun: true, pipeline: null });
    expect(Object.keys(dry.plan).sort()).toEqual(
      ["defaultBranch", "environment", "from", "previous", "protected", "to", "variables"].sort(),
    );
    const live = JSON.parse(
      (await orch(["--json", "deploy", "rollback", "staging", "--yes", ...shopArgs])).text,
    );
    expect(live.dryRun).toBe(false);
    expect(live.pipeline).toEqual({
      id: expect.any(Number),
      webUrl: expect.stringContaining("http"),
    });
  });

  test("a viewer is refused, and no token or GitLab user or commit text reaches the terminal", async () => {
    mock.requests.splice(0);
    const r = await orch(["deploy", "promote", "production", "--yes", ...shopArgs], "viewer");
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(started()).toEqual([]);
    const everything = [
      r,
      await orch(["deploy", "promote", "production", "--dry-run", ...shopArgs]),
    ]
      .map((x) => [...x.out, ...x.err].join("\n"))
      .join("\n");
    for (const secret of [mock.token, "Mock Deployer", "mock-deployer", "mock commit title"]) {
      expect(everything).not.toContain(secret);
    }
  });

  test("a mistake in the words is a usage error, prints nothing and sends nothing", async () => {
    mock.requests.splice(0);
    for (const argv of [
      ["deploy", "promote"],
      ["deploy", "promote", "qa", "staging"],
      ["deploy", "promote", "qa", "--env", "qa"],
      ["deploy", "rollback"],
      ["deploy", "rollback", "qa", "--sha", BUILD("a")],
      ["deploy", "status", "--yes"],
      ["deploy", "status", "--dry-run"],
      ["deploy", "status", "--sha", BUILD("a")],
    ]) {
      const r = await orch([...argv, ...shopArgs]);
      expect([argv, r.code, r.out]).toEqual([argv, 2, []]);
    }
    expect(started()).toEqual([]);
  });
});

// DEP-18: a protected environment is entered with an approval, asked for and given from the terminal.
describe("orch deploy asking and approving", () => {
  let mock: ReturnType<typeof createMockGitlab>;
  let vault: string;
  let production: string;
  let staging: string;
  const BUILD = (c: string) => SHA(c);
  const started = () =>
    mock.requests.filter((r) => r.method === "POST" && r.path.includes("/pipeline"));
  const vaultArgs = ["--org", "acme", "--project", "vault"];
  /** The deploy requests of an environment as the API lists them. */
  const listed = async (envId: string, status: string) =>
    (
      (await (
        await fetch(
          `${api}/organizations/${orgId}/projects/${vault}/environments/${envId}/change-requests?status=${status}&limit=100`,
          { headers: { authorization: `Bearer ${tokens.admin}` } },
        )
      ).json()) as { items: { id: string; kind: string; subject: { sha: string } }[] }
    ).items.filter((r) => r.kind === "deploy");
  const requestId = (text: string) => /request ([0-9a-f-]{36})/.exec(text)?.[1] ?? "";

  beforeAll(async () => {
    mock = createMockGitlab({ scopes: ["api"] });
    const connection = await createConnection(t.db, keys, {
      organizationId: orgId,
      type: "gitlab",
      name: "vault-live",
      config: { baseUrl: mock.url },
      token: mock.token,
    });
    // a mock numbers its projects from 1 and the shop above already holds that number in this organization
    mock.addProject({ path: "fx/pad", files: {} });
    const gl = mock.addProject({
      path: "fx/vault",
      files: { ".gitlab-ci.yml": "deploy:\n  script: [echo deploy]\n" },
    });
    vault = (
      await createProject(t.db, { organizationId: orgId, name: "vault", gitlabProjectId: gl.id })
    ).id;
    await savePipelineConfig(t.db, {
      organizationId: orgId,
      projectId: vault,
      connectionId: connection.id,
      template: "docker-deploy",
      version: "1.0.0",
      renderedHash: "0".repeat(64),
    });
    const ids: Record<string, string> = {};
    for (const [sortOrder, slug] of [
      [0, "staging"],
      [1, "production"],
    ] as const) {
      ids[slug] = (
        await createEnvironment(t.db, {
          organizationId: orgId,
          projectId: vault,
          name: slug,
          slug,
          sortOrder,
        })
      ).id;
    }
    staging = ids.staging ?? "";
    production = ids.production ?? "";
    await setEnvironmentProtection(t.db, orgId, vault, production, true);
    const on = (environment: string, sha: string, at: string) =>
      recordDeployment(t.db, {
        organizationId: orgId,
        projectId: vault,
        connectionId: null,
        gitlabDeploymentId: ++gitlabDeploymentId,
        environment,
        sha,
        ref: "main",
        status: "success",
        jobId: null,
        pipelineId: null,
        finishedAt: new Date(at),
        observedAt: new Date(at),
      });
    await on("staging", BUILD("a"), "2026-10-01T10:00:00.000Z");
    await on("staging", BUILD("b"), "2026-10-02T10:00:00.000Z");
    await on("production", BUILD("a"), "2026-10-03T10:00:00.000Z");
  });
  afterAll(() => mock.stop());

  test("a dry run says the environment is protected, and asks for nothing", async () => {
    asked.splice(0);
    const r = await orch(["deploy", "promote", "production", "--dry-run", ...vaultArgs]);
    expect(r.code).toBe(0);
    expect(r.text).toContain("protected: starting needs an approval");
    expect(asked).toEqual([]);
    expect(await listed(production, "open")).toEqual([]);
    expect(started()).toEqual([]);
  });

  test("a no to the question asks for nothing", async () => {
    asked.splice(0);
    const r = await orch(["deploy", "promote", "production", ...vaultArgs], "admin", false);
    expect(r.code).toBe(1);
    expect(r.err.join(" ")).toContain("cancelled; nothing was asked");
    expect(asked[0]).toContain("Ask for approval to deploy bbbbbbbb in production");
    expect(await listed(production, "open")).toEqual([]);
  });

  test("without an approval it asks for one, prints the request and how it is approved, and starts nothing", async () => {
    asked.splice(0);
    mock.requests.splice(0);
    const r = await orch(["deploy", "promote", "production", ...vaultArgs]);
    expect(r.code).toBe(0);
    const id = requestId(r.text);
    expect(id).not.toBe("");
    expect(r.text).toContain(`orch deploy approve production ${id}`);
    expect(r.text).toContain("then run this command again to start it");
    expect((await listed(production, "open")).map((x) => [x.id, x.subject])).toEqual([
      [id, { sha: BUILD("b") }],
    ]);
    expect(started()).toEqual([]);
  });

  test("the person who asked cannot approve it; someone else does, and it is then kept for Promote", async () => {
    const [open] = await listed(production, "open");
    const id = open?.id ?? "";
    const own = await orch(["deploy", "approve", "production", id, ...vaultArgs]);
    expect(own.code).toBe(1);
    expect(own.err.join(" ")).toContain("self_approval");
    const other = await orch(["deploy", "approve", "production", id, ...vaultArgs], "approver");
    expect(other.code).toBe(0);
    expect(other.text).toBe(`approved request ${id} to deploy bbbbbbbb to production`);
    expect((await listed(production, "approved")).map((x) => x.id)).toEqual([id]);
  });

  test("with the approval a yes starts one pipeline and uses it up; the next ask is a new request", async () => {
    asked.splice(0);
    mock.requests.splice(0);
    const [approved] = await listed(production, "approved");
    const r = await orch(["deploy", "promote", "production", "--yes", ...vaultArgs]);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/pipeline \d+ started/);
    expect(started()).toHaveLength(1);
    expect(asked).toEqual([]);
    expect(await listed(production, "approved")).toEqual([]);
    const [row] = (
      await t.db.select().from(auditEvents).where(eq(auditEvents.projectId, vault))
    ).filter(
      (x) =>
        x.action === "deployment.promote" && (x.metadata as { dryRun: boolean }).dryRun === false,
    );
    expect(((row?.metadata ?? {}) as { changeRequestId?: string }).changeRequestId).toBe(
      approved?.id,
    );
    // the approval is spent: the same command asks again instead of starting
    const again = await orch(["deploy", "promote", "production", "--yes", ...vaultArgs]);
    expect(again.text).toContain("asked for approval");
    expect(started()).toHaveLength(1);
    expect(await listed(production, "open")).toHaveLength(1);
  });

  test("a rejected request is gone, and --json holds only the ids, names, shas and times it was given", async () => {
    const [open] = await listed(production, "open");
    const id = open?.id ?? "";
    const r = await orch(
      ["--json", "deploy", "reject", "production", id, ...vaultArgs],
      "approver",
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.text)).toEqual({
      project: "acme/vault",
      request: { id, status: "rejected", sha: BUILD("b"), environment: "production" },
    });
    expect(await listed(production, "open")).toEqual([]);
    const asked1 = JSON.parse(
      (await orch(["--json", "deploy", "promote", "production", "--yes", ...vaultArgs])).text,
    );
    expect(Object.keys(asked1).sort()).toEqual(["asked", "project"]);
    expect(Object.keys(asked1.asked).sort()).toEqual(["environment", "id", "sha"]);
    const everything = JSON.stringify(asked1);
    for (const secret of [mock.token, tokens.admin, "Mock Deployer", "mock commit title"])
      expect(everything).not.toContain(secret);
  });

  test("an approval for another build does not start this one: the command asks again", async () => {
    mock.requests.splice(0);
    const made = (await (
      await fetch(
        `${api}/organizations/${orgId}/projects/${vault}/environments/${production}/change-requests`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${tokens.admin}`, "content-type": "application/json" },
          body: JSON.stringify({ kind: "deploy", sha: BUILD("a") }),
        },
      )
    ).json()) as { id: string };
    const ok = await orch(["deploy", "approve", "production", made.id, ...vaultArgs], "approver");
    expect(ok.code).toBe(0);
    const r = await orch(["deploy", "promote", "production", "--yes", ...vaultArgs]);
    expect(r.text).toContain("asked for approval");
    expect(started()).toEqual([]);
    expect((await listed(production, "approved")).map((x) => x.id)).toEqual([made.id]);
  });

  test("an approval that has lapsed is not one: the command asks again", async () => {
    mock.requests.splice(0);
    // a request that lives for a moment: the API only makes ones that live for days
    const short = await createDeployRequest(t.db, {
      organizationId: orgId,
      projectId: vault,
      environmentId: production,
      sha: BUILD("b"),
      diff: [{ action: "apply", key: "production" }],
      author: { kind: "user", id: "00000000-0000-7000-8000-000000000001", ref: "user:gone" },
      expiresAt: new Date(Date.now() + 1500),
    });
    const ok = await orch(["deploy", "approve", "production", short.id, ...vaultArgs], "approver");
    expect(ok.code).toBe(0);
    await Bun.sleep(1600);
    const r = await orch(["deploy", "promote", "production", "--yes", ...vaultArgs]);
    expect(r.text).toContain("asked for approval");
    expect(started()).toEqual([]);
  });

  test("a rollback in a protected environment asks for the build it would restore", async () => {
    await setEnvironmentProtection(t.db, orgId, vault, staging, true);
    try {
      const r = await orch(["deploy", "rollback", "staging", "--yes", ...vaultArgs]);
      expect(r.code).toBe(0);
      expect(r.text).toContain("to roll back to aaaaaaaa in staging");
      expect((await listed(staging, "open")).map((x) => x.subject)).toEqual([{ sha: BUILD("a") }]);
    } finally {
      await setEnvironmentProtection(t.db, orgId, vault, staging, false);
    }
  });

  test("a mistake in the words, or an environment that is not one, prints nothing on stdout and changes nothing", async () => {
    const before = (await listed(production, "open")).length;
    for (const argv of [
      ["deploy", "approve"],
      ["deploy", "approve", "production"],
      ["deploy", "approve", "production", "one", "two"],
      ["deploy", "approve", "production", "one", "--yes"],
      ["deploy", "reject", "production", "one", "--dry-run"],
      ["deploy", "reject", "production", "one", "--sha", BUILD("a")],
    ]) {
      const r = await orch([...argv, ...vaultArgs]);
      expect([argv, r.code, r.out]).toEqual([argv, 2, []]);
    }
    const unknown = await orch(["deploy", "approve", "nowhere", "one", ...vaultArgs]);
    expect([unknown.code, unknown.out]).toEqual([2, []]);
    expect(unknown.err.join(" ")).toContain("no environment 'nowhere'");
    expect((await listed(production, "open")).length).toBe(before);
  });
});
