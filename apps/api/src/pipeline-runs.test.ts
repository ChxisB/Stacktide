import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  createSession,
  deleteConnection,
  jobs,
  listPipelineRuns,
  type NewPipelineRun,
  type PipelineRun,
  recordPipelineRun,
  upsertUser,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab, type Gitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { pipelineEventHandler, workerGitlab } from "./pipeline-runs";
import { hashToken, randomToken } from "./tokens";
import type { JobContext, JobHandler } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const CI = "test:\n  script:\n    - echo hi\n";

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let conn1: string;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();
const reporterOn: Record<string, "reporter"> = {};
const maintainerOn: Record<string, "maintainer"> = {};
const people = {} as Record<"alice" | "bob" | "carol" | "dave" | "erin", { cookie: string }>;
type Who = keyof typeof people;
const lines: string[] = [];
const seen: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });

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
  for (const name of ["alice", "bob", "carol", "dave", "erin"] as const) {
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
  app = makeApp(keys);
  handler = pipelineEventHandler({
    db: t.db,
    gitlab: async (org, connection) => {
      asked.push([org, connection]);
      return client();
    },
  });
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

async function call(who: Who | null, method: string, path: string, a = app) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  const res = await a.handle(new Request(`http://localhost${path}`, { method, headers }));
  const text = await res.text();
  seen.push(text);
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const client = () =>
  createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });

/** A job as the webhook receiver queues it for a pipeline event. */
const job = (payload: Record<string, unknown>): JobContext => ({
  id: "job",
  queue: WEBHOOK_QUEUE,
  payload,
  attempt: 1,
  maxAttempts: 5,
  log: logger,
  signal: new AbortController().signal,
});

const asked: [string, string][] = [];
let handler: JobHandler;

let n = 0;
/** A project on a GitLab project of its own; `files` is what its repository holds. */
async function world(ci = CI, org = o1) {
  const id = ++n;
  const gl = mock.addProject({ path: `fx/r${id}`, files: { ".gitlab-ci.yml": ci } });
  const project = await createProject(t.db, {
    organizationId: org,
    name: `r${id}`,
    gitlabProjectId: gl.id,
  });
  reporterOn[project.id] = "reporter";
  maintainerOn[project.id] = "maintainer";
  const trigger = async (ref = "main") => (await client().pipelines.trigger(gl.id, ref)).id;
  const event = (pipelineId: number, over: Record<string, unknown> = {}) => ({
    event: "pipeline",
    organizationId: org,
    connectionId: conn1,
    projectId: gl.id,
    pipelineId,
    status: "pending",
    ref: "main",
    ...over,
  });
  const runs = () => listPipelineRuns(t.db, org, project.id, { limit: 50 });
  return {
    gl,
    project,
    trigger,
    event,
    runs,
    base: `/organizations/${org}/projects/${project.id}`,
  };
}

/** A pipeline that ran and failed, as the platform has it. */
async function failedRun(ci = CI) {
  const w = await world(ci);
  const p = await w.trigger();
  mock.finishPipeline(p, "failed");
  await handler(job(w.event(p)));
  const [run] = await w.runs();
  if (!run) throw new Error("no run was stored");
  return { ...w, p, run };
}

/** A stored run as `recordPipelineRun` takes it: the same columns, less the ones the database owns. */
const restate = (
  { id: _id, createdAt: _created, updatedAt: _updated, ...row }: PipelineRun,
  over: Partial<NewPipelineRun>,
): NewPipelineRun => ({ ...row, ...over });

const requestsTo = (re: RegExp) => mock.requests.filter((r) => re.test(r.path));
const auditRows = (action: string, org = o1) =>
  t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, org)))
    .orderBy(auditEvents.at);

