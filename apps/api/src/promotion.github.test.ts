import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  recordDeployment,
  savePipelineConfig,
  setEnvironmentProtection,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGithub } from "@orch/github/mock";
import { loadTemplates, renderWorkflow } from "@orch/pipelines";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

// CLD-11: promote and rollback on a GitHub repository. Feature 31's plan, its refusals and its approvals are the same;
// only the start differs: a `workflow_dispatch` of the repository's deploy workflow with the environment, the build and
// the one it replaces, found again by the run's name.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const TOKEN = "ghp_not-a-real-token-CLD11-CANARY-1234";
const SHA = (c: string) => c.repeat(40);
const WORKFLOW = ".github/workflows/orch.yml";
// what the onboarding PR commits for a `cloud-run` project (a template test pins its `run-name`)
const PARAMS = {
  project: "acme-staging-123",
  region: "europe-west2",
  service: "staging-web-service",
  repository: "staging-web-service",
  provider:
    "projects/123456789/locations/global/workloadIdentityPools/staging-web-deploy/providers/github",
  serviceAccount: "staging-web-deploy@acme-staging-123.iam.gserviceaccount.com",
  deployImage: "example/gcloud-docker:1",
};

const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
const responses: string[] = [];

type Who = "alice" | "bob";
let t: TestDb;
let app: ReturnType<typeof createApp>;
let org: string;
let workflow: string;
const cookies = {} as Record<Who, string>;
const hubs: ReturnType<typeof createMockGithub>[] = [];
let n = 0;
let deploymentId = 5000;

beforeAll(async () => {
  t = await createTestDb();
  const catalog = await loadTemplates();
  const template = catalog.find((c) => c.manifest.name === "cloud-run");
  if (!template) throw new Error("no cloud-run template");
  workflow = renderWorkflow(template, [{ params: PARAMS }]);
  org = (await createOrganization(t.db, { slug: "gh-promote", name: "One" })).id;
  const roles: Pick<Subject, "orgRoles" | "projectRoles"> = {
    orgRoles: { [org]: "admin" },
    projectRoles: {},
  };
  for (const [i, who] of (["alice", "bob"] as const).entries()) {
    const user = await upsertUser(t.db, { gitlabId: 981 + i, username: who, name: who });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    cookies[who] = `orch_session=${session}`;
  }
  app = createApp({
    logger,
    db: t.db,
    principal: callerPrincipal({ db: t.db, roles: () => roles }),
    ready: async () => {},
    keys,
  });
});
afterAll(async () => {
  for (const hub of hubs) hub.stop();
  await t.drop();
});

/**
 * A repository with the deploy workflow, linked to a project set up with `cloud-run` and with environments staging and
 * production. `hubOptions` bends the mock (a start that makes two runs, for an unknown outcome).
 */
