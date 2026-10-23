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
  createSink,
  deleteConnection,
  deployments,
  jobs,
  listDeployments,
  NOTIFY_QUEUE,
  projects,
  recordDeployment,
  savePipelineConfig,
  setEnvironmentProtection,
  setSubscriptions,
  upsertUser,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab, type Gitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { deploymentEventHandler } from "./deployments";
import { workerGitlab } from "./pipeline-runs";
import { hashToken, randomToken } from "./tokens";
import type { JobContext, JobHandler } from "./worker";

// DEP-4: a deployment event only says that a deployment changed; the job asks GitLab and stores the answer.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const SHA = "a".repeat(40);
const MOCK_PEOPLE = ["Mock Deployer", "mock-deployer", "mock commit title", "mock@example.test"];

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let conn1: string;
let handler: JobHandler;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();
const reporterOn: Record<string, "reporter"> = {};
const developerOn: Record<string, "developer"> = {};
const maintainerOn: Record<string, "maintainer"> = {};
const people = {} as Record<
  "alice" | "bob" | "carol" | "dave" | "erin" | "frank",
  { cookie: string }
>;
type Who = keyof typeof people;
const lines: string[] = [];
const seen: string[] = [];
const asked: [string, string][] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  conn1 = (
    await createConnection(t.db, keys, {
      organizationId: o1,
      type: "gitlab",
      name: "live",
      config: { baseUrl: mock.url },
      token: mock.token,
    })
  ).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob", "carol", "dave", "erin", "frank"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [o1]: "admin", [o2]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(902, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob
  roleTable.set(903, { orgRoles: {}, projectRoles: reporterOn }); // carol
  roleTable.set(904, { orgRoles: {}, projectRoles: maintainerOn }); // dave
  // erin: nothing
  roleTable.set(906, { orgRoles: {}, projectRoles: developerOn }); // frank
  app = makeApp(keys);
  handler = deploymentEventHandler({
    db: t.db,
    gitlab: async (org, connection) => {
      asked.push([org, connection]);
      return client();
    },
  });
});
const makeApp = (provider: typeof keys | undefined) =>
  createApp({
    logger,
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys: provider,
  });
let app: ReturnType<typeof makeApp>;

async function call(who: Who | null, method: string, path: string, a = app, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await a.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  seen.push(text);
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const auditRows = (action: string, org = o1) =>
  t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, org)))
    .orderBy(auditEvents.at);

afterAll(async () => {
  mock.stop();
  await t.drop();
});

const client = () =>
  createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });

/** A job as the webhook receiver queues it for a deployment event. */
const job = (payload: Record<string, unknown>): JobContext => ({
  id: "job",
  queue: WEBHOOK_QUEUE,
  payload,
  attempt: 1,
  maxAttempts: 5,
  log: logger,
  signal: new AbortController().signal,
});

let n = 0;
async function world(org = o1) {
  const id = ++n;
  // a branch with a pipeline definition, which GitLab needs to start a pipeline on it
  const gl = mock.addProject({
    path: `fx/d${id}`,
    files: { ".gitlab-ci.yml": "deploy:\n  script: [echo deploy]\n" },
  });
  const project = await createProject(t.db, {
    organizationId: org,
    name: `d${id}`,
    gitlabProjectId: gl.id,
  });
  reporterOn[project.id] = "reporter";
  developerOn[project.id] = "developer";
  maintainerOn[project.id] = "maintainer";
  /** What setting up the pipeline from the platform leaves: the connection this project's GitLab calls use. */
  const configure = (organizationId = org) =>
    savePipelineConfig(t.db, {
      organizationId,
      projectId: project.id,
      connectionId: conn1,
      template: "docker-build",
      version: "1.0.0",
      renderedHash: "0".repeat(64),
    });
  /** A deployment in GitLab, as a job with `environment:` makes one. */
  const jobId = 4000 + id;
  const pipelineId = 3000 + id;
  const deploy = (environment = "staging", status = "running") =>
    mock.addDeployment(gl.path, {
      environment,
      sha: SHA,
      status,
      job: jobId,
      pipeline: pipelineId,
    });
  const event = (deploymentId: number, over: Record<string, unknown> = {}) => ({
    event: "deployment",
    organizationId: org,
    connectionId: conn1,
    projectId: gl.id,
    deploymentId,
    status: "running",
    environment: "staging",
    ...over,
  });
  const stored = () => listDeployments(t.db, org, project.id, { limit: 50 });
  return {
    gl,
    project,
    jobId,
    pipelineId,
    deploy,
    event,
    stored,
    configure,
    base: `/organizations/${org}/projects/${project.id}`,
  };
}

describe("a deployment event", () => {
  test("stores the deployment as GitLab has it, not as the event said, read with the event's connection", async () => {
    const w = await world();
    const d = w.deploy("staging", "running");
    asked.length = 0;
    await handler(job(w.event(d, { status: "failed", environment: "somewhere-else" })));
    expect(asked).toEqual([[o1, conn1]]);
    const [row] = await w.stored();
    expect(row).toMatchObject({
      gitlabDeploymentId: d,
      environment: "staging",
      status: "running",
      sha: SHA,
      ref: "main",
      jobId: w.jobId,
      pipelineId: w.pipelineId,
      connectionId: conn1,
      finishedAt: null,
    });
  });

  test("keeps no user and no commit text: not in the row, not in the logs", async () => {
    const w = await world();
    await handler(job(w.event(w.deploy("staging", "success"))));
    const text = JSON.stringify(await w.stored()) + lines.join("\n");
    for (const word of MOCK_PEOPLE) expect(text).not.toContain(word);
  });

  test("a repeated event is one row; a later status is the same row, finished", async () => {
    const w = await world();
    const d = w.deploy();
    for (let i = 0; i < 3; i++) await handler(job(w.event(d)));
    const [first] = await w.stored();
    expect(await w.stored()).toHaveLength(1);
    mock.setDeploymentStatus(d, "success");
    await Bun.sleep(5); // the database's clock keeps milliseconds: the second read must begin after the first one's
    await handler(job(w.event(d)));
    const rows = await w.stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first?.id, status: "success" });
    expect(rows[0]?.finishedAt).toBeInstanceOf(Date);
  });

  test("an event that comes late reads the present: a deployment that failed is not shown running", async () => {
    const w = await world();
    const d = w.deploy();
    mock.setDeploymentStatus(d, "failed");
    await handler(job(w.event(d, { status: "running" }))); // the event is old; GitLab's answer is not
    expect((await w.stored())[0]?.status).toBe("failed");
  });

  let ticks = 0;
  test.each([
    ["a clock that ticks", () => new Date(Date.UTC(2026, 0, 1) + 1000 * ++ticks)],
    ["the database's clock", undefined],
  ])(
    "a read that began earlier cannot overwrite a later one, whatever order they finish in (%s)",
    async (_, now) => {
      const w = await world();
      const d = w.deploy();
      const real = client();
      let release = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let read = () => {};
      const readIt = new Promise<void>((r) => {
        read = r;
      });
      const slow = {
        ...real,
        deployments: {
          ...real.deployments,
          get: async (...a: Parameters<Gitlab["deployments"]["get"]>) => {
            const answer = await real.deployments.get(...a);
            read();
            await gate; // this read has the old answer and is slow to store it
            return answer;
          },
        },
      } as Gitlab;
      const first = deploymentEventHandler({ db: t.db, gitlab: async () => slow, now });
      const second = deploymentEventHandler({ db: t.db, gitlab: async () => real, now });

      const late = first(job(w.event(d))); // reads `running`, begun first
      await readIt;
      mock.setDeploymentStatus(d, "success");
      await Bun.sleep(5);
      await second(job(w.event(d))); // begun later, reads `success`, stored first
      release();
      await late; // its older answer arrives last and is dropped
      expect((await w.stored()).map((r) => r.status)).toEqual(["success"]);
    },
  );

  test("a deployment GitLab no longer has drops the job without an error and stores nothing", async () => {
    const w = await world();
    await handler(job(w.event(9_999_999)));
    expect(await w.stored()).toEqual([]);
  });

  test("an event for a project the platform does not know is dropped without asking GitLab", async () => {
    const w = await world();
    const d = w.deploy();
    mock.requests.splice(0);
    await handler(job(w.event(d, { projectId: 424_242 })));
    expect(mock.requests).toEqual([]);
    expect(await w.stored()).toEqual([]);
  });

  test("an event cannot reach a project of another organization", async () => {
    const w = await world();
    const d = w.deploy();
    mock.requests.splice(0);
    await handler(job(w.event(d, { organizationId: o2 })));
    expect(mock.requests).toEqual([]);
    expect(await w.stored()).toEqual([]);
  });

  test.each([
    ["a pipeline event", { event: "pipeline" }],
    ["no deployment id", { deploymentId: undefined }],
    ["a deployment id that is not a number", { deploymentId: "7" }],
    ["a connection that is not an id", { connectionId: "x" }],
  ])("%s is not a deployment event", async (_, over) => {
    const w = await world();
    const d = w.deploy();
    mock.requests.splice(0);
    await handler(job(w.event(d, over)));
    expect(mock.requests).toEqual([]);
    expect(await w.stored()).toEqual([]);
  });

  test("any other failure fails the job so the queue retries it", async () => {
    const w = await world();
    const d = w.deploy();
    mock.inject({ method: "GET", path: /\/deployments\/\d+$/, status: 500, times: 1 });
    await expect(handler(job(w.event(d)))).rejects.toThrow();
    expect(await w.stored()).toEqual([]);
    await handler(job(w.event(d))); // and the retry works
    expect(await w.stored()).toHaveLength(1);
  });

  test.each([401, 403])(
    "GitLab refusing the token (%d) drops the event, which no retry would serve",
    async (status) => {
      const w = await world();
      const d = w.deploy();
      mock.inject({ method: "GET", path: /\/deployments\/\d+$/, status, times: 1 });
      await handler(job(w.event(d)));
      expect(await w.stored()).toEqual([]);
    },
  );

  describe("with the connection opened as the worker opens it", () => {
    const opened = (provider: typeof keys | undefined) =>
      deploymentEventHandler({
        db: t.db,
        gitlab: workerGitlab({ db: t.db, keys: provider, logger }),
      });

    test("the deployment is read with the connection's own token", async () => {
      const w = await world();
      const d = w.deploy();
      await opened(keys)(job(w.event(d)));
      expect((await w.stored())[0]?.connectionId).toBe(conn1);
    });

    test("a connection that is gone, or is not GitLab's, drops the event", async () => {
      const w = await world();
      const d = w.deploy();
      const gone = await createConnection(t.db, keys, {
        organizationId: o1,
        type: "gitlab",
        name: "gone",
        config: { baseUrl: mock.url },
        token: mock.token,
      });
      await deleteConnection(t.db, o1, gone.id);
      const other = await createConnection(t.db, keys, {
        organizationId: o1,
        type: "other",
        name: "other",
        token: "something-else-0123456789",
      });
      mock.requests.splice(0);
      for (const connectionId of [gone.id, other.id, "00000000-0000-4000-8000-000000000000"]) {
        await opened(keys)(job(w.event(d, { connectionId })));
      }
      expect(await w.stored()).toEqual([]);
      expect(mock.requests).toEqual([]);
    });

    test("a worker without the master key fails the job, so it waits for one", async () => {
      const w = await world();
      const d = w.deploy();
      await expect(opened(undefined)(job(w.event(d)))).rejects.toThrow();
      expect(await w.stored()).toEqual([]);
    });
  });
});