describe("a pipeline event", () => {
  test("stores the pipeline as GitLab has it, read with the event's connection", async () => {
    const w = await world();
    const p = await w.trigger();
    asked.length = 0;
    await handler(job(w.event(p, { status: "this is not what is stored" })));
    expect(asked).toEqual([[o1, conn1]]);
    const [run] = await w.runs();
    expect(run).toMatchObject({
      gitlabPipelineId: p,
      iid: 1,
      status: "pending",
      ref: "main",
      connectionId: conn1,
      failureReason: null,
      failedJob: null,
    });
    expect(run?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(run?.webUrl).toBe(`${mock.url}/${w.gl.path}/-/pipelines/${p}`);
  });

  test("a repeated event is one run, and only a finished pipeline asks for the jobs", async () => {
    const w = await world();
    const p = await w.trigger();
    mock.requests.splice(0);
    for (let i = 0; i < 3; i++) await handler(job(w.event(p)));
    expect(await w.runs()).toHaveLength(1);
    expect(requestsTo(/\/jobs$/)).toEqual([]);
    mock.finishPipeline(p, "failed");
    await handler(job(w.event(p)));
    expect(await w.runs()).toHaveLength(1);
    // one listing names the failure and one looks for a secret-detection report (SCAN-3)
    expect(requestsTo(/\/jobs$/)).toHaveLength(2);
  });

  test("a failure names the first job that failed and why; passing later clears it", async () => {
    const f = await failedRun();
    expect(f.run).toMatchObject({
      status: "failed",
      failedJob: "test",
      failureReason: "script_failure",
    });
    mock.finishPipeline(f.p, "success");
    await handler(job(f.event(f.p)));
    const [again] = await f.runs();
    expect(again).toMatchObject({
      id: f.run.id,
      status: "success",
      failedJob: null,
      failureReason: null,
    });
  });

  test("GitLab's own reason is kept, not a guess", async () => {
    const w = await world();
    const p = await w.trigger();
    mock.finishPipeline(p, "failed", "runner_system_failure");
    await handler(job(w.event(p)));
    expect((await w.runs())[0]).toMatchObject({ failureReason: "runner_system_failure" });
  });

  test("a job that passed is not the failure, whatever its place", async () => {
    const w = await world("build:\n  script:\n    - echo a\ntest:\n  script:\n    - echo b\n");
    const p = await w.trigger();
    mock.finishPipeline(p, "failed", "script_failure", ["build"]);
    await handler(job(w.event(p)));
    expect((await w.runs())[0]).toMatchObject({
      failedJob: "test",
      failureReason: "script_failure",
    });
  });

  test("a job allowed to fail is not the failure", async () => {
    const f = await failedRun(
      "deploy:\n  when: manual\n  script:\n    - echo deploy\ntest:\n  script:\n    - echo hi\n",
    );
    expect(f.run).toMatchObject({ status: "failed", failedJob: "test" });
  });

  test("a failed pipeline whose only failed job may fail has no failure to name", async () => {
    const f = await failedRun("deploy:\n  when: manual\n  script:\n    - echo deploy\n");
    expect(f.run).toMatchObject({ status: "failed", failedJob: null, failureReason: null });
  });

  test("what GitLab says about a failure is clipped", async () => {
    const name = "j".repeat(300);
    const w = await world(`${name}:\n  script:\n    - echo hi\n`);
    const p = await w.trigger();
    mock.finishPipeline(p, "failed", "r".repeat(500));
    await handler(job(w.event(p)));
    const [run] = await w.runs();
    expect([run?.failedJob, run?.failureReason]).toEqual(["j".repeat(200), "r".repeat(200)]);
  });

  test("an event for a project the platform does not know is dropped without asking GitLab", async () => {
    const w = await world();
    const p = await w.trigger();
    mock.requests.splice(0);
    await handler(job(w.event(p, { projectId: 424_242 })));
    expect(mock.requests).toEqual([]);
    expect(await w.runs()).toEqual([]);
  });

  test("an event cannot reach a project of another organization", async () => {
    const w = await world();
    const p = await w.trigger();
    mock.requests.splice(0);
    await handler(job(w.event(p, { organizationId: o2 })));
    expect(mock.requests).toEqual([]);
    expect(await w.runs()).toEqual([]);
  });

  test.each([
    ["a push", { event: "push" }],
    ["a job", { event: "job" }],
    ["no pipeline id", { pipelineId: undefined }],
    ["a pipeline id that is not a number", { pipelineId: "7" }],
    ["a connection that is not an id", { connectionId: "x" }],
  ])("%s is not a pipeline event", async (_, over) => {
    const w = await world();
    const p = await w.trigger();
    mock.requests.splice(0);
    await handler(job(w.event(p, over)));
    expect(mock.requests).toEqual([]);
    expect(await w.runs()).toEqual([]);
  });

  test("a pipeline GitLab no longer has is dropped, not retried", async () => {
    const w = await world();
    await handler(job(w.event(9_999_999)));
    expect(await w.runs()).toEqual([]);
  });

  test("any other failure fails the job so the queue retries it", async () => {
    const w = await world();
    const p = await w.trigger();
    mock.inject({ method: "GET", path: /\/pipelines\/\d+$/, status: 500, times: 1 });
    await expect(handler(job(w.event(p)))).rejects.toThrow();
    expect(await w.runs()).toEqual([]);
    await handler(job(w.event(p))); // and the retry works
    expect(await w.runs()).toHaveLength(1);
  });

  test.each([401, 403])(
    "GitLab refusing the token (%d) drops the event, which no retry would serve",
    async (status) => {
      const w = await world();
      const p = await w.trigger();
      mock.inject({ method: "GET", path: /\/pipelines\/\d+$/, status, times: 1 });
      await handler(job(w.event(p)));
      expect(await w.runs()).toEqual([]);
    },
  );

  describe("with the connection opened as the worker opens it", () => {
    const opened = (provider: typeof keys | undefined) =>
      pipelineEventHandler({
        db: t.db,
        gitlab: workerGitlab({ db: t.db, keys: provider, logger }),
      });

    test("the pipeline is read with the connection's own token", async () => {
      const w = await world();
      const p = await w.trigger();
      mock.requests.splice(0);
      await opened(keys)(job(w.event(p)));
      expect((await w.runs())[0]?.connectionId).toBe(conn1);
      expect(requestsTo(/\/pipelines\/\d+$/)).toHaveLength(1);
    });

    test("a connection that is gone, or is not GitLab's, drops the event", async () => {
      const w = await world();
      const p = await w.trigger();
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
        await opened(keys)(job(w.event(p, { connectionId })));
      }
      expect(await w.runs()).toEqual([]);
      expect(mock.requests).toEqual([]);
    });

    test("a worker without the master key fails the job, so it waits for one", async () => {
      const w = await world();
      const p = await w.trigger();
      await expect(opened(undefined)(job(w.event(p)))).rejects.toThrow();
      expect(await w.runs()).toEqual([]);
    });
  });

  let ticks = 0;
  test.each([
    ["a clock that ticks", () => new Date(Date.UTC(2026, 0, 1) + 1000 * ++ticks)],
    ["the database's clock", undefined],
  ])(
    "a read that began earlier cannot overwrite a later one, whatever order they finish in (%s)",
    async (_, now) => {
      const w = await world();
      const p = await w.trigger();
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
        pipelines: {
          ...real.pipelines,
          get: async (...a: Parameters<Gitlab["pipelines"]["get"]>) => {
            const answer = await real.pipelines.get(...a);
            read();
            await gate; // this read has the old answer and is slow to store it
            return answer;
          },
        },
      } as Gitlab;
      const first = pipelineEventHandler({ db: t.db, gitlab: async () => slow, now });
      const second = pipelineEventHandler({ db: t.db, gitlab: async () => real, now });

      const late = first(job(w.event(p))); // reads `pending`, begun first
      await readIt;
      mock.finishPipeline(p, "success");
      await Bun.sleep(5); // the database's clock keeps milliseconds: the second read must begin after the first one's
      await second(job(w.event(p))); // begun later, reads `success`, stored first
      release();
      await late; // its older answer arrives last and is dropped
      expect((await w.runs()).map((r) => r.status)).toEqual(["success"]);
    },
  );
});

