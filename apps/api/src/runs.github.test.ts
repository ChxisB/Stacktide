import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  attachRunPipeline,
  createConnection,
  createOrganization,
  createProject,
  createRun,
  createSession,
  getRun,
  jobs,
  listPipelineRuns,
  moveRunStack,
  pipelineRuns,
  runStacks,
  upsertUser,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGithub } from "@orch/github/mock";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { pipelineEventHandler, workerForge } from "./pipeline-runs";
import { runEventHandler } from "./run-ingest";
import { hashToken, randomToken } from "./tokens";
import { chain, type JobContext } from "./worker";

// FRG-22: a run on GitHub is followed through signed webhooks and reads. The events only say that something changed;
// the handlers read the run and its jobs from GitHub and move each stack to where its job says it is. A stack whose
// apply job GitHub holds for reviewers is `applying` and carries the job's page, so a person can go and approve it:
// the platform never approves anything itself.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const TOKEN = "ghp_not-a-real-token-FRG22-CANARY-1234";
const SECRET = "whsec-frg22-CANARY-0123456789abcdef";

const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
const signatures: string[] = [];
const sign = (body: string) => {
  const hex = createHmac("sha256", SECRET).update(body).digest("hex");
  signatures.push(hex);
  return `sha256=${hex}`;
};

let t: TestDb;
let hub: ReturnType<typeof createMockGithub>;
let app: ReturnType<typeof createApp>;
let cookie: string;
let org: string;
let connection: string;
let repoId: number;
let project: string;
let n = 0;
const responses: string[] = [];

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
const deps = () => ({
  db: t.db,
  gitlab: async () => {
    throw new Error("a GitHub event must not open a GitLab client");
  },
  forge: workerForge({ db: t.db, keys, logger }),
});
const consume = (payload: Record<string, unknown>) =>
  chain(pipelineEventHandler(deps()), runEventHandler(deps()))(job(payload));

const allJobs = () => t.db.select().from(jobs).where(eq(jobs.queue, WEBHOOK_QUEUE));

