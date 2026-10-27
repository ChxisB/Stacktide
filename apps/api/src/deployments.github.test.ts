import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createConnection,
  createOrganization,
  createProject,
  createSession,
  deployments,
  jobs,
  savePipelineConfig,
  upsertUser,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGithub } from "@orch/github/mock";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { deploymentEventHandler } from "./deployments";
import { workerForge } from "./pipeline-runs";
import { hashToken, randomToken } from "./tokens";
import type { JobContext } from "./worker";

// CLD-10: a deployment on GitHub is followed through signed `deployment_status` webhooks and reads. The event only says
// that a deployment changed; the job reads it from GitHub and stores that, as it does for a GitLab deployment.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const TOKEN = "ghp_not-a-real-token-CLD10-CANARY-1234";
const SECRET = "whsec-cld10-CANARY-0123456789abcdef";
const CANARY = "CANARY-FREE-TEXT-from-the-hook-body";

const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
const responses: string[] = [];
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

let t: TestDb;
let hub: ReturnType<typeof createMockGithub>;
let app: ReturnType<typeof createApp>;
let cookie: string;
let org: string;
let connection: string;
let other: string;
let repoId: number;
let project: string;

const job = (payload: Record<string, unknown>): JobContext => ({
  id: "job",
  queue: WEBHOOK_QUEUE,
  payload,
  attempt: 1,
  maxAttempts: 5,
  log: logger,
  signal: new AbortController().signal,
});
// The GitLab client must never be asked for on behalf of a GitHub event.
const handler = deploymentEventHandler({
  get db() {
    return t.db;
  },
  gitlab: async () => {
    throw new Error("a GitHub event must not open a GitLab client");
  },
  get forge() {
    return workerForge({ db: t.db, keys, logger });
  },
} as Parameters<typeof deploymentEventHandler>[0]);

const allJobs = () => t.db.select().from(jobs).where(eq(jobs.queue, WEBHOOK_QUEUE));
const stored = () => t.db.select().from(deployments).where(eq(deployments.projectId, project));

/** A signed `deployment_status` delivery, then each job it queued through the consumer, as the worker would. */
async function deliver(deploymentId: number, state: string, conn = connection, repo = repoId) {
  const seen = new Set((await allJobs()).map((j) => j.id));
  const raw = JSON.stringify({
    action: "created",
    repository: { id: repo, full_name: "acme/svc" },
    deployment: { id: deploymentId, environment: "staging", description: CANARY },
    deployment_status: { state, description: CANARY, creator: { login: "mallory" } },
  });
  const res = await app.handle(
    new Request(`http://localhost/webhooks/github/${conn}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(raw),
        "x-github-event": "deployment_status",
        "x-github-delivery": crypto.randomUUID(),
      },
      body: raw,
    }),
  );
  responses.push(await res.text());
  expect(res.status).toBe(200);
  const fresh = (await allJobs()).filter((j) => !seen.has(j.id));
  for (const j of fresh) await handler(job(j.payload));
  return fresh;
}

beforeAll(async () => {
  t = await createTestDb();
  hub = createMockGithub({ token: TOKEN });
  repoId = hub.addRepo("acme", "svc").id;
  org = (await createOrganization(t.db, { slug: "gh-deploy", name: "One" })).id;
  const make = async (name: string) =>
    (
      await createConnection(t.db, keys, {
        organizationId: org,
        type: "github",
        name,
        config: { baseUrl: hub.url },
        token: TOKEN,
        webhookSecret: SECRET,
      })
    ).id;
  connection = await make("hub");
  other = await make("hub two");
  project = (
    await createProject(t.db, {
      organizationId: org,
      name: "svc",
      gitlabProjectId: repoId,
      connectionId: connection,
    })
  ).id;
  await savePipelineConfig(t.db, {
    organizationId: org,
    projectId: project,
    connectionId: connection,
    template: "docker-build",
    version: "1.0.0",
    renderedHash: "0".repeat(64),
  });
  const user = await upsertUser(t.db, { gitlabId: 972, username: "alice", name: "alice" });
  const session = randomToken();
  await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
  cookie = `orch_session=${session}`;
  const roles: Pick<Subject, "orgRoles" | "projectRoles"> = {
    orgRoles: { [org]: "admin" },
    projectRoles: {},
  };
  app = createApp({
    logger,
    db: t.db,
    principal: callerPrincipal({ db: t.db, roles: () => roles }),
    ready: async () => {},
    keys,
  });
});
afterAll(async () => {
  hub.stop();
  await t.drop();
});

const call = async (method: string, path: string) => {
  const res = await app.handle(
    new Request(`http://localhost${path}`, { method, headers: { cookie } }),
  );
  const text = await res.text();
  responses.push(text);
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, json: JSON.parse(text) as any };
};
const base = () => `/organizations/${org}/projects/${project}/deployments`;