describe("the receiver feeds the handler", () => {
  test("a Deployment Hook becomes a job the handler can use, and neither carries the user or the commit", async () => {
    const w = await world();
    const d = w.deploy("production", "success");
    const issued = await app.handle(
      new Request(`http://localhost/organizations/${o1}/connections/${conn1}/webhook-secret`, {
        method: "POST",
        headers: { cookie: people.alice.cookie },
      }),
    );
    const { secret } = (await issued.json()) as { secret: string };
    const body = {
      object_kind: "deployment",
      status: "success",
      deployment_id: d,
      environment: "production",
      project: { id: w.gl.id },
      user: { username: "do-not-queue-this" },
      commit_title: "do-not-queue-this-either",
    };
    const res = await app.handle(
      new Request(`http://localhost/webhooks/gitlab/${conn1}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-token": secret,
          "x-gitlab-event": "Deployment Hook",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(await res.json()).toEqual({ status: "queued" });
    const queued = (await t.db.select().from(jobs).where(eq(jobs.queue, WEBHOOK_QUEUE))).filter(
      (j) => j.payload.deploymentId === d,
    );
    expect(queued).toHaveLength(1);
    expect(JSON.stringify(queued[0]?.payload)).not.toContain("do-not-queue-this");
    await handler(job(queued[0]?.payload ?? {}));
    const [row] = await w.stored();
    expect(row).toMatchObject({
      gitlabDeploymentId: d,
      environment: "production",
      status: "success",
    });
    expect(JSON.stringify(row)).not.toContain("do-not-queue-this");
  });
});

const refresh = (base: string, who: Who | null = "alice", a = app) =>
  call(who, "POST", `${base}/deployments/refresh`, a);

describe("refreshing a project's deployments", () => {
  test("the first refresh fills the table with what GitLab has; the second records the same and changes none", async () => {
    const w = await world();
    await w.configure();
    w.deploy("staging", "success");
    w.deploy("production", "failed");
    w.deploy("staging", "running");
    const first = await refresh(w.base);
    expect([first.status, first.json]).toEqual([200, { recorded: 3 }]);
    const filled = await w.stored();
    expect(filled.map((r) => [r.environment, r.status])).toEqual([
      ["staging", "running"],
      ["production", "failed"],
      ["staging", "success"],
    ]);
    await Bun.sleep(5);
    expect((await refresh(w.base)).json).toEqual({ recorded: 3 });
    const again = await w.stored();
    expect(again.map((r) => [r.id, r.gitlabDeploymentId, r.environment, r.status, r.sha])).toEqual(
      filled.map((r) => [r.id, r.gitlabDeploymentId, r.environment, r.status, r.sha]),
    );
  });

  test("a refresh follows what GitLab says now: a running deployment that finished is finished here", async () => {
    const w = await world();
    await w.configure();
    const d = w.deploy("staging", "running");
    await refresh(w.base);
    mock.setDeploymentStatus(d, "success");
    await Bun.sleep(5);
    await refresh(w.base);
    expect((await w.stored()).map((r) => r.status)).toEqual(["success"]);
  });

  test("reads the newest hundred, and says how many it recorded", async () => {
    const w = await world();
    await w.configure();
    const ids = Array.from({ length: 105 }, () => w.deploy("staging", "success"));
    expect((await refresh(w.base)).json).toEqual({ recorded: 100 });
    const have = new Set((await w.stored()).map((r) => r.gitlabDeploymentId));
    expect(have.size).toBe(50); // `stored()` lists fifty at most
    expect(have.has(ids[104] as number)).toBe(true);
  });

  test("a project with a deployment but no pipeline setup uses the connection that deployment was read with", async () => {
    const w = await world();
    const d = w.deploy("staging", "success");
    await handler(job(w.event(d)));
    w.deploy("production", "success");
    expect((await refresh(w.base)).json).toEqual({ recorded: 2 });
  });

  test("a project the platform knows no connection for is told so, and GitLab is not asked", async () => {
    const w = await world();
    w.deploy();
    mock.requests.splice(0);
    const res = await refresh(w.base);
    expect([res.status, res.json.code]).toEqual([409, "no_connection"]);
    expect(mock.requests).toEqual([]);
  });

  test("one audit event holds the count and no deployment", async () => {
    const w = await world();
    await w.configure();
    w.deploy("staging", "success");
    await refresh(w.base);
    const [event] = (await auditRows("deployment.refresh")).filter(
      (e) => e.projectId === w.project.id,
    );
    expect(event).toMatchObject({ resourceType: "project", resourceId: w.project.id });
    expect(event?.metadata).toEqual({ recorded: 1 });
    expect(JSON.stringify(event)).not.toContain(SHA);
  });

  test("who may: a maintainer and an organization admin; not a developer, a reporter or a member; a stranger sees nothing", async () => {
    const w = await world();
    await w.configure();
    w.deploy();
    mock.requests.splice(0);
    for (const [who, status] of [
      ["bob", 403], // an organization member reads but does not refresh
      ["carol", 403], // a project reporter likewise
      ["frank", 403], // a developer likewise
      ["erin", 404],
      [null, 401],
    ] as const) {
      expect([who, (await refresh(w.base, who)).status]).toEqual([who, status]);
    }
    // refused before anything is sent to GitLab, and nothing is written or audited
    expect(mock.requests).toEqual([]);
    expect(await w.stored()).toEqual([]);
    expect(
      (await auditRows("deployment.refresh")).filter((e) => e.projectId === w.project.id),
    ).toEqual([]);
    expect((await refresh(w.base, "dave")).status).toBe(200);
    expect((await refresh(w.base, "alice")).status).toBe(200);
  });

  test("not another organization's project", async () => {
    const w = await world();
    await w.configure();
    const res = await call(
      "alice",
      "POST",
      `/organizations/${o2}/projects/${w.project.id}/deployments/refresh`,
    );
    expect(res.status).toBe(404);
  });

  test("not for a project that is not from GitLab", async () => {
    const project = await createProject(t.db, { organizationId: o1, name: `bare${++n}` });
    maintainerOn[project.id] = "maintainer";
    const res = await refresh(`/organizations/${o1}/projects/${project.id}`);
    expect([res.status, res.json.code]).toEqual([422, "not_linked"]);
  });

  test("needs the master key, as every use of a connection's token does", async () => {
    const w = await world();
    await w.configure();
    mock.requests.splice(0);
    const res = await refresh(w.base, "alice", makeApp(undefined));
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect(mock.requests).toEqual([]);
  });

  test("GitLab failing is a 502, and nothing is written or audited", async () => {
    const w = await world();
    await w.configure();
    w.deploy();
    mock.inject({ method: "GET", path: /\/deployments$/, status: 500, times: 2 });
    const res = await refresh(w.base);
    expect([res.status, res.json.code]).toEqual([502, "gitlab_failed"]);
    expect(await w.stored()).toEqual([]);
    expect(
      (await auditRows("deployment.refresh")).filter((e) => e.projectId === w.project.id),
    ).toEqual([]);
  });

  test.each([403, 400])("GitLab refusing (%d) is a 422 of its own", async (status) => {
    const w = await world();
    await w.configure();
    mock.inject({ method: "GET", path: /\/deployments$/, status, times: 1 });
    const res = await refresh(w.base);
    expect([res.status, res.json.code]).toEqual([422, "gitlab_refused"]);
  });

  test("a project GitLab no longer has says so", async () => {
    const w = await world();
    await w.configure();
    mock.inject({ method: "GET", path: /\/deployments$/, status: 404, times: 1 });
    const res = await refresh(w.base);
    expect([res.status, res.json.code]).toEqual([422, "gitlab_not_found"]);
  });
});

const DEPLOYMENT_KEYS = [
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
].sort();

describe("what is where, and the history", () => {
  type Row = { gitlabDeploymentId: number };
  type Environment = { slug: string; current: Row | null; lastAttempt: Row | null };
  /** A deployment as the worker would have stored it, with the columns an answer must not repeat. */
  async function put(
    w: Awaited<ReturnType<typeof world>>,
    id: number,
    environment: string,
    status: string,
    sha = SHA,
  ) {
    await recordDeployment(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      connectionId: conn1,
      gitlabDeploymentId: id,
      environment,
      sha,
      ref: "main",
      status,
      jobId: 7,
      pipelineId: 8,
      finishedAt: status === "running" ? null : new Date(Date.UTC(2026, 0, 2)),
      observedAt: new Date(Date.UTC(2026, 0, 3)),
    });
  }
  const environment = (w: Awaited<ReturnType<typeof world>>, slug: string, sortOrder = 0) =>
    createEnvironment(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      name: slug.toUpperCase(),
      slug,
      sortOrder,
    });
  const history = (w: Awaited<ReturnType<typeof world>>, query = "", who: Who | null = "alice") =>
    call(who, "GET", `${w.base}/deployments${query}`);
  const where = (w: Awaited<ReturnType<typeof world>>, who: Who | null = "alice") =>
    call(who, "GET", `${w.base}/deployments/environments`);

  test("each environment in sort order with its current build and its last attempt: a newer failure sits beside an older success", async () => {
    const w = await world();
    await environment(w, "staging", 1);
    await environment(w, "production", 2);
    await environment(w, "qa", 0);
    await put(w, 101, "staging", "success", "a".repeat(40));
    await put(w, 103, "staging", "failed", "b".repeat(40));
    await put(w, 102, "production", "failed", "c".repeat(40));
    const res = await where(w);
    expect(res.status).toBe(200);
    const rows = res.json.environments as Environment[];
    expect(rows.map((r) => r.slug)).toEqual(["qa", "staging", "production"]);
    expect(rows[0]).toMatchObject({
      name: "QA",
      protected: false,
      current: null,
      lastAttempt: null,
    });
    expect(rows[1]?.current).toMatchObject({
      gitlabDeploymentId: 101,
      status: "success",
      sha: "a".repeat(40),
    });
    expect(rows[1]?.lastAttempt).toMatchObject({
      gitlabDeploymentId: 103,
      status: "failed",
      sha: "b".repeat(40),
    });
    // only failures there: nothing is current
    expect(rows[2]).toMatchObject({ current: null });
    expect(rows[2]?.lastAttempt).toMatchObject({ gitlabDeploymentId: 102 });
    expect(res.json.unmatched).toEqual([]);
  });

  test("rollbackTo is the build a rollback would go to: the newest other one that succeeded there; none when there is none", async () => {
    const w = await world();
    await environment(w, "qa", 0);
    await environment(w, "staging", 1);
    await environment(w, "production", 2);
    await environment(w, "preview", 3);
    const [a, b, c] = [BUILD("a"), BUILD("b"), BUILD("c")] as [string, string, string];
    await put(w, 1, "staging", "success", a);
    await put(w, 2, "staging", "failed", b);
    await put(w, 3, "staging", "success", c);
    await put(w, 4, "staging", "success", c); // a redeploy of the current build is not a way back
    await put(w, 5, "production", "success", a); // one build only
    await put(w, 6, "preview", "failed", b); // nothing current
    await put(w, 7, "qa", "success", c); // another environment's history is not production's
    await put(w, 8, "production", "failed", c);
    const rows = (await where(w)).json.environments as {
      slug: string;
      rollbackTo: string | null;
    }[];
    expect(rows.map((r) => [r.slug, r.rollbackTo])).toEqual([
      ["qa", null],
      ["staging", a],
      ["production", null],
      ["preview", null],
    ]);
  });

  test("a GitLab environment the platform does not have is listed once, by name, and with nothing of it", async () => {
    const w = await world();
    await environment(w, "staging");
    await put(w, 1, "staging", "success");
    await put(w, 2, "legacy-prod", "success");
    await put(w, 3, "legacy-prod", "failed");
    await put(w, 4, "Another", "success");
    const res = await where(w);
    expect(res.json.unmatched).toEqual(["Another", "legacy-prod"]);
    expect(res.json.environments).toHaveLength(1);
    expect(JSON.stringify(res.json.environments)).not.toContain("legacy-prod");
  });

  test("the answers hold exactly the allow-listed keys, over a stored row that has more", async () => {
    const w = await world();
    await environment(w, "staging");
    await put(w, 1, "staging", "success");
    const list = (await history(w)).json.deployments[0];
    expect(Object.keys(list).sort()).toEqual(DEPLOYMENT_KEYS);
    const [env] = (await where(w)).json.environments;
    expect(Object.keys(env).sort()).toEqual(
      ["current", "id", "lastAttempt", "name", "protected", "rollbackTo", "slug"].sort(),
    );
    expect(Object.keys(env.current).sort()).toEqual(DEPLOYMENT_KEYS);
    expect(Object.keys(env.lastAttempt).sort()).toEqual(DEPLOYMENT_KEYS);
    expect(list).toMatchObject({
      jobId: 7,
      pipelineId: 8,
      finishedAt: "2026-01-02T00:00:00.000Z",
      observedAt: "2026-01-03T00:00:00.000Z",
    });
  });

  test("the history is newest first, a page at a time, and the cursor holds", async () => {
    const w = await world();
    for (const id of [1, 2, 3, 4, 5]) await put(w, id, "staging", "success");
    const first = await history(w, "?limit=2");
    expect(first.json.deployments.map((d: Row) => d.gitlabDeploymentId)).toEqual([5, 4]);
    expect(first.json.next).toBe(4);
    const second = await history(w, `?limit=2&before=${first.json.next}`);
    expect(second.json.deployments.map((d: Row) => d.gitlabDeploymentId)).toEqual([3, 2]);
    const last = await history(w, `?limit=2&before=${second.json.next}`);
    expect([last.json.deployments.map((d: Row) => d.gitlabDeploymentId), last.json.next]).toEqual([
      [1],
      null,
    ]);
    expect((await history(w)).json.deployments).toHaveLength(5); // twenty a page unless asked
  });

  test("by environment and by status", async () => {
    const w = await world();
    await put(w, 1, "staging", "success");
    await put(w, 2, "production", "failed");
    await put(w, 3, "staging", "failed");
    const ids = async (q: string) =>
      (await history(w, q)).json.deployments.map((d: Row) => d.gitlabDeploymentId);
    expect(await ids("?environment=staging")).toEqual([3, 1]);
    expect(await ids("?status=failed")).toEqual([3, 2]);
    expect(await ids("?environment=staging&status=failed")).toEqual([3]);
    expect(await ids("?environment=nowhere")).toEqual([]);
  });

  test("a limit above a hundred, or a status that is not a word, is refused", async () => {
    const w = await world();
    for (const q of ["?limit=101", "?limit=0", "?status=Not%20A%20Word", "?before=-1"]) {
      const res = await history(w, q);
      expect([q, res.status]).toEqual([q, 422]);
    }
  });

  test("who may read: an admin, an organization member, a project reporter, a developer and a maintainer; a stranger and no session may not", async () => {
    const w = await world();
    await put(w, 1, "staging", "success");
    for (const who of ["alice", "bob", "carol", "dave", "frank"] as const) {
      expect([who, (await history(w, "", who)).status]).toEqual([who, 200]);
      expect([who, (await where(w, who)).status]).toEqual([who, 200]);
    }
    expect([(await history(w, "", "erin")).status, (await where(w, "erin")).status]).toEqual([
      404, 404,
    ]);
    expect([(await history(w, "", null)).status, (await where(w, null)).status]).toEqual([
      401, 401,
    ]);
  });

  test("not another organization's project, and not one that is not there", async () => {
    const w = await world();
    await put(w, 1, "staging", "success");
    const none = "00000000-0000-4000-8000-000000000000";
    for (const path of [
      `/organizations/${o2}/projects/${w.project.id}/deployments`,
      `/organizations/${o2}/projects/${w.project.id}/deployments/environments`,
      `/organizations/${o1}/projects/${none}/deployments`,
      `/organizations/${o1}/projects/${none}/deployments/environments`,
    ]) {
      expect([path, (await call("alice", "GET", path)).status]).toEqual([path, 404]);
    }
  });

  test("reading asks GitLab for nothing", async () => {
    const w = await world();
    await put(w, 1, "staging", "success");
    mock.requests.splice(0);
    await history(w);
    await where(w);
    expect(mock.requests).toEqual([]);
  });
});

describe("what is kept out", () => {
  test("the connection's token and GitLab's user and commit text are in no response, no log and no audit row", async () => {
    const w = await world();
    await w.configure();
    w.deploy("staging", "success");
    await refresh(w.base);
    const rows = JSON.stringify(await t.db.select().from(auditEvents));
    expect(mock.token.length).toBeGreaterThan(10);
    for (const place of [seen.join("\n"), lines.join("\n"), rows]) {
      expect(place).not.toContain(mock.token);
      for (const word of MOCK_PEOPLE) expect(place).not.toContain(word);
    }
  });
});

// DEP-20: how often a project deploys, how often that fails and how long a failure lasts.

describe("the numbers", () => {
  const DAY = 86_400_000;
  const stats = (w: Awaited<ReturnType<typeof world>>, query = "", who: Who | null = "alice") =>
    call(who, "GET", `${w.base}/deployments/stats${query}`);
  type Numbers = {
    environment: string;
    deployments: number;
    failed: number;
    perWeek: number | null;
    failureRate: number | null;
    medianRestoreSeconds: number | null;
  };
  let id = 0;
  /** A deployment that finished `ago` milliseconds ago. */
  const finished = (
    w: Awaited<ReturnType<typeof world>>,
    environment: string,
    status: string,
    ago: number,
  ) => {
    const at = new Date(Date.now() - ago);
    return recordDeployment(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      connectionId: conn1,
      gitlabDeploymentId: ++id,
      environment,
      sha: SHA,
      ref: "main",
      status,
      jobId: 7,
      pipelineId: 8,
      finishedAt: at,
      observedAt: at,
    });
  };
  const environment = (w: Awaited<ReturnType<typeof world>>, slug: string, sortOrder: number) =>
    createEnvironment(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      name: slug,
      slug,
      sortOrder,
    });
  async function scene() {
    const w = await world();
    await environment(w, "production", 1);
    await environment(w, "staging", 0);
    await environment(w, "qa", 2);
    await finished(w, "staging", "success", 6 * DAY);
    await finished(w, "staging", "failed", 4 * DAY);
    await finished(w, "staging", "success", 4 * DAY - 600_000);
    await finished(w, "staging", "success", 2 * DAY);
    await finished(w, "production", "failed", DAY);
    await finished(w, "staging", "success", 40 * DAY); // outside the thirty days
    return w;
  }

  test("each environment in sort order with its count, per week, failure rate and median time to restore; one with nothing is nulls", async () => {
    const w = await scene();
    const res = await stats(w);
    expect(res.status).toBe(200);
    expect(res.json.days).toBe(30);
    const rows = res.json.environments as Numbers[];
    expect(rows.map((r) => r.environment)).toEqual(["staging", "production", "qa"]);
    expect(rows[0]).toMatchObject({
      deployments: 3,
      failed: 1,
      failureRate: 0.25,
      medianRestoreSeconds: 600,
    });
    expect(rows[0]?.perWeek).toBeCloseTo(3 / (30 / 7), 10);
    expect(rows[1]).toEqual({
      environment: "production",
      deployments: 0,
      failed: 1,
      perWeek: 0,
      failureRate: 1,
      medianRestoreSeconds: null,
    });
    expect(rows[2]).toEqual({
      environment: "qa",
      deployments: 0,
      failed: 0,
      perWeek: null,
      failureRate: null,
      medianRestoreSeconds: null,
    });
  });

  test("days sets the window and environment keeps one", async () => {
    const w = await scene();
    const staging = async (query: string) =>
      ((await stats(w, query)).json.environments as Numbers[]).find(
        (r) => r.environment === "staging",
      );
    expect(await staging("?days=7")).toMatchObject({ deployments: 3, failed: 1, perWeek: 3 });
    // five days back loses the success of six days ago
    expect(await staging("?days=5")).toMatchObject({ deployments: 2, failed: 1 });
    expect(await staging("?days=1")).toMatchObject({ deployments: 0, failed: 0, perWeek: null });
    const one = (await stats(w, "?environment=staging&days=365")).json.environments as Numbers[];
    expect(one.map((r) => [r.environment, r.deployments])).toEqual([["staging", 4]]);
    const unknown = (await stats(w, "?environment=nowhere")).json.environments as Numbers[];
    expect(unknown).toEqual([
      {
        environment: "nowhere",
        deployments: 0,
        failed: 0,
        perWeek: null,
        failureRate: null,
        medianRestoreSeconds: null,
      },
    ]);
  });

  test("a window of nothing, of more than a year or that is not a number is refused", async () => {
    const w = await world();
    for (const q of ["?days=0", "?days=366", "?days=-1", "?days=x", "?days=1.5", "?environment="]) {
      const res = await stats(w, q);
      expect([q, res.status]).toEqual([q, 422]);
    }
    expect((await stats(w, "?days=1")).status).toBe(200);
    expect((await stats(w, "?days=365")).status).toBe(200);
  });

  test("who may read: the same as the history; a stranger and no session may not, and not another organization's project", async () => {
    const w = await scene();
    for (const who of ["alice", "bob", "carol", "dave", "frank"] as const) {
      expect([who, (await stats(w, "", who)).status]).toEqual([who, 200]);
    }
    expect((await stats(w, "", "erin")).status).toBe(404);
    expect((await stats(w, "", null)).status).toBe(401);
    const path = `/organizations/${o2}/projects/${w.project.id}/deployments/stats`;
    expect((await call("alice", "GET", path)).status).toBe(404);
  });

  test("holds only counts, rates and times: no sha, no user, no commit text, and GitLab is not asked", async () => {
    const w = await scene();
    mock.requests.splice(0);
    const text = JSON.stringify((await stats(w)).json);
    expect(text).not.toContain(SHA);
    for (const word of MOCK_PEOPLE) expect(text).not.toContain(word);
    expect(mock.requests).toEqual([]);
  });
});

// DEP-19: a deployment that turns failed tells the project's subscribers, once.

describe("a deployment that failed", () => {
  /** A project whose sink hears of failed deployments, and the notifications queued for it. */
  async function listening() {
    const w = await world();
    await w.configure();
    const sink = await createSink(t.db, keys, {
      organizationId: o1,
      kind: "webhook",
      name: `s${++n}`,
      host: "hooks.example",
      secret: "sealed-by-the-test",
    });
    await setSubscriptions(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      sinkId: sink.id,
      events: ["deployment.failed"],
    });
    const told = async () =>
      (await t.db.select().from(jobs).where(eq(jobs.queue, NOTIFY_QUEUE)))
        .map((j) => j.payload as Record<string, unknown>)
        .filter((p) => p.projectId === w.project.id);
    return { ...w, told };
  }

  test("the hook tells once when a running deployment fails, with the environment, eight characters of the build and the pipeline's address", async () => {
    const w = await listening();
    const d = w.deploy("production", "running");
    await handler(job(w.event(d)));
    expect(await w.told()).toEqual([]);

    mock.setDeploymentStatus(d, "failed");
    await Bun.sleep(5);
    await handler(job(w.event(d)));
    await Bun.sleep(5);
    await handler(job(w.event(d)));
    const [one, ...more] = await w.told();
    expect(more).toEqual([]);
    expect(one).toMatchObject({
      event: "deployment.failed",
      projectName: w.project.name,
      environment: "production",
      sha: SHA.slice(0, 8),
    });
    expect(String(one?.pipelineUrl)).toEndWith(`/-/pipelines/${w.pipelineId}`);
  });

  test("a refresh tells of a failure it is the first to see, and the next refresh, or the hook, does not tell it again", async () => {
    const w = await listening();
    const d = w.deploy("production", "failed");
    expect((await refresh(w.base)).json).toEqual({ recorded: 1 });
    expect(await w.told()).toHaveLength(1);
    await Bun.sleep(5);
    await refresh(w.base);
    await Bun.sleep(5);
    await handler(job(w.event(d)));
    expect(await w.told()).toHaveLength(1);
  });

  test("one that succeeded tells nobody", async () => {
    const w = await listening();
    await handler(job(w.event(w.deploy("production", "success"))));
    await refresh(w.base);
    expect(await w.told()).toEqual([]);
  });

  test("what is queued holds no GitLab user, no commit text and no token", async () => {
    const w = await listening();
    await handler(job(w.event(w.deploy("production", "failed"))));
    const text = JSON.stringify(await w.told()) + lines.join("\n");
    expect(await w.told()).toHaveLength(1);
    for (const word of [...MOCK_PEOPLE, mock.token]) expect(text).not.toContain(word);
  });
});

// DEP-12: promoting a build starts a pipeline on the default branch that runs only the deploy.

const BUILD = (c: string) => c.repeat(40);

describe("promoting a build", () => {
  let gitlabDeploymentId = 9000;
  /** A project set up with docker-deploy, environments staging and production, and what GitLab told us of them. */
  async function ready(over: { template?: string } = {}) {
    const w = await world();
    await savePipelineConfig(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      connectionId: conn1,
      template: over.template ?? "docker-deploy",
      version: "1.0.0",
      renderedHash: "0".repeat(64),
    });
    const environments: Record<string, string> = {};
    for (const [sortOrder, slug] of ["staging", "production"].entries()) {
      environments[slug] = (
        await createEnvironment(t.db, {
          organizationId: o1,
          projectId: w.project.id,
          name: slug,
          slug,
          sortOrder,
        })
      ).id;
    }
    const record = (environment: string, status: string, sha: string) =>
      recordDeployment(t.db, {
        organizationId: o1,
        projectId: w.project.id,
        connectionId: conn1,
        gitlabDeploymentId: ++gitlabDeploymentId,
        environment,
        sha,
        ref: "main",
        status,
        jobId: null,
        pipelineId: null,
        finishedAt: new Date(),
        observedAt: new Date(),
      });
    await record("staging", "success", BUILD("b"));
    await record("production", "success", BUILD("a"));
    const promote = (body: unknown, who: Who | null = "dave", a = app, base = w.base) =>
      call(who, "POST", `${base}/deployments/promote`, a, body);
    /** The pipelines this mock was asked to start. */
    const started = () =>
      mock.requests.filter((r) => r.method === "POST" && /\/pipeline$/.test(r.path));
    return { ...w, environments, record, promote, started };
  }
  const promotions = (w: { project: { id: string } }) =>
    auditRows("deployment.promote").then((rows) =>
      rows.filter((e) => e.projectId === w.project.id),
    );

  test("a dry run answers the plan, asks GitLab nothing and starts nothing; its audit row says it was a dry run", async () => {
    const w = await ready();
    mock.requests.splice(0);
    const res = await w.promote({ environment: "production", sha: BUILD("b"), dryRun: true });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      dryRun: true,
      plan: {
        environment: "production",
        from: { sha: BUILD("a"), finishedAt: expect.any(String) },
        to: BUILD("b"),
        previous: BUILD("a"),
        defaultBranch: "main",
        protected: false,
        variables: ["ORCH_DEPLOY_ENV", "ORCH_DEPLOY_SHA", "ORCH_PREVIOUS_SHA"],
      },
      pipeline: null,
    });
    expect(mock.requests).toEqual([]);
    const [event] = await promotions(w);
    expect(event?.metadata).toEqual({
      environment: "production",
      sha: BUILD("b"),
      previous: BUILD("a"),
      pipelineId: null,
      dryRun: true,
    });
  });

  test("applying starts one pipeline on the default branch with exactly the three variables, answers 202 and audits once", async () => {
    const w = await ready();
    mock.requests.splice(0);
    const res = await w.promote({ environment: "production", sha: BUILD("b") });
    expect(res.status).toBe(202);
    expect(w.started()).toHaveLength(1);
    const { pipeline } = res.json;
    expect(pipeline).toEqual({ id: expect.any(Number), webUrl: expect.stringContaining("http") });
    expect(mock.pipelineVariables(pipeline.id)).toEqual([
      { key: "ORCH_DEPLOY_ENV", value: "production", type: "env_var" },
      { key: "ORCH_DEPLOY_SHA", value: BUILD("b"), type: "env_var" },
      { key: "ORCH_PREVIOUS_SHA", value: BUILD("a"), type: "env_var" },
    ]);
    expect(res.json.plan.variables).toEqual(mock.pipelineVariables(pipeline.id)?.map((v) => v.key));
    expect((await client().pipelines.get(w.gl.id, pipeline.id)).ref).toBe("main");
    const events = await promotions(w);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ resourceType: "project", resourceId: w.project.id });
    expect(events[0]?.metadata).toEqual({
      environment: "production",
      sha: BUILD("b"),
      previous: BUILD("a"),
      pipelineId: pipeline.id,
      dryRun: false,
    });
    // the deployment appears when GitLab says so, not when the request is made
    expect((await w.stored()).map((d) => d.status)).toEqual(["success", "success"]);
  });

  test("into an environment with nothing deployed there only two variables are sent", async () => {
    const w = await ready();
    await t.db.delete(deployments).where(eq(deployments.environment, "production"));
    const res = await w.promote({ environment: "production", sha: BUILD("b") });
    expect(res.status).toBe(202);
    expect(res.json.plan.previous).toBeNull();
    expect(mock.pipelineVariables(res.json.pipeline.id)?.map((v) => v.key)).toEqual([
      "ORCH_DEPLOY_ENV",
      "ORCH_DEPLOY_SHA",
    ]);
    expect((await promotions(w))[0]?.metadata).toMatchObject({ previous: null });
  });

  test("two requests in a row both start a pipeline: the table only knows what GitLab has reported", async () => {
    const w = await ready();
    mock.requests.splice(0);
    const first = await w.promote({ environment: "production", sha: BUILD("b") });
    const second = await w.promote({ environment: "production", sha: BUILD("b") });
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(first.json.pipeline.id).not.toBe(second.json.pipeline.id);
    expect(w.started()).toHaveLength(2);
    expect(await promotions(w)).toHaveLength(2);
  });

  test.each([
    [
      "an environment the project does not have",
      { environment: "legacy", sha: BUILD("b") },
      404,
      "not_found",
    ],
    [
      "a build that never succeeded",
      { environment: "production", sha: BUILD("e") },
      422,
      "unknown_build",
    ],
    [
      "the build that is already there",
      { environment: "production", sha: BUILD("a") },
      409,
      "already_deployed",
    ],
    ["a sha that is not 40 hex", { environment: "production", sha: "main" }, 400, "invalid_sha"],
    [
      "a value that is not a slug",
      { environment: "Production;id", sha: BUILD("b") },
      400,
      "invalid_environment",
    ],
  ])("refused before GitLab is asked, and nothing audited: %s", async (_, body, status, code) => {
    const w = await ready();
    mock.requests.splice(0);
    const res = await w.promote(body);
    expect([res.status, res.json.code]).toEqual([status, code]);
    const dry = await w.promote({ ...body, dryRun: true });
    expect([dry.status, dry.json.code]).toEqual([status, code]);
    expect(mock.requests).toEqual([]);
    expect(await promotions(w)).toEqual([]);
  });

  test("one still deploying and a pipeline that is not docker-deploy are refused", async () => {
    const w = await ready();
    mock.requests.splice(0);
    await w.record("staging", "running", BUILD("c"));
    const busy = await w.promote({ environment: "staging", sha: BUILD("a") });
    expect([busy.status, busy.json.code]).toEqual([409, "deployment_in_progress"]);

    const other = await ready({ template: "bun-app" });
    const wrong = await other.promote({ environment: "production", sha: BUILD("b") });
    expect([wrong.status, wrong.json.code]).toEqual([422, "no_deploy_pipeline"]);
    expect(mock.requests).toEqual([]);
    expect(await promotions(w)).toEqual([]);
    expect(await promotions(other)).toEqual([]);
  });

  test("a project that was not imported from GitLab is told so, a dry run too", async () => {
    const w = await ready();
    await t.db.update(projects).set({ gitlabProjectId: null }).where(eq(projects.id, w.project.id));
    for (const dryRun of [true, false]) {
      const res = await w.promote({ environment: "production", sha: BUILD("b"), dryRun });
      expect([dryRun, res.status, res.json.code]).toEqual([dryRun, 422, "not_linked"]);
    }
  });

  test("GitLab refusing is a 422 of its own, GitLab failing a 502, and neither is audited", async () => {
    const w = await ready();
    for (const [status, want, code] of [
      [400, 422, "gitlab_refused"],
      [403, 422, "gitlab_refused"],
      [500, 502, "gitlab_failed"],
    ] as const) {
      // a POST is not retried, so one injection is one request and none is left for the next test
      mock.inject({ method: "POST", path: /\/pipeline$/, status, times: 1 });
      const res = await w.promote({ environment: "production", sha: BUILD("b") });
      expect([status, res.status, res.json.code]).toEqual([status, want, code]);
    }
    expect(await promotions(w)).toEqual([]);
  });

  test("who may: a maintainer and an organization admin; not a developer, a reporter or a member; a stranger sees nothing", async () => {
    const w = await ready();
    mock.requests.splice(0);
    const body = { environment: "production", sha: BUILD("b") };
    for (const [who, status] of [
      ["bob", 403],
      ["carol", 403],
      ["frank", 403],
      ["erin", 404],
      [null, 401],
    ] as const) {
      expect([who, (await w.promote(body, who)).status]).toEqual([who, status]);
    }
    expect(mock.requests).toEqual([]);
    expect(await promotions(w)).toEqual([]);
    expect((await w.promote(body, "dave")).status).toBe(202);
    expect((await w.promote(body, "alice")).status).toBe(202);
  });

  test("not another organization's project", async () => {
    const w = await ready();
    const theirs = await world(o2);
    mock.requests.splice(0);
    const res = await w.promote(
      { environment: "production", sha: BUILD("b") },
      "alice",
      app,
      `/organizations/${o1}/projects/${theirs.project.id}`,
    );
    expect(res.status).toBe(404);
    expect(mock.requests).toEqual([]);
  });

  test("applying needs the master key, as every use of a connection's token does; the plan does not", async () => {
    const w = await ready();
    const keyless = makeApp(undefined);
    mock.requests.splice(0);
    const apply = await w.promote({ environment: "production", sha: BUILD("b") }, "dave", keyless);
    expect([apply.status, apply.json.code]).toEqual([503, "secrets_unavailable"]);
    const dry = await w.promote(
      { environment: "production", sha: BUILD("b"), dryRun: true },
      "dave",
      keyless,
    );
    expect(dry.status).toBe(200);
    expect(mock.requests).toEqual([]);
  });

  test("a body with a key it does not know, or without a sha, is refused", async () => {
    const w = await ready();
    mock.requests.splice(0);
    for (const body of [
      { environment: "production", sha: BUILD("b"), ref: "evil" },
      { environment: "production" },
      { sha: BUILD("b") },
      { environment: "production", sha: BUILD("b"), dryRun: "yes" },
      {},
    ]) {
      const res = await w.promote(body);
      expect([JSON.stringify(body), res.status >= 400 && res.status < 500]).toEqual([
        JSON.stringify(body),
        true,
      ]);
    }
    expect(w.started()).toEqual([]);
  });

  test("the answers, the audit rows and the logs hold ids, shas and names only: no token, no GitLab user, no commit text", async () => {
    const w = await ready();
    w.deploy("staging", "success"); // GitLab's own row, with its user and commit
    await w.promote({ environment: "production", sha: BUILD("b"), dryRun: true });
    const done = await w.promote({ environment: "production", sha: BUILD("b") });
    expect(Object.keys(done.json).sort()).toEqual(["dryRun", "pipeline", "plan"]);
    expect(Object.keys(done.json.plan).sort()).toEqual(
      ["defaultBranch", "environment", "from", "previous", "protected", "to", "variables"].sort(),
    );
    expect(Object.keys(done.json.pipeline).sort()).toEqual(["id", "webUrl"]);
    const rows = JSON.stringify(await promotions(w));
    for (const place of [seen.join("\n"), lines.join("\n"), rows]) {
      expect(place).not.toContain(mock.token);
      for (const word of MOCK_PEOPLE) expect(place).not.toContain(word);
    }
    const keys = (await promotions(w)).flatMap((e) => Object.keys(e.metadata ?? {}));
    expect(new Set(keys)).toEqual(
      new Set(["environment", "sha", "previous", "pipelineId", "dryRun"]),
    );
  });

  // DEP-17: a protected environment is entered with an approval that the start which uses it spends
  const protect = (
    w: { project: { id: string }; environments: Record<string, string> },
    slugs = ["production"],
  ) =>
    Promise.all(
      slugs.map((slug) =>
        setEnvironmentProtection(t.db, o1, w.project.id, w.environments[slug] as string, true),
      ),
    );
  const requestsOf = (
    w: { base: string; environments: Record<string, string> },
    slug = "production",
  ) => `${w.base}/environments/${w.environments[slug]}/change-requests`;
  /** A developer asks to deploy `sha` into `slug`. */
  async function ask(
    w: Parameters<typeof requestsOf>[0],
    sha: string,
    slug = "production",
    who: Who = "frank",
  ) {
    const res = await call(who, "POST", requestsOf(w, slug), app, { kind: "deploy", sha });
    expect([who, res.status]).toEqual([who, 201]);
    return res.json.id as string;
  }
  const decide = (
    w: Parameters<typeof requestsOf>[0],
    id: string,
    how: "approve" | "reject" = "approve",
    who: Who = "dave",
    slug = "production",
  ) => call(who, "POST", `${requestsOf(w, slug)}/${id}/${how}`);
  /** Asked by a developer and approved by a maintainer. */
  async function approved(w: Parameters<typeof requestsOf>[0], sha: string, slug = "production") {
    const id = await ask(w, sha, slug);
    expect((await decide(w, id, "approve", "dave", slug)).status).toBe(200);
    return id;
  }
  const stateOf = async (w: Parameters<typeof requestsOf>[0], id: string, slug = "production") =>
    (await call("alice", "GET", `${requestsOf(w, slug)}/${id}`)).json.status as string;

  describe("a protected environment", () => {
    test("without an approval a promotion is refused, GitLab is not asked and nothing is audited; a dry run still answers and says it is protected", async () => {
      const w = await ready();
      await protect(w);
      mock.requests.splice(0);
      const res = await w.promote({ environment: "production", sha: BUILD("b") });
      expect([res.status, res.json.code]).toEqual([409, "approval_required"]);
      expect(mock.requests).toEqual([]);
      expect(await promotions(w)).toEqual([]);

      const dry = await w.promote({ environment: "production", sha: BUILD("b"), dryRun: true });
      expect(dry.status).toBe(200);
      expect(dry.json.plan.protected).toBe(true);
      // the same build into the unprotected staging says the opposite
      const open = await w.promote({ environment: "staging", sha: BUILD("a"), dryRun: true });
      expect(open.json.plan.protected).toBe(false);
    });

    test("one approval starts one pipeline, is spent by it, and is named in the audit row; the next promotion needs a new one", async () => {
      const w = await ready();
      await protect(w);
      const id = await approved(w, BUILD("b"));
      mock.requests.splice(0);
      const res = await w.promote({ environment: "production", sha: BUILD("b") });
      expect(res.status).toBe(202);
      expect(w.started()).toHaveLength(1);
      expect(await stateOf(w, id)).toBe("applied");
      const [event] = await promotions(w);
      expect(event?.metadata).toEqual({
        environment: "production",
        sha: BUILD("b"),
        previous: BUILD("a"),
        pipelineId: res.json.pipeline.id,
        dryRun: false,
        changeRequestId: id,
      });

      const again = await w.promote({ environment: "production", sha: BUILD("b") });
      expect([again.status, again.json.code]).toEqual([409, "approval_required"]);
      expect(w.started()).toHaveLength(1);
    });

    test("a dry run does not spend the approval", async () => {
      const w = await ready();
      await protect(w);
      const id = await approved(w, BUILD("b"));
      expect(
        (await w.promote({ environment: "production", sha: BUILD("b"), dryRun: true })).status,
      ).toBe(200);
      expect(await stateOf(w, id)).toBe("approved");
      expect((await w.promote({ environment: "production", sha: BUILD("b") })).status).toBe(202);
    });

    test("an approval is for one build in one environment: another build's, another environment's, an unapproved, a rejected and one the author approved themselves do not let it through", async () => {
      const w = await ready();
      await protect(w, ["production", "staging"]);
      await w.record("staging", "success", BUILD("c"));
      mock.requests.splice(0);
      await approved(w, BUILD("c")); // another build
      await approved(w, BUILD("b"), "staging"); // another environment
      await ask(w, BUILD("b")); // not approved yet
      const no = await ask(w, BUILD("b"));
      expect((await decide(w, no, "reject")).status).toBe(200);
      // dave asks and approves his own: refused, so it stays open
      const own = await ask(w, BUILD("b"), "production", "dave");
      const self = await decide(w, own);
      expect([self.status, self.json.code]).toEqual([403, "self_approval"]);
      const res = await w.promote({ environment: "production", sha: BUILD("b") });
      expect([res.status, res.json.code]).toEqual([409, "approval_required"]);
      expect(
        mock.requests.filter((r) => r.method === "POST" && /\/pipeline$/.test(r.path)),
      ).toEqual([]);
    });

    test("an approval that GitLab's refusal or failure did not use is still there for the next try", async () => {
      const w = await ready();
      await protect(w);
      const id = await approved(w, BUILD("b"));
      for (const [status, want] of [
        [400, 422],
        [500, 502],
      ] as const) {
        mock.inject({ method: "POST", path: /\/pipeline$/, status, times: 1 });
        const res = await w.promote({ environment: "production", sha: BUILD("b") });
        expect([status, res.status]).toEqual([status, want]);
        expect(await stateOf(w, id)).toBe("approved");
      }
      expect(await promotions(w)).toEqual([]);
      expect((await w.promote({ environment: "production", sha: BUILD("b") })).status).toBe(202);
      expect(await stateOf(w, id)).toBe("applied");
    });

    test("two requests with one approval start one pipeline", async () => {
      const w = await ready();
      await protect(w);
      await approved(w, BUILD("b"));
      mock.requests.splice(0);
      const both = await Promise.all([
        w.promote({ environment: "production", sha: BUILD("b") }),
        w.promote({ environment: "production", sha: BUILD("b") }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
      expect(both.find((r) => r.status === 409)?.json.code).toBe("approval_required");
      expect(w.started()).toHaveLength(1);
      expect(await promotions(w)).toHaveLength(1);
    });

    test("an approval holds no more than the ids and the commit: no GitLab user, no commit text", async () => {
      const w = await ready();
      await protect(w);
      w.deploy("staging", "success");
      await approved(w, BUILD("b"));
      await w.promote({ environment: "production", sha: BUILD("b") });
      const place = [seen.join("\n"), lines.join("\n"), JSON.stringify(await promotions(w))];
      for (const text of place) {
        expect(text).not.toContain(mock.token);
        for (const word of MOCK_PEOPLE) expect(text).not.toContain(word);
      }
    });
  });

  // DEP-13: rolling back is a promotion of the build that was there before, to the same environment.
  describe("rolling back", () => {
    /** `ready()` with the route to roll back. */
    async function readyToRollBack(over: { template?: string } = {}) {
      const w = await ready(over);
      const rollback = (body: unknown, who: Who | null = "dave", a = app, base = w.base) =>
        call(who, "POST", `${base}/deployments/rollback`, a, body);
      return { ...w, rollback };
    }
    /** Production has had a, then a failed x, then b twice (the second a redeploy): the target is a. */
    async function history(over: { template?: string } = {}) {
      const w = await readyToRollBack(over);
      await w.record("production", "failed", BUILD("x"));
      await w.record("production", "success", BUILD("b"));
      await w.record("production", "success", BUILD("b"));
      return w;
    }
    const rollbacks = (w: { project: { id: string } }) =>
      auditRows("deployment.rollback").then((rows) =>
        rows.filter((e) => e.projectId === w.project.id),
      );

    test("a dry run names the target (skipping the failure and the redeploy), asks GitLab nothing and says so in its audit row", async () => {
      const w = await history();
      mock.requests.splice(0);
      const res = await w.rollback({ environment: "production", dryRun: true });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        dryRun: true,
        plan: {
          environment: "production",
          from: { sha: BUILD("b"), finishedAt: expect.any(String) },
          to: BUILD("a"),
          previous: BUILD("b"),
          defaultBranch: "main",
          protected: false,
          variables: ["ORCH_DEPLOY_ENV", "ORCH_DEPLOY_SHA", "ORCH_PREVIOUS_SHA"],
        },
        pipeline: null,
      });
      expect(mock.requests).toEqual([]);
      const [event] = await rollbacks(w);
      expect(event?.metadata).toEqual({
        environment: "production",
        sha: BUILD("a"),
        previous: BUILD("b"),
        pipelineId: null,
        dryRun: true,
      });
    });

    test("applying starts one pipeline that deploys the target and names the bad build as the previous one; the audit action is deployment.rollback and not deployment.promote", async () => {
      const w = await history();
      mock.requests.splice(0);
      const res = await w.rollback({ environment: "production" });
      expect(res.status).toBe(202);
      expect(w.started()).toHaveLength(1);
      expect(mock.pipelineVariables(res.json.pipeline.id)).toEqual([
        { key: "ORCH_DEPLOY_ENV", value: "production", type: "env_var" },
        { key: "ORCH_DEPLOY_SHA", value: BUILD("a"), type: "env_var" },
        { key: "ORCH_PREVIOUS_SHA", value: BUILD("b"), type: "env_var" },
      ]);
      expect((await client().pipelines.get(w.gl.id, res.json.pipeline.id)).ref).toBe("main");
      const events = await rollbacks(w);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ resourceType: "project", resourceId: w.project.id });
      expect(events[0]?.metadata).toEqual({
        environment: "production",
        sha: BUILD("a"),
        previous: BUILD("b"),
        pipelineId: res.json.pipeline.id,
        dryRun: false,
      });
      expect(await promotions(w)).toEqual([]);
    });

    test("only the environment's own history counts: what staging has had is not a way back for production", async () => {
      const w = await readyToRollBack();
      await w.record("staging", "success", BUILD("c"));
      mock.requests.splice(0);
      const res = await w.rollback({ environment: "production" });
      expect([res.status, res.json.code]).toEqual([409, "nothing_to_roll_back"]);
      expect(mock.requests).toEqual([]);
    });

    test("with nothing earlier to go back to it says so, a dry run too; nothing is asked of GitLab or audited", async () => {
      const w = await readyToRollBack(); // production has had one build, a
      const empty = await readyToRollBack();
      await t.db.delete(deployments).where(eq(deployments.projectId, empty.project.id));
      mock.requests.splice(0);
      for (const who of [w, empty]) {
        for (const dryRun of [false, true]) {
          const res = await who.rollback({ environment: "production", dryRun });
          expect([dryRun, res.status, res.json.code]).toEqual([
            dryRun,
            409,
            "nothing_to_roll_back",
          ]);
        }
      }
      expect(mock.requests).toEqual([]);
      expect(await rollbacks(w)).toEqual([]);
      expect(await rollbacks(empty)).toEqual([]);
    });

    test.each([
      ["an environment the project does not have", { environment: "legacy" }, 404, "not_found"],
      ["a value that is not a slug", { environment: "Production;id" }, 400, "invalid_environment"],
    ])("refused before GitLab is asked, and nothing audited: %s", async (_, body, status, code) => {
      const w = await history();
      mock.requests.splice(0);
      for (const dryRun of [false, true]) {
        const res = await w.rollback({ ...body, dryRun });
        expect([dryRun, res.status, res.json.code]).toEqual([dryRun, status, code]);
      }
      expect(mock.requests).toEqual([]);
      expect(await rollbacks(w)).toEqual([]);
    });

    test("one still deploying and a pipeline that is not docker-deploy are refused as a promotion's are", async () => {
      const w = await history();
      mock.requests.splice(0);
      await w.record("staging", "success", BUILD("c"));
      await w.record("staging", "running", BUILD("d"));
      const busy = await w.rollback({ environment: "staging" });
      expect([busy.status, busy.json.code]).toEqual([409, "deployment_in_progress"]);

      const other = await history({ template: "bun-app" });
      const wrong = await other.rollback({ environment: "production" });
      expect([wrong.status, wrong.json.code]).toEqual([422, "no_deploy_pipeline"]);
      expect(mock.requests).toEqual([]);
      expect(await rollbacks(w)).toEqual([]);
      expect(await rollbacks(other)).toEqual([]);
    });

    test("a project that was not imported from GitLab is told so, a dry run too", async () => {
      const w = await history();
      await t.db
        .update(projects)
        .set({ gitlabProjectId: null })
        .where(eq(projects.id, w.project.id));
      for (const dryRun of [true, false]) {
        const res = await w.rollback({ environment: "production", dryRun });
        expect([dryRun, res.status, res.json.code]).toEqual([dryRun, 422, "not_linked"]);
      }
    });

    test("GitLab refusing is a 422 of its own, GitLab failing a 502, and neither is audited", async () => {
      const w = await history();
      for (const [status, want, code] of [
        [400, 422, "gitlab_refused"],
        [403, 422, "gitlab_refused"],
        [500, 502, "gitlab_failed"],
      ] as const) {
        mock.inject({ method: "POST", path: /\/pipeline$/, status, times: 1 });
        const res = await w.rollback({ environment: "production" });
        expect([status, res.status, res.json.code]).toEqual([status, want, code]);
      }
      expect(await rollbacks(w)).toEqual([]);
    });

    test("who may: a maintainer and an organization admin; not a developer, a reporter or a member; a stranger sees nothing", async () => {
      const w = await history();
      mock.requests.splice(0);
      for (const [who, status] of [
        ["bob", 403],
        ["carol", 403],
        ["frank", 403],
        ["erin", 404],
        [null, 401],
      ] as const) {
        expect([who, (await w.rollback({ environment: "production" }, who)).status]).toEqual([
          who,
          status,
        ]);
      }
      expect(mock.requests).toEqual([]);
      expect(await rollbacks(w)).toEqual([]);
      expect((await w.rollback({ environment: "production" }, "dave")).status).toBe(202);
      expect((await w.rollback({ environment: "production" }, "alice")).status).toBe(202);
    });

    test("not another organization's project", async () => {
      const w = await history();
      const theirs = await world(o2);
      mock.requests.splice(0);
      const res = await w.rollback(
        { environment: "production" },
        "alice",
        app,
        `/organizations/${o1}/projects/${theirs.project.id}`,
      );
      expect(res.status).toBe(404);
      expect(mock.requests).toEqual([]);
    });

    test("applying needs the master key; the plan does not", async () => {
      const w = await history();
      const keyless = makeApp(undefined);
      mock.requests.splice(0);
      const apply = await w.rollback({ environment: "production" }, "dave", keyless);
      expect([apply.status, apply.json.code]).toEqual([503, "secrets_unavailable"]);
      const dry = await w.rollback({ environment: "production", dryRun: true }, "dave", keyless);
      expect(dry.status).toBe(200);
      expect(mock.requests).toEqual([]);
    });

    test("a body with a key it does not know (a sha is not one: the platform picks the build), or without an environment, is refused", async () => {
      const w = await history();
      mock.requests.splice(0);
      for (const body of [
        { environment: "production", sha: BUILD("a") },
        { environment: "production", ref: "evil" },
        { environment: "production", dryRun: "yes" },
        { dryRun: true },
        {},
      ]) {
        const res = await w.rollback(body);
        expect([JSON.stringify(body), res.status >= 400 && res.status < 500]).toEqual([
          JSON.stringify(body),
          true,
        ]);
      }
      expect(w.started()).toEqual([]);
    });

    test("the answers, the audit rows and the logs hold ids, shas and names only: no token, no GitLab user, no commit text", async () => {
      const w = await history();
      w.deploy("staging", "success"); // GitLab's own row, with its user and commit
      await w.rollback({ environment: "production", dryRun: true });
      const done = await w.rollback({ environment: "production" });
      expect(Object.keys(done.json).sort()).toEqual(["dryRun", "pipeline", "plan"]);
      expect(Object.keys(done.json.plan).sort()).toEqual(
        ["defaultBranch", "environment", "from", "previous", "protected", "to", "variables"].sort(),
      );
      expect(Object.keys(done.json.pipeline).sort()).toEqual(["id", "webUrl"]);
      const rows = JSON.stringify(await rollbacks(w));
      for (const place of [seen.join("\n"), lines.join("\n"), rows]) {
        expect(place).not.toContain(mock.token);
        for (const word of MOCK_PEOPLE) expect(place).not.toContain(word);
      }
      const keys = (await rollbacks(w)).flatMap((e) => Object.keys(e.metadata ?? {}));
      expect(new Set(keys)).toEqual(
        new Set(["environment", "sha", "previous", "pipelineId", "dryRun"]),
      );
    });

    test("a protected environment needs an approval for the build it would go back to, and spends it", async () => {
      const w = await history();
      await protect(w);
      mock.requests.splice(0);
      const none = await w.rollback({ environment: "production" });
      expect([none.status, none.json.code]).toEqual([409, "approval_required"]);
      // the build it is on now is not the one it would restore
      await approved(w, BUILD("b"));
      const wrong = await w.rollback({ environment: "production" });
      expect([wrong.status, wrong.json.code]).toEqual([409, "approval_required"]);
      expect(w.started()).toEqual([]);
      expect(
        (await w.rollback({ environment: "production", dryRun: true })).json.plan.protected,
      ).toBe(true);

      const id = await approved(w, BUILD("a"));
      const res = await w.rollback({ environment: "production" });
      expect(res.status).toBe(202);
      expect(w.started()).toHaveLength(1);
      expect(await stateOf(w, id)).toBe("applied");
      // the dry run above wrote the first row; the start wrote the last
      const event = (await rollbacks(w)).at(-1);
      expect(event?.metadata).toMatchObject({
        sha: BUILD("a"),
        changeRequestId: id,
        dryRun: false,
      });
      const again = await w.rollback({ environment: "production" });
      expect([again.status, again.json.code]).toEqual([409, "approval_required"]);
    });
  });
});