async function world(hubOptions: Parameters<typeof createMockGithub>[0] = {}) {
  const hub = createMockGithub({ token: TOKEN, ...hubOptions });
  hubs.push(hub);
  const name = `svc${++n}`;
  const repo = hub.addRepo("acme", name, { files: { [WORKFLOW]: workflow } });
  const connection = (
    await createConnection(t.db, keys, {
      organizationId: org,
      type: "github",
      name: `hub ${n}`,
      config: { baseUrl: hub.url },
      token: TOKEN,
    })
  ).id;
  const project = (
    await createProject(t.db, {
      organizationId: org,
      name,
      gitlabProjectId: repo.id,
      connectionId: connection,
    })
  ).id;
  await savePipelineConfig(t.db, {
    organizationId: org,
    projectId: project,
    connectionId: connection,
    template: "cloud-run",
    version: "1.0.0",
    renderedHash: "0".repeat(64),
  });
  const environments: Record<string, string> = {};
  for (const [i, slug] of ["staging", "production"].entries()) {
    environments[slug] = (
      await createEnvironment(t.db, {
        organizationId: org,
        projectId: project,
        name: slug,
        slug,
        sortOrder: i,
      })
    ).id;
  }
  const base = `/organizations/${org}/projects/${project}`;
  /** A deployment as the worker stores it from GitHub's report; `at` is its day of October 2026. */
  const record = (environment: string, status: string, sha: string, at = 1) =>
    recordDeployment(t.db, {
      organizationId: org,
      projectId: project,
      connectionId: connection,
      gitlabDeploymentId: ++deploymentId,
      environment,
      sha,
      ref: "main",
      status,
      jobId: null,
      pipelineId: null,
      finishedAt: new Date(Date.UTC(2026, 9, at)),
      observedAt: new Date(Date.UTC(2026, 9, at)),
    });
  const call = async (who: Who, method: string, path: string, body?: unknown) => {
    const res = await app.handle(
      new Request(`http://localhost${base}${path}`, {
        method,
        headers: { cookie: cookies[who], "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const text = await res.text();
    responses.push(text);
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    return { status: res.status, json: JSON.parse(text) as any };
  };
  const promote = (body: { environment: string; sha: string; dryRun?: boolean }) =>
    call("alice", "POST", "/deployments/promote", body);
  const rollback = (body: { environment: string; dryRun?: boolean }) =>
    call("alice", "POST", "/deployments/rollback", body);
  /** What was sent to GitHub to start a workflow. */
  const dispatches = () =>
    hub.requests
      .filter((r) => r.method === "POST" && r.path.endsWith("/dispatches"))
      .map((r) => ({ path: r.path, body: r.body }));
  const audited = (action: string) =>
    t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, action), eq(auditEvents.projectId, project)));
  // a protected environment is entered with an approved change request, which the start spends (DEP-17)
  const requests = (slug = "production") => `/environments/${environments[slug]}/change-requests`;
  const approved = async (sha: string) => {
    const asked = await call("alice", "POST", requests(), { kind: "deploy", sha });
    expect(asked.status).toBe(201);
    expect((await call("bob", "POST", `${requests()}/${asked.json.id}/approve`)).status).toBe(200);
    return asked.json.id as string;
  };
  const stateOf = async (id: string) =>
    (await call("alice", "GET", `${requests()}/${id}`)).json.status as string;
  const protect = () =>
    setEnvironmentProtection(t.db, org, project, environments.production as string, true);
  /** Staging ran `b` and production runs `a` since an earlier one `z`: the usual place to promote from. */
  async function ready() {
    await record("production", "success", SHA("z"), 1);
    await record("production", "success", SHA("a"), 2);
    await record("staging", "success", SHA("b"), 3);
  }
  return {
    hub,
    name,
    project,
    environments,
    record,
    call,
    promote,
    rollback,
    dispatches,
    audited,
    approved,
    stateOf,
    protect,
    ready,
  };
}

describe("promoting on GitHub", () => {
  test("starts the deploy workflow on the default branch with the environment, the build and the one it replaces", async () => {
    const w = await world();
    await w.ready();
    // a run of another build, which the new run must not be taken for
    const other = w.hub.addRun("acme", w.name, {
      event: "workflow_dispatch",
      workflow: "orch.yml",
      title: `orch deploy production ${SHA("c")}`,
    });
    w.hub.requests.splice(0);
    const res = await w.promote({ environment: "production", sha: SHA("b") });
    expect(res.status).toBe(202);
    expect(w.dispatches()).toEqual([
      {
        path: `/repos/acme/${w.name}/actions/workflows/orch.yml/dispatches`,
        body: {
          ref: "main",
          inputs: { environment: "production", sha: SHA("b"), previous_sha: SHA("a") },
        },
      },
    ]);
    expect(res.json.dryRun).toBe(false);
    expect(res.json.pipeline.id).not.toBe(other.id);
    expect(res.json.pipeline.webUrl).toContain(`/actions/runs/${res.json.pipeline.id}`);
    const [event] = await w.audited("deployment.promote");
    expect(event?.metadata).toEqual({
      environment: "production",
      sha: SHA("b"),
      previous: SHA("a"),
      pipelineId: res.json.pipeline.id,
      dryRun: false,
    });
  });

  test("into an environment with nothing deployed there sends no previous build", async () => {
    const w = await world();
    await w.record("staging", "success", SHA("b"));
    const res = await w.promote({ environment: "production", sha: SHA("b") });
    expect(res.status).toBe(202);
    expect(w.dispatches()[0]?.body).toEqual({
      ref: "main",
      inputs: { environment: "production", sha: SHA("b") },
    });
  });

  test("a build GitHub has no record of is a 422 and asks GitHub nothing", async () => {
    const w = await world();
    await w.ready();
    w.hub.requests.splice(0);
    const res = await w.promote({ environment: "production", sha: SHA("c") });
    expect([res.status, res.json.code]).toEqual([422, "unknown_build"]);
    expect(w.hub.requests).toEqual([]);
    expect(await w.audited("deployment.promote")).toEqual([]);
  });

  test("a second start while GitHub says one is running is a 409", async () => {
    const w = await world();
    await w.ready();
    await w.record("production", "running", SHA("b"), 4);
    w.hub.requests.splice(0);
    const res = await w.promote({ environment: "production", sha: SHA("b") });
    expect([res.status, res.json.code]).toEqual([409, "deployment_in_progress"]);
    expect(w.hub.requests).toEqual([]);
  });

  test("a dry run answers the plan, asks GitHub nothing, and is audited as a dry run", async () => {
    const w = await world();
    await w.ready();
    w.hub.requests.splice(0);
    const res = await w.promote({ environment: "production", sha: SHA("b"), dryRun: true });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ dryRun: true, pipeline: null, plan: { to: SHA("b") } });
    expect(w.hub.requests).toEqual([]);
    const [event] = await w.audited("deployment.promote");
    expect(event?.metadata).toMatchObject({ dryRun: true, pipelineId: null });
  });

  test("GitHub refusing the start is a problem the person can read; nothing is audited and no GitLab is named", async () => {
    const w = await world();
    await w.ready();
    w.hub.inject({
      method: "POST",
      path: `/repos/acme/${w.name}/actions/workflows/orch.yml/dispatches`,
      status: 422,
      times: 1,
    });
    const res = await w.promote({ environment: "production", sha: SHA("b") });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.json)).not.toContain("GitLab");
    expect(await w.audited("deployment.promote")).toEqual([]);
  });
});