describe("a deployment_status event", () => {
  test("stores what GitHub says the deployment is, and never what the body said", async () => {
    const d = hub.addDeployment("acme", "svc", { environment: "staging", state: "success" });
    const [queued] = await deliver(d.id, "failure"); // the body lies about the state
    expect(queued?.payload).toMatchObject({ event: "deployment_status", deploymentId: d.id });
    const [row] = (await stored()).filter((r) => r.gitlabDeploymentId === d.id);
    expect(row).toMatchObject({
      environment: "staging",
      status: "success",
      ref: "main",
      jobId: null,
      pipelineId: null,
      connectionId: connection,
    });
    expect(row?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(row?.finishedAt).not.toBeNull();
  });

  test("follows a deployment from in progress to failed, and a repeat changes nothing", async () => {
    const d = hub.addDeployment("acme", "svc", { environment: "staging", state: "in_progress" });
    await deliver(d.id, "in_progress");
    const row = () => stored().then((rs) => rs.find((r) => r.gitlabDeploymentId === d.id));
    expect(await row()).toMatchObject({ status: "running", finishedAt: null });
    hub.setDeployment("acme", "svc", d.id, "failure");
    await deliver(d.id, "failure");
    expect(await row()).toMatchObject({ status: "failed" });
    await deliver(d.id, "failure");
    expect((await stored()).filter((r) => r.gitlabDeploymentId === d.id)).toHaveLength(1);
  });

  test("an event for a repository that is not linked, or for another connection's, is dropped", async () => {
    const d = hub.addDeployment("acme", "svc", { environment: "staging", state: "success" });
    const before = (await stored()).length;
    await deliver(d.id, "success", connection, repoId + 1);
    await deliver(d.id, "success", other);
    expect(await stored()).toHaveLength(before);
  });

  test("an event for a deployment GitHub no longer has is dropped, not retried", async () => {
    const before = (await stored()).length;
    await deliver(2_000_000_000, "success");
    expect(await stored()).toHaveLength(before);
  });

  test("the free text of a delivery reaches no job, no row, no answer and no log", async () => {
    const d = hub.addDeployment("acme", "svc", { environment: "staging", state: "success" });
    await deliver(d.id, "success");
    const everything = JSON.stringify([await allJobs(), await stored(), responses, lines]);
    for (const secret of [CANARY, "mallory", TOKEN, SECRET]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe("refreshing a GitHub project's deployments", () => {
  test("reads what GitHub has and records it; a second refresh reads the same rows again, adding none", async () => {
    const fresh = hub.addDeployment("acme", "svc", { environment: "production", state: "success" });
    const first = await call("POST", `${base()}/refresh`);
    expect(first.status).toBe(200);
    expect(first.json.recorded).toBeGreaterThan(0);
    const count = (await stored()).length;
    // a later read replaces a row, as it does for GitLab (feature 31), so the count of rows is what stays
    expect((await call("POST", `${base()}/refresh`)).json).toEqual(first.json);
    expect(await stored()).toHaveLength(count);
    const listed = await call("GET", `${base()}?environment=production`);
    expect(
      listed.json.deployments.map((d: { gitlabDeploymentId: number }) => d.gitlabDeploymentId),
    ).toContain(fresh.id);
  });

  test("a project that is not linked to a repository cannot refresh", async () => {
    const loose = await createProject(t.db, { organizationId: org, name: "loose" });
    const res = await call(
      "POST",
      `/organizations/${org}/projects/${loose.id}/deployments/refresh`,
    );
    expect(res.status).toBe(422);
  });

  test("a GitHub that refuses is a problem the person can read, and does not name GitLab", async () => {
    hub.inject({
      method: "GET",
      path: "/repos/acme/svc/deployments", // the adapter names the repository first, then asks it
      status: 403,
      times: 1,
    });
    const res = await call("POST", `${base()}/refresh`);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.json)).not.toContain("GitLab");
  });
});