describe("the receiver feeds the handler", () => {
  test("a Pipeline Hook becomes a job the handler can use", async () => {
    const w = await world();
    const p = await w.trigger();
    mock.finishPipeline(p, "failed");
    const secret = (
      await call("alice", "POST", `/organizations/${o1}/connections/${conn1}/webhook-secret`)
    ).json.secret as string;
    const body = {
      object_kind: "pipeline",
      object_attributes: { id: p, status: "failed", ref: "main", sha: "a".repeat(40) },
      project: { id: w.gl.id },
      // what GitLab also sends, and must never reach a job
      variables: [{ key: "SECRET_THING", value: "do-not-queue-this" }],
    };
    const res = await app.handle(
      new Request(`http://localhost/webhooks/gitlab/${conn1}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-token": secret,
          "x-gitlab-event": "Pipeline Hook",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(await res.json()).toEqual({ status: "queued" });
    const queued = (await t.db.select().from(jobs).where(eq(jobs.queue, WEBHOOK_QUEUE))).filter(
      (j) => j.payload.pipelineId === p,
    );
    expect(queued).toHaveLength(1);
    expect(JSON.stringify(queued[0]?.payload)).not.toContain("do-not-queue-this");
    await handler(job(queued[0]?.payload ?? {}));
    expect((await w.runs())[0]).toMatchObject({
      gitlabPipelineId: p,
      status: "failed",
      failedJob: "test",
    });
  });
});

describe("reading runs", () => {
  async function seeded() {
    const w = await world();
    const rows: [number, string, string][] = [
      [101, "main", "success"],
      [102, "dev", "failed"],
      [103, "main", "running"],
      [104, "dev", "success"],
      [105, "feature", "failed"],
    ];
    for (const [id, ref, status] of rows) {
      await recordPipelineRun(t.db, {
        organizationId: o1,
        projectId: w.project.id,
        connectionId: conn1,
        gitlabPipelineId: id,
        iid: id - 100,
        status,
        ref,
        sha: "b".repeat(40),
        webUrl: `https://gitlab.example/-/pipelines/${id}`,
        failureReason: status === "failed" ? "script_failure" : null,
        failedJob: status === "failed" ? "test" : null,
        observedAt: new Date(),
      });
    }
    return w;
  }
  const ids = (res: { json: { runs: { gitlabPipelineId: number }[] } }) =>
    res.json.runs.map((r) => r.gitlabPipelineId);

  test("who may", async () => {
    const w = await seeded();
    for (const path of [`${w.base}/pipeline-runs`, `${w.base}/pipeline-runs/latest`]) {
      for (const who of ["alice", "bob", "carol", "dave"] as const) {
        expect([who, (await call(who, "GET", path)).status]).toEqual([who, 200]);
      }
      expect((await call("erin", "GET", path)).status).toBe(404);
      expect((await call(null, "GET", path)).status).toBe(401);
    }
  });

  test("newest first, a page at a time", async () => {
    const w = await seeded();
    const url = (qs: string) => `${w.base}/pipeline-runs${qs}`;
    const all = await call("alice", "GET", url(""));
    expect(ids(all)).toEqual([105, 104, 103, 102, 101]);
    expect(all.json.next).toBeNull();
    const a = await call("alice", "GET", url("?limit=2"));
    expect([ids(a), a.json.next]).toEqual([[105, 104], 104]);
    const b = await call("alice", "GET", url(`?limit=2&before=${a.json.next}`));
    expect([ids(b), b.json.next]).toEqual([[103, 102], 102]);
    const c = await call("alice", "GET", url(`?limit=2&before=${b.json.next}`));
    expect([ids(c), c.json.next]).toEqual([[101], null]);
    const exact = await call("alice", "GET", url("?limit=5"));
    expect([ids(exact), exact.json.next]).toEqual([[105, 104, 103, 102, 101], null]);
  });

  test("twenty runs a page unless asked for another number", async () => {
    const w = await world();
    for (let id = 1; id <= 22; id++) {
      await recordPipelineRun(t.db, {
        organizationId: o1,
        projectId: w.project.id,
        connectionId: conn1,
        gitlabPipelineId: id,
        iid: id,
        status: "success",
        ref: "main",
        sha: "d".repeat(40),
        webUrl: `https://gitlab.example/-/pipelines/${id}`,
        failureReason: null,
        failedJob: null,
        observedAt: new Date(),
      });
    }
    const page = await call("alice", "GET", `${w.base}/pipeline-runs`);
    expect([page.json.runs.length, page.json.next]).toEqual([20, 3]);
    expect(
      (await call("alice", "GET", `${w.base}/pipeline-runs?limit=100`)).json.runs,
    ).toHaveLength(22);
  });

  test("by ref and by status", async () => {
    const w = await seeded();
    const url = (qs: string) => `${w.base}/pipeline-runs?${qs}`;
    expect(ids(await call("alice", "GET", url("ref=main")))).toEqual([103, 101]);
    expect(ids(await call("alice", "GET", url("status=failed")))).toEqual([105, 102]);
    expect(ids(await call("alice", "GET", url("ref=dev&status=failed")))).toEqual([102]);
  });

  // NOD-10: the run of one GitLab pipeline, found by its number in this project (the web matches a trigger's downstream pipeline)
  test("by GitLab's number of the pipeline, in this project only", async () => {
    const w = await seeded();
    const url = (qs: string) => `${w.base}/pipeline-runs?${qs}`;
    const found = await call("alice", "GET", url("pipelineId=103"));
    expect(ids(found)).toEqual([103]);
    expect(found.json.next).toBeNull();
    expect(found.json.runs[0]).toMatchObject({ ref: "main", status: "running" });
    expect(ids(await call("alice", "GET", url("pipelineId=999")))).toEqual([]);
    // the other project has a pipeline of its own (and one that is numbered like this project's): each finds only its own
    const other = await world();
    for (const id of [101, 777]) {
      await recordPipelineRun(t.db, {
        organizationId: o1,
        projectId: other.project.id,
        connectionId: conn1,
        gitlabPipelineId: id,
        iid: 1,
        status: "success",
        ref: "elsewhere",
        sha: "c".repeat(40),
        webUrl: `https://gitlab.example/other/-/pipelines/${id}`,
        failureReason: null,
        failedJob: null,
        observedAt: new Date(),
      });
    }
    expect(ids(await call("alice", "GET", url("pipelineId=777")))).toEqual([]);
    const theirs = await call("alice", "GET", `${other.base}/pipeline-runs?pipelineId=777`);
    expect(theirs.json.runs.map((r: { ref: string }) => r.ref)).toEqual(["elsewhere"]);
    expect((await call("alice", "GET", url("pipelineId=101"))).json.runs[0].ref).toBe("main");
    // with the other filters, all of them hold
    expect(ids(await call("alice", "GET", url("pipelineId=103&ref=dev")))).toEqual([]);
    expect(ids(await call("alice", "GET", url("pipelineId=103&ref=main")))).toEqual([103]);
  });

  test("by the pipeline's number: who may, as for the rest of the list", async () => {
    const w = await seeded();
    const path = `${w.base}/pipeline-runs?pipelineId=103`;
    for (const who of ["alice", "bob", "carol", "dave"] as const) {
      const res = await call(who, "GET", path);
      expect([who, res.status, ids(res)]).toEqual([who, 200, [103]]);
    }
    const stranger = await call("erin", "GET", path);
    expect([stranger.status, stranger.text]).toEqual([404, expect.not.stringContaining("103")]);
    expect((await call(null, "GET", path)).status).toBe(401);
  });

  test.each([
    "limit=0",
    "limit=101",
    "limit=x",
    "before=0",
    "before=x",
    "status=Failed",
    "ref=",
    "pipelineId=0",
    "pipelineId=x",
    "pipelineId=1.5",
  ])("?%s is refused", async (qs) => {
    const w = await world();
    expect((await call("alice", "GET", `${w.base}/pipeline-runs?${qs}`)).status).toBe(422);
  });

  test("the latest run of each ref", async () => {
    const w = await seeded();
    const all = await call("alice", "GET", `${w.base}/pipeline-runs/latest`);
    expect(all.json.runs.map((r: { ref: string }) => r.ref)).toEqual(["feature", "dev", "main"]);
    expect(ids(all)).toEqual([105, 104, 103]);
    expect(ids(await call("alice", "GET", `${w.base}/pipeline-runs/latest?limit=2`))).toEqual([
      105, 104,
    ]);
    expect((await call("alice", "GET", `${w.base}/pipeline-runs/latest?limit=51`)).status).toBe(
      422,
    );
  });

  test("what a run shows, and what it does not", async () => {
    const w = await seeded();
    const [run] = (await call("alice", "GET", `${w.base}/pipeline-runs?limit=1`)).json.runs;
    expect(Object.keys(run).sort()).toEqual(
      [
        "createdAt",
        "failedJob",
        "failureReason",
        "gitlabPipelineId",
        "id",
        "iid",
        "observedAt",
        "ref",
        "sha",
        "status",
        "updatedAt",
        "webUrl",
      ].sort(),
    );
    expect(run).toMatchObject({ failedJob: "test", failureReason: "script_failure" });
  });

  test("an unknown project, or another organization's, is not found", async () => {
    const w = await seeded();
    const none = "00000000-0000-4000-8000-000000000000";
    for (const tail of ["", "/latest"]) {
      expect(
        (await call("alice", "GET", `/organizations/${o1}/projects/${none}/pipeline-runs${tail}`))
          .status,
      ).toBe(404);
      // alice is an admin of o2 as well, but the project is o1's
      expect(
        (
          await call(
            "alice",
            "GET",
            `/organizations/${o2}/projects/${w.project.id}/pipeline-runs${tail}`,
          )
        ).status,
      ).toBe(404);
    }
  });
});

