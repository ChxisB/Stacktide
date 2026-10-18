import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  attachRunPipeline,
  createConnection,
  createOrganization,
  createProject,
  createRun,
  getRun,
  moveRunStack,
  type RunWithStacks,
  storePlanSummary,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab, type Job } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { jobsByStack, runEventHandler } from "./run-ingest";
import type { JobContext, JobHandler } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const SHA = "b".repeat(40);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let conn1: string;
const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
const asked: [string, string][] = [];
let handler: JobHandler;

const client = () =>
  createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });

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
  handler = runEventHandler({
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

const ciFor = (stacks: string[], extra = "") =>
  `${stacks
    .flatMap((s) => [`"plan:${s}":\n  script: [echo]`, `"summary:${s}":\n  script: [echo]`])
    .join("\n")}\n${extra}`;
const applyCi = (stacks: string[]) =>
  stacks.map((s) => `"apply:${s}":\n  script: [echo]`).join("\n");

let n = 0;
/**
 * A run of `stacks` on a project of its own, and the GitLab pipeline that plans (or applies) it:
 * what a pipeline event reports changes, and the run's stacks change with it.
 */
async function world(
  stacks = ["net", "app"],
  action: "plan" | "apply" = "plan",
  ci?: string,
  opts: { mr?: boolean } = {},
) {
  const id = ++n;
  const gl = mock.addProject({
    path: `ri/r${id}`,
    files: { ".gitlab-ci.yml": ci ?? (action === "plan" ? ciFor(stacks) : applyCi(stacks)) },
  });
  const project = await createProject(t.db, {
    organizationId: o1,
    name: `r${id}`,
    gitlabProjectId: gl.id,
  });
  let mr: { iid: number } | undefined;
  if (opts.mr) {
    await client().repository.createBranch(gl.id, "feature", "main");
    mr = await client().mergeRequests.create(gl.id, {
      sourceBranch: "feature",
      targetBranch: "main",
      title: "change",
    });
  }
  const run = await createRun(t.db, {
    organizationId: o1,
    projectId: project.id,
    ref: "main",
    sha: SHA,
    stacks,
    ...(mr ? { mergeRequestIid: mr.iid } : {}),
  });
  const pipelineId = (await client().pipelines.trigger(gl.id, "main")).id;
  await attachRunPipeline(t.db, {
    organizationId: o1,
    projectId: project.id,
    runId: run.id,
    gitlabPipelineId: pipelineId,
    action,
  });
  const event = (over: Record<string, unknown> = {}) => ({
    event: "pipeline",
    organizationId: o1,
    connectionId: conn1,
    projectId: gl.id,
    pipelineId,
    status: "pending",
    ref: "main",
    ...over,
  });
  const read = async (): Promise<RunWithStacks> => {
    const r = await getRun(t.db, o1, project.id, run.id);
    if (!r) throw new Error("run is gone");
    return r;
  };
  const states = async () =>
    Object.fromEntries((await read()).stacks.map((s) => [s.stack, s.status]));
  const deliver = (over: Record<string, unknown> = {}) => handler(job(event(over)));
  const set = (stack: string, status: string, kind: "plan" | "apply" | "summary" = action) =>
    mock.setJobStatus(pipelineId, `${kind}:${stack}`, status);
  const notes = () => (mr ? mock.mrNotes(`ri/r${id}`, mr.iid) : []);
  return { gl, project, run, pipelineId, event, read, states, deliver, set, mr, notes };
}

const GENERATE = "generate:\n  script: [echo]";

/**
 * A run whose pipeline has no stack jobs of its own: the project's CI starts the generated pipeline
 * (docs/iac.md), a child with the jobs. `only` limits the jobs the child has.
 */
async function childWorld(stacks = ["net", "app"], only = stacks, opts: { mr?: boolean } = {}) {
  const w = await world(stacks, "plan", GENERATE, opts);
  const child = mock.addDownstream(
    w.pipelineId,
    "orch",
    only.flatMap((s) => [`plan:${s}`, `summary:${s}`]),
  );
  /** What GitLab sends for an event of the child pipeline. */
  const childEvent = (over: Record<string, unknown> = {}) =>
    w.event({
      pipelineId: child,
      sourcePipelineId: w.pipelineId,
      sourceProjectId: w.gl.id,
      ...over,
    });
  return {
    ...w,
    child,
    childEvent,
    deliverChild: (over: Record<string, unknown> = {}) => handler(job(childEvent(over))),
    setChild: (stack: string, status: string, kind: "plan" | "summary" = "plan") =>
      mock.setJobStatus(child, `${kind}:${stack}`, status),
  };
}

describe("a plan pipeline's events", () => {
  test("move each stack along its plan job, and note the plan and summary job ids", async () => {
    const w = await world();
    await w.deliver();
    expect(await w.states()).toEqual({ app: "queued", net: "queued" });
    const ids = mock.jobIds(w.pipelineId);
    const stacks = (await w.read()).stacks;
    expect(stacks.map((s) => [s.stack, s.planJobId, s.summaryJobId])).toEqual([
      ["app", ids["plan:app"] as number, ids["summary:app"] as number],
      ["net", ids["plan:net"] as number, ids["summary:net"] as number],
    ]);

    w.set("net", "running");
    await w.deliver({ status: "running" });
    expect(await w.states()).toEqual({ app: "queued", net: "planning" });

    w.set("net", "success");
    w.set("app", "running");
    await w.deliver();
    expect(await w.states()).toEqual({ app: "planning", net: "planned" });

    w.set("app", "failed");
    await w.deliver();
    const app = (await w.read()).stacks.find((s) => s.stack === "app");
    expect([app?.status, app?.error]).toEqual(["failed", "the plan failed"]);
    // the failure reason GitLab gives is not copied: only fixed words are stored
    expect(JSON.stringify(await w.read())).not.toContain("script_failure");
  });

  test("a job that was canceled or skipped ends its stack canceled", async () => {
    const w = await world(["a", "b", "c"]);
    w.set("a", "canceled");
    w.set("b", "skipped");
    w.set("c", "pending");
    await w.deliver();
    expect(await w.states()).toEqual({ a: "canceled", b: "canceled", c: "queued" });
  });

  test("events seen in any order give the same result: the pipeline is read as it is now", async () => {
    const w = await world();
    w.set("net", "success");
    // the event that said `running` arrives after the job has succeeded
    await w.deliver({ status: "running" });
    await w.deliver({ status: "pending" });
    await w.deliver({ status: "success" });
    expect(await w.states()).toEqual({ app: "queued", net: "planned" });
  });

  test("a stack whose events were missed is walked through the states it did not see", async () => {
    const w = await world(["net"]);
    w.set("net", "success");
    await w.deliver();
    expect((await w.read()).stacks[0]?.status).toBe("planned");
  });

  test("the same event twice changes nothing the second time", async () => {
    const w = await world();
    w.set("net", "success");
    await w.deliver();
    const first = await w.read();
    await Bun.sleep(5);
    await w.deliver();
    await w.deliver();
    expect(await w.read()).toEqual(first);
  });

  test("a stack that has an outcome is never moved again, whatever its job later says", async () => {
    const w = await world(["net", "app", "db"]);
    w.set("net", "failed");
    w.set("app", "success");
    w.set("db", "canceled");
    await w.deliver();
    const before = await w.states();
    expect(before).toEqual({ app: "planned", db: "canceled", net: "failed" });
    // a retried job runs and passes, another fails, a third is picked up again
    w.set("net", "success");
    w.set("app", "failed");
    w.set("db", "running");
    await w.deliver();
    expect(await w.states()).toEqual(before);
  });

  test("a finished pipeline with no job for a stack stops that stack, and a running one waits", async () => {
    const w = await world(["net", "web"], "plan", ciFor(["net"]));
    mock.setPipelineStatus(w.pipelineId, "running");
    await w.deliver();
    expect(await w.states()).toEqual({ net: "queued", web: "queued" });
    mock.setPipelineStatus(w.pipelineId, "failed");
    await w.deliver();
    const web = (await w.read()).stacks.find((s) => s.stack === "web");
    expect([web?.status, web?.error]).toEqual(["failed", "no job ran for this stack"]);

    const c = await world(["net", "web"], "plan", ciFor(["net"]));
    mock.setPipelineStatus(c.pipelineId, "canceled");
    await c.deliver();
    expect((await c.states()).web).toBe("canceled");
  });

  test("jobs that are not a stack's plan or summary are not read as one", async () => {
    const w = await world(
      ["net"],
      "plan",
      `${ciFor(["net"])}\nlint:net:\n  script: [echo]\n"plans:net":\n  script: [echo]\n"apply:net":\n  script: [echo]`,
    );
    mock.setJobStatus(w.pipelineId, "lint:net", "failed");
    mock.setJobStatus(w.pipelineId, "plans:net", "success");
    mock.setJobStatus(w.pipelineId, "apply:net", "success");
    await w.deliver();
    expect(await w.states()).toEqual({ net: "queued" });
    // only a plan:<stack> job drives a plan, and the stack row names which job posts its summary
    const ids = mock.jobIds(w.pipelineId);
    const net = (await w.read()).stacks[0];
    expect([net?.planJobId, net?.summaryJobId]).toEqual([
      ids["plan:net"] as number,
      ids["summary:net"] as number,
    ]);
  });

  test("stacks of the run that the pipeline has no job for are left alone until it ends", async () => {
    const w = await world(["net", "web"], "plan", ciFor(["net"]));
    w.set("net", "success");
    await w.deliver();
    expect(await w.states()).toEqual({ net: "planned", web: "queued" });
  });
});

describe("a plan pipeline that starts the generated pipeline", () => {
  test("the child's events move each stack along the child's jobs and note their ids", async () => {
    const w = await childWorld();
    await w.deliverChild();
    expect(await w.states()).toEqual({ app: "queued", net: "queued" });
    const ids = mock.jobIds(w.child);
    expect((await w.read()).stacks.map((s) => [s.stack, s.planJobId, s.summaryJobId])).toEqual([
      ["app", ids["plan:app"] as number, ids["summary:app"] as number],
      ["net", ids["plan:net"] as number, ids["summary:net"] as number],
    ]);
    w.setChild("net", "success");
    w.setChild("app", "running");
    await w.deliverChild();
    expect(await w.states()).toEqual({ app: "planning", net: "planned" });
    w.setChild("app", "failed");
    await w.deliverChild();
    const app = (await w.read()).stacks.find((s) => s.stack === "app");
    expect([app?.status, app?.error]).toEqual(["failed", "the plan failed"]);
  });

  test("the parent's own events read the child's jobs too, and agree", async () => {
    const w = await childWorld();
    w.setChild("net", "success");
    w.setChild("app", "running");
    await w.deliver();
    expect(await w.states()).toEqual({ app: "planning", net: "planned" });
    await w.deliverChild();
    expect(await w.states()).toEqual({ app: "planning", net: "planned" });
  });

  test("a finished pipeline whose child has no job for a stack stops that stack", async () => {
    const w = await childWorld(["net", "web"], ["net"]);
    mock.setPipelineStatus(w.pipelineId, "running");
    await w.deliver();
    expect(await w.states()).toEqual({ net: "queued", web: "queued" });
    mock.setPipelineStatus(w.pipelineId, "failed");
    await w.deliverChild();
    const web = (await w.read()).stacks.find((s) => s.stack === "web");
    expect([web?.status, web?.error]).toEqual(["failed", "no job ran for this stack"]);
  });

  test("the child's event names its parent only as a hint: another project's, another run's and nonsense move nothing", async () => {
    const a = await childWorld(["net"]);
    const b = await childWorld(["net"]);
    a.setChild("net", "success");
    b.setChild("net", "success");
    asked.length = 0;
    for (const hint of [
      { sourceProjectId: a.gl.id + 999 },
      { sourcePipelineId: a.pipelineId + 9999 },
      // b's event naming a's pipeline: looked up under b's project, where it is no run's
      { sourcePipelineId: a.pipelineId },
      { sourcePipelineId: "1", sourceProjectId: "x" },
      { sourcePipelineId: -1 },
      { sourcePipelineId: undefined },
    ]) {
      await handler(job(b.childEvent(hint)));
    }
    expect(asked).toEqual([]);
    expect(await a.states()).toEqual({ net: "queued" });
    expect(await b.states()).toEqual({ net: "queued" });
  });

  test("a child that GitLab does not show adds no jobs and does not stop the others being read", async () => {
    const w = await world(["net"]);
    const child = mock.addDownstream(w.pipelineId, "elsewhere", ["plan:other"]);
    mock.inject({ method: "GET", path: new RegExp(`/pipelines/${child}/jobs`), status: 404 });
    w.set("net", "success");
    await w.deliver();
    expect(await w.states()).toEqual({ net: "planned" });
  });

  test("a child that fails to answer fails the job so the queue retries it", async () => {
    const w = await childWorld(["net"]);
    w.setChild("net", "success");
    mock.inject({
      method: "GET",
      path: new RegExp(`/pipelines/${w.child}/jobs`),
      status: 500,
      times: 1,
    });
    await expect(w.deliverChild()).rejects.toThrow();
    expect(await w.states()).toEqual({ net: "queued" });
    await w.deliverChild();
    expect(await w.states()).toEqual({ net: "planned" });
  });

  test("a pipeline that starts more children than a run makes is dropped, not half read", async () => {
    const w = await world(["net"], "plan", GENERATE);
    for (let i = 0; i < 21; i++) mock.addDownstream(w.pipelineId, `c${i}`, ["plan:net"]);
    mock.setJobStatus(
      mock.addDownstream(w.pipelineId, "last", ["plan:net"]),
      "plan:net",
      "success",
    );
    lines.length = 0;
    await w.deliver();
    expect(await w.states()).toEqual({ net: "queued" });
    expect(lines.some((l) => l.includes("too many child pipelines"))).toBe(true);
  });
});

describe("the merge request note", () => {
  test("is written after an event, then updated in place as the stacks move", async () => {
    const w = await childWorld(["net", "app"], ["net", "app"], { mr: true });
    expect(w.notes()).toEqual([]);
    await w.deliverChild();
    expect(w.notes()).toHaveLength(1);
    expect(w.notes()[0]?.body).toContain("| `net` | queued |");
    const first = w.notes()[0]?.id;

    w.setChild("net", "success");
    await w.deliverChild();
    const ids = mock.jobIds(w.child);
    expect(w.notes()).toHaveLength(1);
    expect(w.notes()[0]?.id).toBe(first);
    const body = w.notes()[0]?.body ?? "";
    expect(body).toContain("| `net` | planned |");
    expect(body).toContain(`/-/jobs/${ids["plan:net"]})`);
    expect(body).toContain("| `app` | queued |");
  });

  test("shows the counts of a summary that was posted before the event", async () => {
    const w = await childWorld(["net"], ["net"], { mr: true });
    w.setChild("net", "success");
    await w.deliverChild();
    await storePlanSummary(t.db, o1, w.project.id, w.run.id, "net", {
      add: 3,
      change: 2,
      destroy: 1,
      resources: [{ address: "aws_s3_bucket.secret_looking", actions: ["create"] }],
    });
    await w.deliverChild();
    const body = w.notes()[0]?.body ?? "";
    expect(body).toContain("| `net` | planned | 3 | 2 | 1 |");
    expect(body).not.toContain("aws_s3_bucket");
  });

  test("is not written for a run that no merge request started", async () => {
    const w = await childWorld(["net"]);
    w.setChild("net", "success");
    mock.requests.splice(0);
    await w.deliverChild();
    expect(mock.requests.some((r) => r.path.includes("/notes"))).toBe(false);
  });

  test("is not written for an event of a run that a newer commit replaced", async () => {
    const w = await childWorld(["net"], ["net"], { mr: true });
    await createRun(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      ref: "main",
      sha: "c".repeat(40),
      stacks: ["net"],
      mergeRequestIid: (w.mr as { iid: number }).iid,
    });
    w.setChild("net", "success");
    await w.deliverChild();
    expect(await w.states()).toEqual({ net: "planned" });
    expect(w.notes()).toEqual([]);
  });

  test("a note that cannot be written does not fail the event, and the next one catches up", async () => {
    const w = await childWorld(["net"], ["net"], { mr: true });
    w.setChild("net", "success");
    mock.inject({ method: "POST", path: /\/notes$/, status: 500, times: 1 });
    lines.length = 0;
    await w.deliverChild();
    expect(await w.states()).toEqual({ net: "planned" });
    expect(w.notes()).toEqual([]);
    expect(lines.some((l) => l.includes("could not update the merge request note"))).toBe(true);
    await w.deliverChild();
    expect(w.notes()[0]?.body).toContain("| `net` | planned |");
  });
});

describe("two events handled at once", () => {
  // `beforeRead` runs after the handler has found the run and before it asks GitLab: another handler's moves land there
  const racing = (beforeRead: () => Promise<unknown>) =>
    runEventHandler({
      db: t.db,
      gitlab: async () => {
        await beforeRead();
        return client();
      },
    });

  test("a stack that another handler moved first is read again and taken the rest of the way", async () => {
    const w = await world(["net"]);
    w.set("net", "success");
    const other = racing(() =>
      moveRunStack(t.db, o1, w.project.id, w.run.id, "net", "queued", "planning"),
    );
    await other(job(w.event()));
    expect(await w.states()).toEqual({ net: "planned" });
  });

  test("a stack that the other handler already finished is left as it ended", async () => {
    const w = await world(["net"]);
    w.set("net", "failed");
    const other = racing(async () => {
      await moveRunStack(t.db, o1, w.project.id, w.run.id, "net", "queued", "planning");
      await moveRunStack(t.db, o1, w.project.id, w.run.id, "net", "planning", "planned");
    });
    await other(job(w.event()));
    // `planned` cannot become `failed`: the plan exists
    expect(await w.states()).toEqual({ net: "planned" });
  });
});

describe("an apply pipeline's events", () => {
  const setApplying = async (w: Awaited<ReturnType<typeof world>>, ...stacks: string[]) => {
    for (const s of stacks) {
      await moveRunStack(t.db, o1, w.project.id, w.run.id, s, "queued", "planning");
      await moveRunStack(t.db, o1, w.project.id, w.run.id, s, "planning", "planned");
      await moveRunStack(t.db, o1, w.project.id, w.run.id, s, "planned", "applying");
    }
  };

  test("end an applying stack applied, failed or failed because it was stopped", async () => {
    const w = await world(["a", "b", "c", "d"], "apply");
    await setApplying(w, "a", "b", "c", "d");
    w.set("a", "success");
    w.set("b", "failed");
    w.set("c", "canceled");
    w.set("d", "running");
    await w.deliver();
    const got = Object.fromEntries(
      (await w.read()).stacks.map((s) => [s.stack, [s.status, s.error]]),
    );
    expect(got).toEqual({
      a: ["applied", null],
      b: ["failed", "the apply failed"],
      c: ["failed", "the apply was canceled"],
      d: ["applying", null],
    });
  });

  test("never take the mutex: a stack that is not applying is not moved by an apply job", async () => {
    const w = await world(["a", "b"], "apply");
    await setApplying(w, "a");
    // `b` is queued here and `a` is applying; both jobs say they ran
    w.set("a", "success");
    w.set("b", "success");
    await w.deliver();
    expect(await w.states()).toEqual({ a: "applied", b: "queued" });
  });

  test("a job that failed does not end a stack that was never applying", async () => {
    const w = await world(["a", "b", "c"], "apply");
    await moveRunStack(t.db, o1, w.project.id, w.run.id, "b", "queued", "planning");
    await moveRunStack(t.db, o1, w.project.id, w.run.id, "c", "queued", "planning");
    await moveRunStack(t.db, o1, w.project.id, w.run.id, "c", "planning", "planned");
    for (const s of ["a", "b", "c"]) w.set(s, "failed");
    await w.deliver();
    expect(await w.states()).toEqual({ a: "queued", b: "planning", c: "planned" });
    expect((await w.read()).stacks.map((s) => s.error)).toEqual([null, null, null]);
  });

  test("a plan pipeline's late event leaves an applying stack alone, even when its plan job failed", async () => {
    const w = await world(["a"]);
    await setApplying(w, "a");
    w.set("a", "failed");
    await w.deliver();
    expect(await w.states()).toEqual({ a: "applying" });
  });

  test("does not read plan or summary jobs, nor record job ids", async () => {
    const w = await world(["a"], "apply", `${applyCi(["a"])}\n${ciFor(["a"])}`);
    await setApplying(w, "a");
    mock.setJobStatus(w.pipelineId, "plan:a", "failed");
    await w.deliver();
    const a = (await w.read()).stacks[0];
    expect([a?.status, a?.planJobId, a?.summaryJobId]).toEqual(["applying", null, null]);
  });
});

describe("events that are not for a run", () => {
  test("a pipeline no run started is ignored without asking GitLab", async () => {
    const w = await world();
    mock.requests.splice(0);
    asked.length = 0;
    await handler(job(w.event({ pipelineId: w.pipelineId + 9999 })));
    expect(asked).toEqual([]);
    expect(mock.requests).toEqual([]);
    expect(await w.states()).toEqual({ app: "queued", net: "queued" });
  });

  test("a project that is not linked, another organization's, and a malformed event are ignored", async () => {
    const w = await world();
    asked.length = 0;
    await handler(job(w.event({ projectId: w.gl.id + 777 })));
    await handler(job(w.event({ organizationId: o2 })));
    for (const bad of [
      { event: "push" },
      { pipelineId: "1" },
      { pipelineId: 0 },
      { organizationId: "x" },
      { connectionId: null },
      { projectId: -1 },
    ]) {
      await handler(job(w.event(bad)));
    }
    await handler(job({}));
    expect(asked).toEqual([]);
    expect(await w.states()).toEqual({ app: "queued", net: "queued" });
  });

  test("a pipeline of the run's project but another project's id does not move the run", async () => {
    const a = await world(["net"]);
    const b = await world(["net"]);
    a.set("net", "success");
    // b's event, naming a's pipeline: it is looked up under b's project, where it is not a run's
    await handler(job(b.event({ pipelineId: a.pipelineId })));
    expect(await a.states()).toEqual({ net: "queued" });
    expect(await b.states()).toEqual({ net: "queued" });
  });
});

describe("when GitLab cannot answer", () => {
  test("a pipeline that is gone, or a token it refuses, drops the event", async () => {
    for (const status of [404, 401, 403]) {
      const w = await world(["net"]);
      mock.inject({ method: "GET", path: /\/pipelines\/\d+$/, status, times: 1 });
      await w.deliver();
      expect(await w.states()).toEqual({ net: "queued" });
    }
  });

  test("any other failure fails the job so the queue retries it, and the retry works", async () => {
    const w = await world(["net"]);
    w.set("net", "success");
    mock.inject({ method: "GET", path: /\/pipelines\/\d+$/, status: 500, times: 1 });
    await expect(w.deliver()).rejects.toThrow();
    expect(await w.states()).toEqual({ net: "queued" });
    mock.inject({ method: "GET", path: /\/jobs/, status: 500, times: 1 });
    await expect(w.deliver()).rejects.toThrow();
    await w.deliver();
    expect(await w.states()).toEqual({ net: "planned" });
  });

  test("a pipeline with more jobs than a run could make is dropped, not half read", async () => {
    const names = Array.from({ length: 1001 }, (_, i) => `x${i}`);
    const w = await world(["net"], "plan", `${ciFor(["net"])}\n${applyCi(names)}`);
    w.set("net", "success");
    await w.deliver();
    expect(await w.states()).toEqual({ net: "queued" });
    expect(lines.some((l) => l.includes("too many jobs"))).toBe(true);
  });
});

describe("what is logged", () => {
  test("a handled event logs its counts, not job names or links", async () => {
    const w = await world(["secret-stack-name"]);
    w.set("secret-stack-name", "success");
    lines.length = 0;
    await w.deliver();
    const text = lines.join("\n");
    expect(text).toContain("run event handled");
    expect(text).not.toContain("secret-stack-name");
    expect(text).not.toContain("/-/jobs/");
  });
});

describe("jobsByStack", () => {
  const j = (id: number, name: string): Job => ({
    id,
    name,
    stage: "s",
    status: "success",
    allowFailure: false,
    failureReason: null,
    webUrl: "",
  });

  test("keeps the newest job of each kind for a stack: a retry is a new job", () => {
    const got = jobsByStack([
      j(5, "plan:net"),
      j(9, "plan:net"),
      j(7, "plan:net"),
      j(3, "summary:net"),
      j(8, "summary:net"),
      j(4, "plan:app:x"),
    ]);
    expect(got.get("net")?.plan?.id).toBe(9);
    expect(got.get("net")?.summary?.id).toBe(8);
    expect(got.get("app:x")?.plan?.id).toBe(4);
  });

  test("leaves out jobs that are not named for a stack and a kind", () => {
    const got = jobsByStack([
      j(1, "lint"),
      j(2, "plan"),
      j(3, "plan:"),
      j(4, "xplan:net"),
      j(5, "Plan:net"),
    ]);
    expect([...got.keys()]).toEqual([]);
  });
});