/** Sends a signed delivery to the receiver, then runs each job it queued through the consumers, as the worker would. */
async function deliver(event: string, body: object, conn = connection) {
  const seen = new Set((await allJobs()).map((j) => j.id));
  const raw = JSON.stringify(body);
  const res = await app.handle(
    new Request(`http://localhost/webhooks/github/${conn}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(raw),
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
      },
      body: raw,
    }),
  );
  responses.push(await res.text());
  expect(res.status).toBe(200);
  const fresh = (await allJobs()).filter((j) => !seen.has(j.id));
  for (const j of fresh) await consume(j.payload);
  return fresh.length;
}

const repository = () => ({ id: repoId, full_name: "acme/svc" });
const runEvent = (id: number, status: string, conclusion: string | null = null) =>
  deliver("workflow_run", {
    action: status === "completed" ? "completed" : "in_progress",
    repository: repository(),
    workflow_run: { id, status, conclusion, head_branch: "main", head_sha: "a".repeat(40) },
  });
const jobEvent = (runId: number, name: string, status: string, conclusion: string | null = null) =>
  deliver("workflow_job", {
    action: status,
    repository: repository(),
    workflow_job: { id: 1, run_id: runId, name, status, conclusion },
  });
const reviewEvent = (runId: number, action: string) =>
  deliver("deployment_review", {
    action,
    repository: repository(),
    environment: "orch-apply",
    workflow_run: { id: runId },
  });

/** A run of two stacks, `app` after `net`, and the workflow run that plans it. */
async function world(over: { projectId?: string } = {}) {
  const run = await createRun(t.db, {
    organizationId: org,
    projectId: over.projectId ?? project,
    ref: "main",
    sha: "a".repeat(40),
    stacks: ["net", "app"],
  });
  const plan = hub.addRun("acme", "svc", {
    status: "queued",
    title: `orch ${run.id} plan`,
    jobs: [
      { name: "plan:net", status: "queued" },
      { name: "plan:app", status: "queued" },
    ],
  });
  await attachRunPipeline(t.db, {
    organizationId: org,
    projectId: over.projectId ?? project,
    runId: run.id,
    gitlabPipelineId: plan.id,
    action: "plan",
  });
  const states = async () => {
    const now = await getRun(t.db, org, over.projectId ?? project, run.id);
    return Object.fromEntries(
      (now?.stacks ?? []).map((s) => [s.stack, [s.status, s.approvalUrl] as const]),
    );
  };
  return { run, plan, states };
}

beforeAll(async () => {
  t = await createTestDb();
  hub = createMockGithub({ token: TOKEN });
  repoId = hub.addRepo("acme", "svc").id;
  org = (await createOrganization(t.db, { slug: "gh-runs", name: "One" })).id;
  connection = (
    await createConnection(t.db, keys, {
      organizationId: org,
      type: "github",
      name: "hub",
      config: { baseUrl: hub.url },
      token: TOKEN,
      webhookSecret: SECRET,
    })
  ).id;
  project = (
    await createProject(t.db, {
      organizationId: org,
      name: "svc",
      gitlabProjectId: repoId,
      connectionId: connection,
    })
  ).id;
  const user = await upsertUser(t.db, { gitlabId: 971, username: "alice", name: "alice" });
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

const api = async (path: string) => {
  const res = await app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }));
  const text = await res.text();
  responses.push(text);
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, json: JSON.parse(text) as any };
};

describe("a run on GitHub, through signed webhooks and reads", () => {
  test("goes queued, running, waiting for approval, approved and succeeded, and the stacks follow it", async () => {
    const w = await world();

    // queued: the run is read and stored, no stack has moved
    await runEvent(w.plan.id, "queued");
    expect(await w.states()).toEqual({ net: ["queued", null], app: ["queued", null] });

    // net is planning, app has not started
    hub.setRun("acme", "svc", w.plan.id, { status: "in_progress" });
    hub.setJob("acme", "svc", w.plan.id, "plan:net", { status: "in_progress" });
    await jobEvent(w.plan.id, "plan:net", "in_progress");
    expect(await w.states()).toEqual({ net: ["planning", null], app: ["queued", null] });

    // both planned
    hub.setRun("acme", "svc", w.plan.id, { status: "completed", conclusion: "success" });
    for (const name of ["plan:net", "plan:app"]) {
      hub.setJob("acme", "svc", w.plan.id, name, { status: "completed", conclusion: "success" });
    }
    await runEvent(w.plan.id, "completed", "success");
    expect(await w.states()).toEqual({ net: ["planned", null], app: ["planned", null] });

    // an apply is started (whoever starts it takes the stacks into `applying`; FRG-32 does it for a command)
    const apply = hub.addRun("acme", "svc", {
      status: "waiting",
      title: `orch ${w.run.id} apply`,
      jobs: [
        { name: "apply:net", status: "waiting" },
        { name: "apply:app", status: "queued" },
      ],
    });
    await attachRunPipeline(t.db, {
      organizationId: org,
      projectId: project,
      runId: w.run.id,
      gitlabPipelineId: apply.id,
      action: "apply",
    });
    for (const stack of ["net", "app"]) {
      await moveRunStack(t.db, org, project, w.run.id, stack, "planned", "applying");
    }

    // net is held for reviewers: it carries the job's page, app (behind it) does not
    await jobEvent(apply.id, "apply:net", "waiting");
    const held = await w.states();
    expect(held.net?.[0]).toBe("applying");
    expect(held.net?.[1]).toMatch(
      new RegExp(`^https://github\\.example/acme/svc/actions/runs/${apply.id}/job/\\d+$`),
    );
    expect(held.app).toEqual(["applying", null]);
    expect((await listPipelineRuns(t.db, org, project, { limit: 10 }))[0]?.status).toBe("manual");

    // the run's API says what the stack is waiting for
    const shown = await api(`/organizations/${org}/projects/${project}/runs/${w.run.id}`);
    expect(shown.status).toBe(200);
    const stacks = Object.fromEntries(
      shown.json.stacks.map((s: { name: string; status: string; approvalUrl: string | null }) => [
        s.name,
        s,
      ]),
    );
    expect(stacks.net.approvalUrl).toBe(held.net?.[1]);
    expect(stacks.app.approvalUrl).toBeNull();

    // a reviewer approves in GitHub: the page is dropped and the job runs
    hub.setRun("acme", "svc", apply.id, { status: "in_progress" });
    hub.setJob("acme", "svc", apply.id, "apply:net", { status: "in_progress" });
    await reviewEvent(apply.id, "approved");
    expect(await w.states()).toEqual({ net: ["applying", null], app: ["applying", null] });

    // level two is held next, net is applied
    hub.setJob("acme", "svc", apply.id, "apply:net", {
      status: "completed",
      conclusion: "success",
    });
    hub.setRun("acme", "svc", apply.id, { status: "waiting" });
    hub.setJob("acme", "svc", apply.id, "apply:app", { status: "waiting" });
    await jobEvent(apply.id, "apply:app", "waiting");
    const second = await w.states();
    expect(second.net).toEqual(["applied", null]);
    expect(second.app?.[0]).toBe("applying");
    expect(second.app?.[1]).toContain(`/actions/runs/${apply.id}/job/`);
    expect(second.app?.[1]).not.toBe(held.net?.[1]);

    // approved and done
    hub.setRun("acme", "svc", apply.id, { status: "completed", conclusion: "success" });
    hub.setJob("acme", "svc", apply.id, "apply:app", {
      status: "completed",
      conclusion: "success",
    });
    await reviewEvent(apply.id, "approved");
    await runEvent(apply.id, "completed", "success");
    expect(await w.states()).toEqual({ net: ["applied", null], app: ["applied", null] });
  });

  test("the platform never approves: it only reads, and the forge has nothing to approve with", async () => {
    // everything above was reads; the mock saw no write, and no call to a deployment-protection or review route
    expect(hub.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(hub.requests.some((r) => /pending_deployments|approve|force-cancel/.test(r.path))).toBe(
      false,
    );
    const forge = await workerForge({ db: t.db, keys, logger })(org, connection);
    expect(Object.keys(forge.pipelines).filter((k) => /approv|review|deploy/i.test(k))).toEqual([]);
  });
});