describe("retrying a pipeline", () => {
  test("runs the failed jobs again, and the run is what GitLab answers", async () => {
    const f = await failedRun();
    mock.requests.splice(0);
    const res = await retry(f.base, f.run.id);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: f.run.id,
      gitlabPipelineId: f.p,
      status: "pending",
      failedJob: null,
      failureReason: null,
    });
    // retried, then read: the answer is what the pipeline is, not what the retry said
    expect(
      requestsTo(/\/pipelines\/\d+(\/retry)?$/).map((r) => [r.method, r.path.split("/").pop()]),
    ).toEqual([
      ["POST", "retry"],
      ["GET", String(f.p)],
    ]);
    expect((await f.runs()).map((r) => r.status)).toEqual(["pending"]);
    const [row] = await auditRows("pipeline.retry");
    expect(row).toMatchObject({
      resourceType: "pipeline_run",
      resourceId: f.run.id,
      projectId: f.project.id,
      metadata: { gitlabPipelineId: f.p, from: "failed", to: "pending" },
    });
  });

  test("a late event about the failure reads the present, not the past", async () => {
    const f = await failedRun();
    await retry(f.base, f.run.id);
    await handler(job(f.event(f.p, { status: "failed" }))); // GitLab's message, long out of date
    expect((await f.runs())[0]).toMatchObject({ status: "pending", failedJob: null });
    mock.finishPipeline(f.p, "success");
    await handler(job(f.event(f.p, { status: "success" })));
    expect((await f.runs())[0]).toMatchObject({ status: "success", failedJob: null });
  });

  test("a failure after a retry is a new failure", async () => {
    const f = await failedRun();
    await retry(f.base, f.run.id);
    mock.finishPipeline(f.p, "failed", "stuck_or_timeout_failure");
    await handler(job(f.event(f.p)));
    expect((await f.runs())[0]).toMatchObject({
      id: f.run.id,
      status: "failed",
      failureReason: "stuck_or_timeout_failure",
    });
  });

  test("a canceled pipeline can be retried too", async () => {
    const f = await failedRun();
    await recordPipelineRun(t.db, restate(f.run, { status: "canceled" }));
    expect((await retry(f.base, f.run.id)).status).toBe(200);
  });

  test.each(["success", "running", "pending", "manual"])(
    "a %s pipeline is not retryable",
    async (status) => {
      const f = await failedRun();
      await recordPipelineRun(t.db, restate(f.run, { status }));
      mock.requests.splice(0);
      const res = await retry(f.base, f.run.id);
      expect([res.status, res.json.code]).toEqual([409, "not_retryable"]);
      expect(mock.requests).toEqual([]);
    },
  );

  test("who may", async () => {
    const f = await failedRun();
    mock.requests.splice(0);
    // refused before anything is sent to GitLab
    for (const [who, status] of [
      ["bob", 403], // an organization member reads but does not retry
      ["carol", 403], // a project reporter likewise
      ["erin", 404],
      [null, 401],
    ] as const) {
      expect([who, (await retry(f.base, f.run.id, who)).status]).toEqual([who, status]);
    }
    expect(mock.requests).toEqual([]);
    expect((await f.runs())[0]?.status).toBe("failed");
    expect(await auditRows("pipeline.retry")).not.toContainEqual(
      expect.objectContaining({ resourceId: f.run.id }),
    );
    // an organization admin and a project maintainer may
    expect((await retry(f.base, f.run.id, "dave")).status).toBe(200);
    const g = await failedRun();
    expect((await retry(g.base, g.run.id, "alice")).status).toBe(200);
  });

  test("not another project's run, nor another organization's", async () => {
    const f = await failedRun();
    const other = await world();
    mock.requests.splice(0);
    expect((await retry(other.base, f.run.id)).status).toBe(404);
    expect(
      (
        await call(
          "alice",
          "POST",
          `/organizations/${o2}/projects/${f.project.id}/pipeline-runs/${f.run.id}/retry`,
        )
      ).status,
    ).toBe(404);
    const none = "00000000-0000-4000-8000-000000000000";
    expect((await retry(f.base, none)).status).toBe(404);
    expect(mock.requests).toEqual([]);
  });

  test("not when the connection that read it is gone", async () => {
    const f = await failedRun();
    await recordPipelineRun(t.db, restate(f.run, { connectionId: null }));
    const res = await retry(f.base, f.run.id);
    expect([res.status, res.json.code]).toEqual([409, "no_connection"]);
  });

  test("not for a project that is not from GitLab", async () => {
    const project = await createProject(t.db, { organizationId: o1, name: `bare${++n}` });
    const run = await recordPipelineRun(t.db, {
      organizationId: o1,
      projectId: project.id,
      connectionId: conn1,
      gitlabPipelineId: 5,
      iid: 1,
      status: "failed",
      ref: "main",
      sha: "c".repeat(40),
      webUrl: "https://gitlab.example/-/pipelines/5",
      failureReason: null,
      failedJob: null,
      observedAt: new Date(),
    });
    const res = await retry(`/organizations/${o1}/projects/${project.id}`, run.run.id);
    expect([res.status, res.json.code]).toEqual([422, "not_linked"]);
  });

  test("needs the master key, as every use of a connection's token does", async () => {
    const f = await failedRun();
    mock.requests.splice(0);
    const res = await retry(f.base, f.run.id, "alice", makeApp(undefined));
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect(mock.requests).toEqual([]);
  });

  test("GitLab failing is a 502 and changes nothing here", async () => {
    const f = await failedRun();
    mock.inject({ method: "POST", path: /\/retry$/, status: 500, times: 1 });
    const res = await retry(f.base, f.run.id);
    expect([res.status, res.json.code]).toEqual([502, "gitlab_failed"]);
    expect((await f.runs())[0]?.status).toBe("failed");
    expect(await auditRows("pipeline.retry")).not.toContainEqual(
      expect.objectContaining({ resourceId: f.run.id }),
    );
  });

  test.each([403, 400, 422])("GitLab refusing (%d) is a 422 of its own", async (status) => {
    const f = await failedRun();
    mock.inject({ method: "POST", path: /\/retry$/, status, times: 1 });
    const res = await retry(f.base, f.run.id);
    expect([res.status, res.json.code]).toEqual([422, "gitlab_refused"]);
    expect((await f.runs())[0]?.status).toBe("failed");
  });

  test("a pipeline GitLab no longer has says so", async () => {
    const f = await failedRun();
    const { run: gone } = await recordPipelineRun(
      t.db,
      restate(f.run, { gitlabPipelineId: 9_999_001, observedAt: new Date() }),
    );
    const res = await retry(f.base, gone.id);
    expect([res.status, res.json.code]).toEqual([422, "gitlab_pipeline_gone"]);
  });
});