describe("rolling back on GitHub", () => {
  test("dispatches the build that was there before, and names the one it replaces", async () => {
    const w = await world();
    await w.ready(); // production: z, then a
    const res = await w.rollback({ environment: "production" });
    expect(res.status).toBe(202);
    expect(w.dispatches().map((d) => d.body)).toEqual([
      {
        ref: "main",
        inputs: { environment: "production", sha: SHA("z"), previous_sha: SHA("a") },
      },
    ]);
    const [event] = await w.audited("deployment.rollback");
    expect(event?.metadata).toMatchObject({ sha: SHA("z"), previous: SHA("a"), dryRun: false });
  });

  test("with no earlier build there is nothing to roll back to, and GitHub is not asked", async () => {
    const w = await world();
    await w.record("production", "success", SHA("a"));
    w.hub.requests.splice(0);
    const res = await w.rollback({ environment: "production" });
    expect([res.status, res.json.code]).toEqual([409, "nothing_to_roll_back"]);
    expect(w.hub.requests).toEqual([]);
  });
});

describe("a protected environment on GitHub", () => {
  test("without an approved change request the start is refused and GitHub is not asked; a dry run says it is protected", async () => {
    const w = await world();
    await w.ready();
    await w.protect();
    w.hub.requests.splice(0);
    const res = await w.promote({ environment: "production", sha: SHA("b") });
    expect([res.status, res.json.code]).toEqual([409, "approval_required"]);
    expect(w.hub.requests).toEqual([]);
    expect(await w.audited("deployment.promote")).toEqual([]);
    const dry = await w.promote({ environment: "production", sha: SHA("b"), dryRun: true });
    expect(dry.json.plan.protected).toBe(true);
  });

  test("one approval starts one deployment, is spent by it and is named in the audit row", async () => {
    const w = await world();
    await w.ready();
    await w.protect();
    const id = await w.approved(SHA("b"));
    const res = await w.promote({ environment: "production", sha: SHA("b") });
    expect(res.status).toBe(202);
    expect(w.dispatches()).toHaveLength(1);
    expect(await w.stateOf(id)).toBe("applied");
    const [event] = await w.audited("deployment.promote");
    expect(event?.metadata).toMatchObject({
      changeRequestId: id,
      pipelineId: res.json.pipeline.id,
    });
    const again = await w.promote({ environment: "production", sha: SHA("b") });
    expect([again.status, again.json.code]).toEqual([409, "approval_required"]);
    expect(w.dispatches()).toHaveLength(1);
  });

  test("a start GitHub refuses leaves the approval for the next try", async () => {
    const w = await world();
    await w.ready();
    await w.protect();
    const id = await w.approved(SHA("b"));
    w.hub.inject({
      method: "POST",
      path: `/repos/acme/${w.name}/actions/workflows/orch.yml/dispatches`,
      status: 422,
      times: 1,
    });
    expect((await w.promote({ environment: "production", sha: SHA("b") })).status).toBe(422);
    expect(await w.stateOf(id)).toBe("approved");
    expect((await w.promote({ environment: "production", sha: SHA("b") })).status).toBe(202);
  });
});

describe("a start whose outcome GitHub leaves unknown", () => {
  // two runs of the same name appear: the dispatch was accepted, and the platform cannot say which run is the deploy
  test("is a 502 that says so, spends the approval and is audited without a run", async () => {
    const w = await world({ alsoDispatches: true });
    await w.ready();
    await w.protect();
    const id = await w.approved(SHA("b"));
    const res = await w.promote({ environment: "production", sha: SHA("b") });
    expect([res.status, res.json.code]).toEqual([502, "deployment_outcome_unknown"]);
    expect(JSON.stringify(res.json)).toContain("Check the repository");
    expect(await w.stateOf(id)).toBe("applied");
    const [event] = await w.audited("deployment.promote");
    expect(event?.metadata).toMatchObject({
      pipelineId: null,
      dryRun: false,
      outcome: "unknown",
      changeRequestId: id,
    });
  });
});

describe("what reaches the answers and the log", () => {
  test("no token is in an answer or a log line", () => {
    expect(JSON.stringify([responses, lines])).not.toContain(TOKEN);
  });
});