describe("events that are not about a run of this repository", () => {
  test("an event for a repository that is not linked reads nothing", async () => {
    const before = hub.requests.length;
    await deliver("workflow_run", {
      action: "completed",
      repository: { id: repoId + 1000, full_name: "acme/other" },
      workflow_run: { id: 5, status: "completed", conclusion: "success" },
    });
    expect(hub.requests.length).toBe(before);
  });

  // before the next test: that one gives the organization a GitLab project with this repository's number
  test("a GitLab event on a GitHub connection is not a run's event", async () => {
    const w = await world();
    const before = hub.requests.length;
    await consume({
      event: "pipeline",
      organizationId: org,
      connectionId: connection,
      projectId: repoId,
      pipelineId: w.plan.id,
    });
    expect(hub.requests.length).toBe(before);
    expect(await w.states()).toEqual({ net: ["queued", null], app: ["queued", null] });
  });

  test("a project of GitLab's with the same number is not moved by it", async () => {
    const lab = (
      await createProject(t.db, {
        organizationId: org,
        name: `lab${++n}`,
        gitlabProjectId: repoId,
      })
    ).id;
    const gitlabs = await world({ projectId: lab });
    const hubs = await world();
    // the same workflow run id, claimed by both
    hub.setRun("acme", "svc", hubs.plan.id, { status: "in_progress" });
    hub.setJob("acme", "svc", hubs.plan.id, "plan:net", { status: "in_progress" });
    await attachRunPipeline(t.db, {
      organizationId: org,
      projectId: lab,
      runId: gitlabs.run.id,
      gitlabPipelineId: hubs.plan.id,
      action: "plan",
    });
    await jobEvent(hubs.plan.id, "plan:net", "in_progress");
    expect((await hubs.states()).net?.[0]).toBe("planning");
    expect(await gitlabs.states()).toEqual({ net: ["queued", null], app: ["queued", null] });
  });

  test("a run GitHub no longer has is dropped; a GitHub that is down fails the job so it is tried again", async () => {
    const w = await world();
    hub.inject({
      method: "GET",
      path: `/repos/acme/svc/actions/runs/${w.plan.id}`,
      status: 404,
      // one read by each of the two consumers; a leftover would answer the next test's read
      times: 2,
      body: { message: "Not Found" },
    });
    await runEvent(w.plan.id, "in_progress");
    expect(await w.states()).toEqual({ net: ["queued", null], app: ["queued", null] });

    hub.inject({
      method: "GET",
      path: `/repos/acme/svc/actions/runs/${w.plan.id}`,
      status: 502,
      times: 8,
      body: { message: "bad gateway" },
    });
    const rejected = await runEvent(w.plan.id, "in_progress").then(
      () => false,
      () => true,
    );
    expect(rejected).toBe(true);
  });

  test("a connection that is not there reads nothing", async () => {
    const before = hub.requests.length;
    const ghost = crypto.randomUUID();
    await consume({
      event: "workflow_run",
      organizationId: org,
      connectionId: ghost,
      projectId: repoId,
      pipelineId: 7,
    });
    expect(hub.requests.length).toBe(before);
  });
});