/** A CI file of `count` jobs in one stage, all in GitLab's order of definition. */
const manyJobs = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `j${String(i).padStart(3, "0")}:\n  script:\n    - echo\n`,
  ).join("");
const JOB_KEYS = [
  "allowFailure",
  "duration",
  "failureReason",
  "finishedAt",
  "id",
  "name",
  "stage",
  "startedAt",
  "status",
  "webUrl",
].sort();
const jobsOf = (base: string, id: string, who: Who | null = "alice", a = app) =>
  call(who, "GET", `${base}/pipeline-runs/${id}/jobs`, a);

describe("the jobs of a pipeline", () => {
  const STAGES =
    "build:\n  stage: build\n  script:\n    - make\nunit:\n  stage: test\n  script:\n    - make test\nlint:\n  stage: test\n  script:\n    - make lint\n";

  test("answers each job in the order they were made, stage by stage, with what a page needs, read live and written nowhere", async () => {
    const f = await failedRun(STAGES);
    mock.finishPipeline(f.p, "failed", "script_failure", ["build"]);
    const audits = (await t.db.select().from(auditEvents)).length;
    mock.requests.splice(0);
    const res = await jobsOf(f.base, f.run.id);
    expect(res.status).toBe(200);
    expect(res.json.truncated).toBe(false);
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: a response body
      res.json.jobs.map((j: any) => [j.name, j.stage, j.status, j.failureReason, j.allowFailure]),
    ).toEqual([
      ["build", "build", "success", null, false],
      ["unit", "test", "failed", "script_failure", false],
      ["lint", "test", "failed", "script_failure", false],
    ]);
    for (const j of res.json.jobs) {
      expect(Object.keys(j).sort()).toEqual(JOB_KEYS);
      expect(typeof j.startedAt).toBe("string");
      expect(typeof j.finishedAt).toBe("string");
      expect(j.duration).toBeGreaterThanOrEqual(0);
      expect(j.webUrl).toBe(`${mock.url}/${f.gl.path}/-/jobs/${j.id}`);
    }
    // only reads, and nothing is stored: a look at the jobs leaves no trace here
    expect(mock.requests.map((r) => r.method)).toEqual(mock.requests.map(() => "GET"));
    expect(requestsTo(/\/pipelines\/\d+\/jobs/).length).toBeGreaterThan(0);
    expect((await t.db.select().from(auditEvents)).length).toBe(audits);
  });

  test("is oldest first even when GitLab lists the newest first, as it does now: that is the stages' order", async () => {
    const f = await failedRun(STAGES);
    mock.listJobsNewestFirst(true);
    try {
      const raw = await fetch(`${mock.url}/api/v4/projects/${f.gl.id}/pipelines/${f.p}/jobs`, {
        headers: { "private-token": mock.token },
      }).then((r) => r.json() as Promise<{ name: string }[]>);
      // the mock does list them backwards (or this test would pass for nothing)
      expect(raw.map((j) => j.name)).toEqual(["lint", "unit", "build"]);
      const res = await jobsOf(f.base, f.run.id);
      // biome-ignore lint/suspicious/noExplicitAny: a response body
      expect(res.json.jobs.map((j: any) => j.name)).toEqual(["build", "unit", "lint"]);
    } finally {
      mock.listJobsNewestFirst(false);
    }
  });

  test("a job that has not run has no times", async () => {
    const w = await world(STAGES);
    const p = await w.trigger();
    await handler(job(w.event(p)));
    const [run] = await w.runs();
    const res = await jobsOf(w.base, run?.id ?? "");
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: a response body
      res.json.jobs.map((j: any) => [j.status, j.startedAt, j.finishedAt, j.duration]),
    ).toEqual([
      ["pending", null, null, null],
      ["pending", null, null, null],
      ["pending", null, null, null],
    ]);
  });

  test("only the allow-listed keys leave, whatever GitLab sends on a job", async () => {
    const f = await failedRun(STAGES);
    mock.addJobFields(f.p, "unit", {
      trace: "$ echo TRACE-SECRET-VALUE",
      variables: [{ key: "TOKEN", value: "VARIABLE-SECRET-VALUE" }],
      runner: { id: 7, description: "RUNNER-DESCRIPTION", token: "RUNNER-SECRET-VALUE" },
      user: { id: 3, username: "USERNAME-OF-TRIGGERER" },
      artifacts: [{ filename: "ARTIFACT-NAME.zip" }],
    });
    // the mock does send them (or this test would pass for nothing)
    const raw = await fetch(`${mock.url}/api/v4/projects/${f.gl.id}/pipelines/${f.p}/jobs`, {
      headers: { "private-token": mock.token },
    }).then((r) => r.text());
    expect(raw).toContain("TRACE-SECRET-VALUE");
    expect(raw).toContain("USERNAME-OF-TRIGGERER");

    const res = await jobsOf(f.base, f.run.id);
    expect(res.status).toBe(200);
    for (const j of res.json.jobs) expect(Object.keys(j).sort()).toEqual(JOB_KEYS);
    for (const word of [
      "TRACE-SECRET-VALUE",
      "VARIABLE-SECRET-VALUE",
      "RUNNER-DESCRIPTION",
      "RUNNER-SECRET-VALUE",
      "USERNAME-OF-TRIGGERER",
      "ARTIFACT-NAME",
    ]) {
      expect(res.text).not.toContain(word);
      expect(lines.join("\n")).not.toContain(word);
    }
  });

  test("names and reasons are clipped as the stored run's are", async () => {
    const long = "n".repeat(300);
    const f = await failedRun(`${long}:\n  script:\n    - echo\n`);
    mock.finishPipeline(f.p, "failed", "r".repeat(300));
    const res = await jobsOf(f.base, f.run.id);
    expect(res.json.jobs[0].name).toHaveLength(200);
    expect(res.json.jobs[0].failureReason).toHaveLength(200);
  });

  test("at most 200 jobs, and it says when there were more", async () => {
    const over = await failedRun(manyJobs(201));
    const a = await jobsOf(over.base, over.run.id);
    expect([a.status, a.json.jobs.length, a.json.truncated]).toEqual([200, 200, true]);
    expect(a.json.jobs[0].name).toBe("j000");
    const exact = await failedRun(manyJobs(200));
    const b = await jobsOf(exact.base, exact.run.id);
    expect([b.status, b.json.jobs.length, b.json.truncated]).toEqual([200, 200, false]);
  });

  test("not when the connection that read it is gone, and GitLab is not asked", async () => {
    const f = await failedRun();
    await recordPipelineRun(t.db, restate(f.run, { connectionId: null }));
    mock.requests.splice(0);
    const res = await jobsOf(f.base, f.run.id);
    expect([res.status, res.json.code]).toEqual([409, "no_connection"]);
    expect(mock.requests).toEqual([]);
  });

  test("not for a project that is not from GitLab", async () => {
    const project = await createProject(t.db, { organizationId: o1, name: `bare${++n}` });
    const run = await recordPipelineRun(t.db, {
      organizationId: o1,
      projectId: project.id,
      connectionId: conn1,
      gitlabPipelineId: 6,
      iid: 1,
      status: "success",
      ref: "main",
      sha: "c".repeat(40),
      webUrl: "https://gitlab.example/-/pipelines/6",
      failureReason: null,
      failedJob: null,
      observedAt: new Date(),
    });
    const res = await jobsOf(`/organizations/${o1}/projects/${project.id}`, run.run.id);
    expect([res.status, res.json.code]).toEqual([422, "not_linked"]);
  });

  test("needs the master key, as every use of a connection's token does", async () => {
    const f = await failedRun();
    mock.requests.splice(0);
    const res = await jobsOf(f.base, f.run.id, "alice", makeApp(undefined));
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect(mock.requests).toEqual([]);
  });

  test("GitLab failing is a 502, and its words are about reading the jobs", async () => {
    const f = await failedRun();
    // a read is tried once more (`gitlabFor`: one retry), so the failure outlasts it
    mock.inject({ method: "GET", path: /\/jobs$/, status: 500, times: 2 });
    const failed = await jobsOf(f.base, f.run.id);
    expect([failed.status, failed.json.code]).toEqual([502, "gitlab_failed"]);
    mock.inject({ method: "GET", path: /\/jobs$/, status: 403, times: 1 });
    const refused = await jobsOf(f.base, f.run.id);
    expect([refused.status, refused.json.code]).toEqual([422, "gitlab_refused"]);
    expect(refused.json.detail ?? refused.json.message ?? refused.text).not.toMatch(/retry/i);
    const { run: gone } = await recordPipelineRun(
      t.db,
      restate(f.run, { gitlabPipelineId: 9_999_002, observedAt: new Date() }),
    );
    const missing = await jobsOf(f.base, gone.id);
    expect([missing.status, missing.json.code]).toEqual([422, "gitlab_pipeline_gone"]);
  });

  test("who may read: an admin, an organization member, a project reporter and a maintainer do; a stranger and no one do not", async () => {
    const f = await failedRun();
    mock.requests.splice(0);
    for (const [who, status] of [
      ["erin", 404],
      [null, 401],
    ] as const) {
      expect([who, (await jobsOf(f.base, f.run.id, who)).status]).toEqual([who, status]);
    }
    expect(mock.requests).toEqual([]);
    for (const who of ["alice", "bob", "carol", "dave"] as const) {
      expect([who, (await jobsOf(f.base, f.run.id, who)).status]).toEqual([who, 200]);
    }
  });

  test("not another project's run, nor another organization's", async () => {
    const f = await failedRun();
    const other = await world();
    mock.requests.splice(0);
    expect((await jobsOf(other.base, f.run.id)).status).toBe(404);
    expect(
      (
        await call(
          "alice",
          "GET",
          `/organizations/${o2}/projects/${f.project.id}/pipeline-runs/${f.run.id}/jobs`,
        )
      ).status,
    ).toBe(404);
    const none = "00000000-0000-4000-8000-000000000000";
    expect((await jobsOf(f.base, none)).status).toBe(404);
    expect(mock.requests).toEqual([]);
  });

  test("the connection's token is in no jobs response, no log and no audit row", async () => {
    const f = await failedRun();
    await jobsOf(f.base, f.run.id);
    const rows = JSON.stringify(await t.db.select().from(auditEvents));
    for (const place of [seen.join("\n"), lines.join("\n"), rows]) {
      expect(place).not.toContain(mock.token);
    }
  });
});

