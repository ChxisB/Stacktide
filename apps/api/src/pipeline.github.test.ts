import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  createSession,
  type NewStack,
  pipelineConfigs,
  syncStacks,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { githubForge } from "@orch/forge";
import { createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import { createMockGitlab } from "@orch/gitlab/mock";
import { type Platform, renderStackWorkflow, STACK_WORKFLOW_FILE } from "@orch/iac";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { PIPELINE_BRANCH } from "./pipeline-apply";
import { forgeOf } from "./routes/pipeline";
import { hashToken, randomToken } from "./tokens";

// FRG-16: the pipeline routes reach a GitHub connection and deliver the template as a workflow.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const TOKEN = "ghp_not-a-real-token-1234";
const WORKFLOW = ".github/workflows/orch.yml";

let t: TestDb;
let hub: ReturnType<typeof createMockGithub>;
let lab: ReturnType<typeof createMockGitlab>;
let org: string;
let github: string;
let gitlab: string;
let cookie: string;
let app: ReturnType<typeof createApp>;
let located: ReturnType<typeof createApp>; // the same, told where the platform is
const PLATFORM: Platform = { apiUrl: "https://orch.example.com", audience: "orch-platform" };
const logger = createLogger({ level: "debug", write: () => {} });

beforeAll(async () => {
  t = await createTestDb();
  hub = createMockGithub({ token: TOKEN });
  lab = createMockGitlab({ scopes: ["api"] });
  org = (await createOrganization(t.db, { slug: "gh", name: "Gh" })).id;
  const user = await upsertUser(t.db, { gitlabId: 801, username: "alice", name: "alice" });
  const session = randomToken();
  await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
  cookie = `orch_session=${session}`;
  const roles: Pick<Subject, "orgRoles" | "projectRoles"> = {
    orgRoles: { [org]: "admin" },
    projectRoles: {},
  };
  const make = (platform?: Platform) =>
    createApp({
      logger,
      db: t.db,
      principal: callerPrincipal({ db: t.db, roles: () => roles }),
      ready: async () => {},
      keys,
      loopbackConnections: true,
      platform,
    });
  app = make();
  located = make(PLATFORM);
  const connect = async (type: string, baseUrl: string, token: string) =>
    (
      await createConnection(t.db, keys, {
        organizationId: org,
        type,
        name: type,
        config: { baseUrl },
        token,
      })
    ).id;
  github = await connect("github", hub.url, TOKEN);
  gitlab = await connect("gitlab", lab.url, lab.token);
});
afterAll(async () => {
  hub.stop();
  lab.stop();
  await t.drop();
});

let n = 0;
async function world(serve = app) {
  const repo = hub.addRepo("acme", `svc${++n}`, { files: { "bun.lock": "" } });
  const project = await createProject(t.db, {
    organizationId: org,
    name: `acme/svc${n}`,
    gitlabProjectId: repo.id,
    connectionId: github,
  });
  const base = `/organizations/${org}/projects/${project.id}/pipeline`;
  const post = async (path: string, body: unknown) => {
    const res = await serve.handle(
      new Request(`http://localhost${base}${path}`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
  };
  const body = (more: Record<string, unknown> = {}) => ({
    connectionId: github,
    template: "bun-app",
    ...more,
  });
  const forge = githubForge(
    createGithubClient({
      baseUrl: hub.url,
      allowInsecureHttp: true,
      token: TOKEN,
      maxRetries: 0,
    }),
  );
  const file = (ref: string) =>
    forge.repository.getFile(repo.id, WORKFLOW, ref).then(
      (f) => f.content,
      () => null,
    );
  return {
    repo,
    project,
    forge,
    preview: (b = body()) => post("/preview", b),
    apply: (b = body()) => post("", b),
    body,
    file,
  };
}

describe("the pipeline routes with a GitHub connection", () => {
  test("where the platform is reaches the delivery: a project with stacks gets the stack workflow in the pull request (FRG-31)", async () => {
    const stack: NewStack = {
      name: "net",
      path: "net",
      tool: "tofu",
      version: "1.9.8",
      tags: [],
      dependsOn: [],
      watch: [],
      applyOn: "command",
      backend: "http",
    };
    const without = await world();
    await syncStacks(t.db, org, without.project.id, [stack], { prune: false });
    await without.apply();
    const missing = await without.forge.repository
      .getFile(without.repo.id, STACK_WORKFLOW_FILE, PIPELINE_BRANCH)
      .catch(() => null);
    expect(missing).toBeNull();

    const w = await world(located);
    await syncStacks(t.db, org, w.project.id, [stack], { prune: false });
    expect((await w.apply()).status).toBe(200);
    const got = await w.forge.repository.getFile(w.repo.id, STACK_WORKFLOW_FILE, PIPELINE_BRANCH);
    expect(got.content).toBe(renderStackWorkflow(PLATFORM));
  });

  test("a preview shows the workflow, says it was not checked, and writes nothing", async () => {
    const w = await world();
    const res = await w.preview(w.body({ params: { bunVersion: "1.2" } }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ existing: "none", validation: { ok: true } });
    expect(res.json.text).toContain("\njobs:\n");
    expect(res.json.text).toContain("container: oven/bun:1.2");
    expect(res.json.text).not.toContain("stages:");
    expect(res.json.validation.lint.warnings.join()).toContain("was not checked");
    expect(hub.requests.filter((r) => r.method !== "GET" && r.path.includes(w.repo.name))).toEqual(
      [],
    );
  });

  test("an apply opens one pull request with the workflow, stores the configuration and audits it", async () => {
    const w = await world();
    const res = await w.apply();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ outcome: "opened", committed: true, existing: "none" });
    expect(res.json.mr.url).toContain("/pull/");

    const stored = await t.db
      .select()
      .from(pipelineConfigs)
      .where(eq(pipelineConfigs.projectId, w.project.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ template: "bun-app", connectionId: github });
    const audit = (await t.db.select().from(auditEvents)).filter(
      (e) => e.action === "pipeline.apply" && e.projectId === w.project.id,
    );
    expect(audit).toHaveLength(1);
    // the branch the pull request comes from holds the workflow, and the default branch has none
    expect(await w.file(PIPELINE_BRANCH)).toStartWith(
      "# Generated by orch from template bun-app@1.0.0",
    );
    expect(await w.file(PIPELINE_BRANCH)).toContain("\njobs:\n");
    expect(await w.file("main")).toBeNull();
    expect(res.text).not.toContain(TOKEN);
  });

  test("a GitHub that fails once is asked again, and one that fails twice is a 502", async () => {
    const w = await world();
    hub.inject({ method: "GET", path: `/repositories/${w.repo.id}`, status: 500, times: 1 });
    expect((await w.preview()).status).toBe(200);
    hub.inject({ method: "GET", path: `/repositories/${w.repo.id}`, status: 500, times: 2 });
    const res = await w.preview();
    expect([res.status, res.json.code]).toEqual([502, "gitlab_failed"]);
    expect(res.text).not.toContain(TOKEN);
  });

  test("an include or a component is a 422 that says GitHub, and writes nothing", async () => {
    const w = await world();
    const res = await w.apply(
      w.body({ mode: "include", include: { project: "acme/templates", ref: "main" } }),
    );
    expect([res.status, res.json.code]).toEqual([422, "invalid_pipeline"]);
    expect(res.json.detail).toContain("GitHub has no include mode");
    expect(
      await t.db.select().from(pipelineConfigs).where(eq(pipelineConfigs.projectId, w.project.id)),
    ).toEqual([]);
  });

  test("a template with no workflow is a 422 that names it", async () => {
    const w = await world();
    const res = await w.preview(w.body({ template: "docker-deploy" }));
    expect([res.status, res.json.code]).toEqual([422, "invalid_pipeline"]);
    expect(res.json.detail).toBe("docker-deploy@1.0.0 has no GitHub Actions form yet");
  });
});

describe("a connection's forge, by its type", () => {
  const deps = () => ({ db: t.db, keys, logger });
  test("a GitHub connection is GitHub and a GitLab one GitLab", async () => {
    expect((await forgeOf(deps(), org, github, undefined)).kind).toBe("github");
    expect((await forgeOf(deps(), org, gitlab, undefined)).kind).toBe("gitlab");
  });

  test("another organization's connection is not found", async () => {
    const other = (await createOrganization(t.db, { slug: "other", name: "Other" })).id;
    const e = await forgeOf(deps(), other, github, undefined).catch((x) => x);
    expect(e).toMatchObject({ code: "not_found", status: 404 });
  });

  test("a connection that is no forge is a 422, and its secret is not sent anywhere", async () => {
    const vault = (
      await createConnection(t.db, keys, {
        organizationId: org,
        type: "kubernetes",
        name: "k",
        config: { server: "https://k.example" },
        token: "k8s-secret-token",
      })
    ).id;
    const e = await forgeOf(deps(), org, vault, undefined).catch((x) => x);
    expect(e).toMatchObject({ code: "connection_type", status: 422 });
  });
});