describe("a link is kept only for a stack that is applying", () => {
  test("a job held in GitHub while its stack is only planned leaves the stack with no link", async () => {
    const w = await world();
    for (const stack of ["net", "app"]) {
      await moveRunStack(t.db, org, project, w.run.id, stack, "queued", "planning");
      await moveRunStack(t.db, org, project, w.run.id, stack, "planning", "planned");
    }
    const apply = hub.addRun("acme", "svc", {
      status: "waiting",
      jobs: [{ name: "apply:net", status: "waiting" }],
    });
    await attachRunPipeline(t.db, {
      organizationId: org,
      projectId: project,
      runId: w.run.id,
      gitlabPipelineId: apply.id,
      action: "apply",
    });
    await jobEvent(apply.id, "apply:net", "waiting");
    expect(await w.states()).toEqual({ net: ["planned", null], app: ["planned", null] });
  });
});

describe("a page that is not a web page is not kept", () => {
  test("a job's page other than http(s) is dropped, so the stack waits with no link", async () => {
    const w = await world();
    const apply = hub.addRun("acme", "svc", {
      status: "waiting",
      jobs: [{ name: "apply:net", status: "waiting" }],
    });
    await attachRunPipeline(t.db, {
      organizationId: org,
      projectId: project,
      runId: w.run.id,
      gitlabPipelineId: apply.id,
      action: "apply",
    });
    await moveRunStack(t.db, org, project, w.run.id, "net", "queued", "planning");
    await moveRunStack(t.db, org, project, w.run.id, "net", "planning", "planned");
    await moveRunStack(t.db, org, project, w.run.id, "net", "planned", "applying");
    hub.inject({
      method: "GET",
      path: `/repos/acme/svc/actions/runs/${apply.id}/jobs`,
      status: 200,
      times: 4,
      body: {
        total_count: 1,
        jobs: [
          {
            id: 99,
            name: "apply:net",
            status: "waiting",
            conclusion: null,
            html_url: "javascript:alert(document.cookie)",
            run_id: apply.id,
          },
        ],
      },
    });
    await jobEvent(apply.id, "apply:net", "waiting");
    expect((await w.states()).net).toEqual(["applying", null]);
    // one stack of a project is applying at a time; let the next test have it
    await moveRunStack(t.db, org, project, w.run.id, "net", "applying", "failed", "test over");
  });

  test("a page too long for the column is dropped too, and the event is still handled", async () => {
    const w = await world();
    const apply = hub.addRun("acme", "svc", {
      status: "waiting",
      jobs: [{ name: "apply:net", status: "waiting" }],
    });
    await attachRunPipeline(t.db, {
      organizationId: org,
      projectId: project,
      runId: w.run.id,
      gitlabPipelineId: apply.id,
      action: "apply",
    });
    await moveRunStack(t.db, org, project, w.run.id, "net", "queued", "planning");
    await moveRunStack(t.db, org, project, w.run.id, "net", "planning", "planned");
    await moveRunStack(t.db, org, project, w.run.id, "net", "planned", "applying");
    hub.inject({
      method: "GET",
      path: `/repos/acme/svc/actions/runs/${apply.id}/jobs`,
      status: 200,
      times: 4,
      body: {
        total_count: 1,
        jobs: [
          {
            id: 98,
            name: "apply:net",
            status: "waiting",
            conclusion: null,
            html_url: `https://github.example/${"a".repeat(2000)}`,
            run_id: apply.id,
          },
        ],
      },
    });
    await jobEvent(apply.id, "apply:net", "waiting");
    expect((await w.states()).net).toEqual(["applying", null]);
  });
});

describe("a finished run on GitHub has no secret report to read", () => {
  test("a job that carries GitLab's scan name is not asked for an artifact", async () => {
    const w = await world();
    hub.setRun("acme", "svc", w.plan.id, { status: "completed", conclusion: "success" });
    for (const name of ["plan:net", "plan:app", "secret_detection"]) {
      hub.setJob("acme", "svc", w.plan.id, name, { status: "completed", conclusion: "success" });
    }
    // rejects if the GitLab-only ingest is reached: a GitHub client has no artifacts to give
    await runEvent(w.plan.id, "completed", "success");
    expect(await w.states()).toEqual({ net: ["planned", null], app: ["planned", null] });
  });
});

describe("what is kept", () => {
  test("no row, response or log line holds the token, the webhook secret or a signature", async () => {
    const rows = JSON.stringify([
      await t.db.select().from(pipelineRuns),
      await t.db.select().from(runStacks),
      await allJobs(),
    ]);
    const haystack = JSON.stringify([rows, lines, responses]);
    expect(signatures.length).toBeGreaterThan(5);
    for (const needle of [TOKEN, SECRET, ...signatures]) expect(haystack).not.toContain(needle);
  });
});