const TRIGGER_KEYS = ["downstream", "id", "name", "stage", "status", "webUrl"];
const DOWNSTREAM_KEYS = ["gone", "pipelineId", "projectId", "sameProject", "status"];
const CHILD_KEYS = ["jobs", "pipelineId", "status", "truncated"];

describe("the triggers and the child pipelines of a pipeline (NOD-6)", () => {
  const STAGES =
    "build:\n  stage: build\n  script:\n    - make\ndeploy:\n  stage: deploy\n  script:\n    - make deploy\n";
  // biome-ignore lint/suspicious/noExplicitAny: a response body
  const names = (jobs: any[]) => jobs.map((j) => j.name);

  test("a trigger in this project answers its state and its child's jobs, in the same ten keys", async () => {
    const f = await failedRun(STAGES);
    const child = mock.addDownstream(f.p, "launch", ["migrate", "smoke"], { stage: "deploy" });
    const res = await jobsOf(f.base, f.run.id);
    expect(res.status).toBe(200);
    expect(names(res.json.jobs)).toEqual(["build", "deploy"]);
    expect(res.json.triggers).toHaveLength(1);
    const [trigger] = res.json.triggers;
    expect(Object.keys(trigger).sort()).toEqual(TRIGGER_KEYS);
    expect(Object.keys(trigger.downstream).sort()).toEqual(DOWNSTREAM_KEYS);
    expect([trigger.name, trigger.stage, trigger.status]).toEqual(["launch", "deploy", "pending"]);
    expect(trigger.webUrl).toContain(`${mock.url}/${f.gl.path}/-/jobs/`);
    expect(trigger.downstream).toEqual({
      pipelineId: child,
      status: "pending",
      sameProject: true,
      projectId: null,
      gone: false,
    });
    expect(res.json.triggersTruncated).toBe(false);
    expect(res.json.children).toHaveLength(1);
    const [c] = res.json.children;
    // a trigger is a job of the pipeline: its number is from the same sequence as the jobs', so it sorts among them
    const jobIds = [...res.json.jobs, ...c.jobs].map((j: { id: number }) => j.id);
    expect(jobIds).not.toContain(trigger.id);
    expect(Math.max(...res.json.jobs.map((j: { id: number }) => j.id))).toBeLessThan(trigger.id);
    expect(Object.keys(c).sort()).toEqual(CHILD_KEYS);
    expect([c.pipelineId, c.status, c.truncated]).toEqual([child, "pending", false]);
    expect(names(c.jobs)).toEqual(["migrate", "smoke"]);
    for (const j of c.jobs) expect(Object.keys(j).sort()).toEqual(JOB_KEYS);
  });

  test("a pipeline with no trigger answers none, and asks GitLab for nothing more than its jobs and its triggers", async () => {
    const f = await failedRun(STAGES);
    mock.requests.splice(0);
    const res = await jobsOf(f.base, f.run.id);
    expect([res.json.triggers, res.json.children, res.json.triggersTruncated]).toEqual([
      [],
      [],
      false,
    ]);
    expect(mock.requests.map((r) => r.method)).toEqual(mock.requests.map(() => "GET"));
    expect(requestsTo(/\/pipelines\/\d+\/(jobs|bridges)$/)).toHaveLength(2);
    expect(requestsTo(/\/pipelines\/\d+\/(jobs|bridges)$/)).toHaveLength(mock.requests.length);
  });

  test("only the allow-listed keys of a child's jobs leave, whatever GitLab sends", async () => {
    const f = await failedRun(STAGES);
    const child = mock.addDownstream(f.p, "launch", ["migrate"]);
    mock.addJobFields(child, "migrate", {
      trace: "$ echo TRACE-SECRET-VALUE",
      variables: [{ key: "TOKEN", value: "VARIABLE-SECRET-VALUE" }],
      runner: { id: 7, description: "RUNNER-DESCRIPTION", token: "RUNNER-SECRET-VALUE" },
      user: { id: 3, username: "USERNAME-OF-TRIGGERER" },
    });
    const raw = await fetch(`${mock.url}/api/v4/projects/${f.gl.id}/pipelines/${child}/jobs`, {
      headers: { "private-token": mock.token },
    }).then((r) => r.text());
    expect(raw).toContain("TRACE-SECRET-VALUE"); // the mock does send them
    const res = await jobsOf(f.base, f.run.id);
    expect(res.json.children[0].jobs).toHaveLength(1);
    for (const j of res.json.children[0].jobs) expect(Object.keys(j).sort()).toEqual(JOB_KEYS);
    for (const word of [
      "TRACE-SECRET-VALUE",
      "VARIABLE-SECRET-VALUE",
      "RUNNER-DESCRIPTION",
      "RUNNER-SECRET-VALUE",
      "USERNAME-OF-TRIGGERER",
    ]) {
      expect(res.text).not.toContain(word);
      expect(lines.join("\n")).not.toContain(word);
    }
  });

  test("at most 200 jobs in all: a child gets what the pipeline left, and says it was cut", async () => {
    const f = await failedRun(manyJobs(150));
    mock.addDownstream(
      f.p,
      "launch",
      Array.from({ length: 51 }, (_, i) => `c${String(i).padStart(3, "0")}`),
    );
    const res = await jobsOf(f.base, f.run.id);
    const [c] = res.json.children;
    expect([res.json.jobs.length, res.json.truncated]).toEqual([150, false]);
    expect([c.jobs.length, c.truncated]).toEqual([50, true]);
    expect(res.json.jobs.length + c.jobs.length).toBe(200);
    expect(c.jobs[0].name).toBe("c000");
  });

  test("at most 5 children are read, and the sixth trigger is still listed", async () => {
    const f = await failedRun(STAGES);
    const kids = Array.from({ length: 6 }, (_, i) => mock.addDownstream(f.p, `t${i}`, [`k${i}`]));
    mock.requests.splice(0);
    const res = await jobsOf(f.base, f.run.id);
    expect(res.json.triggers).toHaveLength(6);
    expect(res.json.children.map((c: { pipelineId: number }) => c.pipelineId)).toEqual(
      kids.slice(0, 5),
    );
    expect(requestsTo(new RegExp(`/pipelines/${kids[5]}/`))).toEqual([]);
    expect(res.json.triggers[5].downstream).toEqual({
      pipelineId: kids[5],
      status: "pending",
      sameProject: true,
      projectId: null,
      gone: false,
    });
  });

  test("at most 20 triggers, and it says when there were more", async () => {
    const f = await failedRun(STAGES);
    for (let i = 0; i < 20; i++) mock.addBridge(f.p, `t${i}`, "deploy");
    const exact = await jobsOf(f.base, f.run.id);
    expect([exact.json.triggers.length, exact.json.triggersTruncated]).toEqual([20, false]);
    mock.addBridge(f.p, "t20", "deploy");
    const over = await jobsOf(f.base, f.run.id);
    expect([over.json.triggers.length, over.json.triggersTruncated]).toEqual([20, true]);
    expect(over.json.triggers[0].downstream).toBeNull();
  });

  test("a child's own trigger is not followed", async () => {
    const f = await failedRun(STAGES);
    const child = mock.addDownstream(f.p, "launch", ["migrate"]);
    const grand = mock.addDownstream(child, "again", ["GRANDCHILD-JOB"]);
    mock.requests.splice(0);
    const res = await jobsOf(f.base, f.run.id);
    expect(res.json.children).toHaveLength(1);
    expect(res.text).not.toContain("GRANDCHILD-JOB");
    expect(res.text).not.toContain("again");
    expect(requestsTo(new RegExp(`/pipelines/${child}/bridges`))).toEqual([]);
    expect(requestsTo(new RegExp(`/pipelines/${grand}/`))).toEqual([]);
  });

  test("a trigger into another project answers its state and number, and that project's pipeline is not read", async () => {
    const f = await failedRun(STAGES);
    const other = mock.addProject({ path: "fx/elsewhere", files: { ".gitlab-ci.yml": CI } });
    const child = mock.addDownstream(f.p, "launch", ["OTHER-PROJECT-JOB"], {
      project: other.path,
    });
    mock.setPipelineStatus(child, "running");
    mock.requests.splice(0);
    const res = await jobsOf(f.base, f.run.id);
    expect(res.status).toBe(200);
    expect(res.json.children).toEqual([]);
    const [trigger] = res.json.triggers;
    expect(trigger.downstream).toEqual({
      pipelineId: child,
      status: "running",
      sameProject: false,
      projectId: other.id,
      gone: false,
    });
    // no name, path, address or job of the other project, and no request that asks for any
    expect(trigger.webUrl).toBe("");
    for (const word of [other.path, "elsewhere", "OTHER-PROJECT-JOB"])
      expect(res.text).not.toContain(word);
    expect(requestsTo(new RegExp(`/projects/${other.id}[/?]|/pipelines/${child}`))).toEqual([]);
    expect(requestsTo(/\/projects\/[^/]+\/?$/)).toEqual([]);
  });

  // NOD-9: the connection that reads this project can read the other one too (same token, same GitLab), so what keeps its
  // name, path, address and jobs out of the answer is this route, not GitLab's permissions
  test("a trigger into another project the connection can read still leaves out that project's name, path, address and jobs, from the answer and the logs", async () => {
    const f = await failedRun(STAGES);
    const other = mock.addProject({
      path: "fx/elsewhere-team/billing-api",
      files: { ".gitlab-ci.yml": CI },
    });
    const child = mock.addDownstream(f.p, "launch", ["OTHER-PROJECT-JOB"], {
      project: other.path,
    });
    mock.setPipelineStatus(child, "success");
    const reachable = await fetch(
      `${mock.url}/api/v4/projects/${other.id}/pipelines/${child}/jobs`,
      { headers: { "private-token": mock.token } },
    );
    expect(reachable.status).toBe(200);
    expect(await reachable.text()).toContain("OTHER-PROJECT-JOB");
    lines.splice(0);
    mock.requests.splice(0);
    const res = await jobsOf(f.base, f.run.id);
    expect(res.status).toBe(200);
    expect(res.json.triggers[0].downstream).toEqual({
      pipelineId: child,
      status: "success",
      sameProject: false,
      projectId: other.id,
      gone: false,
    });
    const said = `${res.text}\n${lines.join("\n")}`;
    for (const word of [
      other.path,
      "elsewhere-team",
      "billing-api",
      `${mock.url}/${other.path}`,
      "OTHER-PROJECT-JOB",
    ])
      expect(said, word).not.toContain(word);
    // nothing asked GitLab about it, so nothing it knows could have been passed on
    expect(requestsTo(new RegExp(`/projects/${other.id}[/?]|/pipelines/${child}`))).toEqual([]);
  });

  test("a downstream whose project GitLab does not name is treated as another project's, and not read", async () => {
    const f = await failedRun(STAGES);
    const child = mock.addDownstream(f.p, "launch", ["k"], { omitProject: true });
    mock.requests.splice(0);
    const res = await jobsOf(f.base, f.run.id);
    expect(res.json.children).toEqual([]);
    expect(res.json.triggers[0].downstream).toEqual({
      pipelineId: child,
      status: "pending",
      sameProject: false,
      projectId: null,
      gone: false,
    });
    expect(requestsTo(new RegExp(`/pipelines/${child}/`))).toEqual([]);
  });

  test("a child that is gone is left out, its trigger says so, and the pipeline's own jobs still answer", async () => {
    const f = await failedRun(STAGES);
    const child = mock.addDownstream(f.p, "launch", ["migrate"]);
    mock.inject({ method: "GET", path: new RegExp(`/pipelines/${child}/jobs$`), status: 404 });
    const res = await jobsOf(f.base, f.run.id);
    expect(res.status).toBe(200);
    expect(names(res.json.jobs)).toEqual(["build", "deploy"]);
    expect(res.json.children).toEqual([]);
    expect(res.json.triggers[0].downstream).toEqual({
      pipelineId: child,
      status: "pending",
      sameProject: true,
      projectId: null,
      gone: true,
    });
  });

  test("GitLab failing on the triggers or on a child is a 502, as it is on the jobs", async () => {
    const f = await failedRun(STAGES);
    mock.inject({ method: "GET", path: /\/bridges$/, status: 500, times: 2 });
    const a = await jobsOf(f.base, f.run.id);
    expect([a.status, a.json.code]).toEqual([502, "gitlab_failed"]);
    const child = mock.addDownstream(f.p, "launch", ["migrate"]);
    mock.inject({
      method: "GET",
      path: new RegExp(`/pipelines/${child}/jobs$`),
      status: 500,
      times: 2,
    });
    const b = await jobsOf(f.base, f.run.id);
    expect([b.status, b.json.code]).toEqual([502, "gitlab_failed"]);
  });

  test("who may read is unchanged, and a stranger's request reads nothing", async () => {
    const f = await failedRun(STAGES);
    mock.addDownstream(f.p, "launch", ["migrate"]);
    mock.requests.splice(0);
    expect((await jobsOf(f.base, f.run.id, "erin")).status).toBe(404);
    expect((await jobsOf(f.base, f.run.id, null)).status).toBe(401);
    expect(mock.requests).toEqual([]);
    for (const who of ["bob", "carol", "dave"] as const)
      expect([who, (await jobsOf(f.base, f.run.id, who)).json.children?.length]).toEqual([who, 1]);
  });
});

describe("what is kept out", () => {
  test("the connection's token is in no response, no log and no audit row", async () => {
    const f = await failedRun();
    await retry(f.base, f.run.id);
    for (const base of [f.base]) {
      await call("alice", "GET", `${base}/pipeline-runs`);
      await call("alice", "GET", `${base}/pipeline-runs/latest`);
    }
    const rows = JSON.stringify(await t.db.select().from(auditEvents));
    expect(mock.token.length).toBeGreaterThan(10);
    for (const place of [seen.join("\n"), lines.join("\n"), rows]) {
      expect(place).not.toContain(mock.token);
    }
  });
});

function retry(base: string, id: string, who: Who | null = "alice", a = app) {
  return call(who, "POST", `${base}/pipeline-runs/${id}/retry`, a);
}
