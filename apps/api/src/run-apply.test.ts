import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, DomainError, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  type AuditEvent,
  attachRunPipeline,
  audit,
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  createRun,
  createSession,
  getRun,
  moveRunStack,
  recordPipelineRun,
  recordStackJobs,
  runPipelines,
  type Tx,
  upsertUser,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab, type Gitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { PLAN_RETENTION_MS } from "@orch/iac";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { type ApplyDeps, type ApplyRequest, applyRun, mrApplyHandler } from "./run-apply";
import { runEventHandler } from "./run-ingest";
import { hashToken, randomToken } from "./tokens";
import type { JobContext } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let conn1: string;
const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });

const client = () =>
  createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });

const TERRAFORM = [{ tag: "terraform" as const, confidence: "high" as const, evidence: ["a.tf"] }];
const BACKEND = 'terraform {\n  backend "http" {}\n}\n';
type Name = "net" | "app";
const NAMES: Name[] = ["app", "net"];
const PLAN_JOB: Record<Name, number> = { net: 501, app: 502 };
// a stack the run has, and that the repository does not (a stack file removed since)
const GHOST = "ghost";

/** Two stacks, `app` depending on `net`; `applyOn` sets what their `stack.yml` says. */
const repo = (applyOn: Partial<Record<Name, string>> = {}) => ({
  ".gitlab-ci.yml": '"apply:net":\n  script: [echo]\n"apply:app":\n  script: [echo]\n',
  "stacks/net/stack.yml": `name: net\ntool: terraform\nversion: 1.9.0\n${
    applyOn.net ? `apply_on: ${applyOn.net}\n` : ""
  }`,
  "stacks/net/main.tf": BACKEND,
  "stacks/app/stack.yml": `name: app\ntool: terraform\nversion: 1.9.0\ndepends_on: [net]\n${
    applyOn.app ? `apply_on: ${applyOn.app}\n` : ""
  }`,
  "stacks/app/main.tf": BACKEND,
});

interface Opts {
  applyOn?: Partial<Record<Name, string>>;
  /** Where each stack of the run is; planned when left out. */
  states?: Partial<Record<Name, "queued" | "planning" | "planned" | "failed">>;
  /** Stacks whose plan job was never recorded. */
  noPlanJob?: Name[];
  /** The run also has a stack the repository lacks, planned like the others. */
  ghost?: boolean;
  approved?: boolean;
  /** The merge request's target branch (made from `main`); `main` when left out. */
  target?: string;
  mergeRequest?: boolean;
  /** The run is a scheduled drift check of the default branch (it has no merge request). */
  drift?: boolean;
  /** The connection that read the run's plan pipeline is recorded (the apply route needs it). */
  connection?: boolean;
  /** The branch whose head the run was planned at, which the mock can still read: stale when it is not the merge request's. */
  plannedAt?: string;
}

let n = 0;
let edits = 0;
/** A repository with a branch `feature` and an open merge request into `target`, and a run of its two stacks. */
async function world(o: Opts = {}) {
  const id = ++n;
  const path = `ap/p${id}`;
  const gl = mock.addProject({ path, files: repo(o.applyOn) });
  const api = client();
  await api.repository.createBranch(gl.id, "feature", "main");
  if (o.target) await api.repository.createBranch(gl.id, o.target, "main");
  const push = () =>
    api.repository.commitFiles(gl.id, { branch: "feature", message: `edit ${++edits}` }, [
      { action: "update", path: "stacks/net/main.tf", content: `${BACKEND}# edit ${edits}\n` },
    ]);
  await push();
  const project = await createProject(t.db, {
    organizationId: o1,
    name: `p${id}`,
    gitlabProjectId: gl.id,
    detectedTypes: TERRAFORM,
  });
  const mr = await api.mergeRequests.create(gl.id, {
    sourceBranch: "feature",
    targetBranch: o.target ?? "main",
    title: "change",
  });
  mock.setMergeRequest(path, mr.iid, { approved: o.approved ?? true });
  const sha = o.plannedAt
    ? (await api.repository.getBranch(gl.id, o.plannedAt)).commitId
    : ((await api.mergeRequests.get(gl.id, mr.iid)).sha as string);
  const run = await createRun(t.db, {
    organizationId: o1,
    projectId: project.id,
    ref: "feature",
    sha,
    stacks: o.ghost ? [...NAMES, GHOST] : NAMES,
    ...(o.drift ? { kind: "drift" as const } : {}),
    ...(o.mergeRequest === false || o.drift ? {} : { mergeRequestIid: mr.iid }),
  });
  const plan = await api.pipelines.trigger(gl.id, "feature");
  await attachRunPipeline(t.db, {
    organizationId: o1,
    projectId: project.id,
    runId: run.id,
    gitlabPipelineId: plan.id,
    action: "plan",
  });
  if (o.connection !== false) {
    await recordPipelineRun(t.db, {
      organizationId: o1,
      projectId: project.id,
      connectionId: conn1,
      gitlabPipelineId: plan.id,
      iid: plan.iid,
      status: "success",
      ref: "feature",
      sha,
      webUrl: plan.webUrl,
      failedJob: null,
      failureReason: null,
      observedAt: new Date(),
    });
  }
  const move = (
    stack: string,
    from: Parameters<typeof moveRunStack>[5],
    to: typeof from,
    e?: string,
  ) => moveRunStack(t.db, o1, project.id, run.id, stack, from, to, e);
  for (const s of o.ghost ? [...NAMES, GHOST] : NAMES) {
    const to = o.states?.[s as Name] ?? "planned";
    if (to === "failed") await move(s, "queued", "failed", "the plan failed");
    else if (to !== "queued") {
      await move(s, "queued", "planning");
      if (to === "planned") await move(s, "planning", "planned");
    }
    if (!o.noPlanJob?.includes(s as Name)) {
      await recordStackJobs(t.db, o1, project.id, run.id, s, {
        planJobId: s === GHOST ? 599 : PLAN_JOB[s as Name],
      });
    }
  }
  const posts = () =>
    mock.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith(`/projects/${gl.id}/pipeline`),
    ).length;
  const baseline = posts();
  const w = {
    gl,
    api,
    path,
    project,
    mr,
    sha,
    run: async () => {
      const r = await getRun(t.db, o1, project.id, run.id);
      if (!r) throw new Error("run is gone");
      return r;
    },
    id: run.id,
    states: async () => Object.fromEntries((await w.run()).stacks.map((s) => [s.stack, s.status])),
    push,
    at: { organizationId: o1, projectId: project.id, gitlabProjectId: gl.id },
    /** Pipelines started since the world was made. */
    triggered: () => posts() - baseline,
    applyPipelines: async () =>
      (
        await t.db
          .select()
          .from(runPipelines)
          .where(and(eq(runPipelines.runId, run.id), eq(runPipelines.action, "apply")))
      ).map((r) => r.gitlabPipelineId),
    merge: () => mock.setMergeRequest(path, mr.iid, { state: "merged" }),
    notes: () => mock.mrNotes(path, mr.iid),
  };
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

const audited = (tx: Tx, e: AuditEvent) => audit(tx, { actor: { kind: "user", id: "alice" } }, e);
async function apply(
  w: World,
  over: Partial<ApplyRequest> = {},
  deps: Partial<ApplyDeps> = {},
  gitlab: Gitlab = client(),
) {
  return applyRun({ db: t.db, log: logger, ...deps }, gitlab, {
    at: w.at,
    run: await w.run(),
    when: "command",
    audit: audited,
    ...over,
  });
}
/** What a refused apply says: its status and code, and that it left the stacks and GitLab alone. */
async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return { status: e.status, code: e.code, message: e.message };
    throw e;
  }
  throw new Error("the apply was not refused");
}
const PLANNED = { app: "planned", net: "planned" };

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  conn1 = (
    await createConnection(t.db, keys, {
      organizationId: o1,
      type: "gitlab",
      name: "live",
      config: { baseUrl: mock.url },
      token: mock.token,
    })
  ).id;
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

describe("applying a run", () => {
  test("claims the planned stacks, starts one apply pipeline of the saved plans, and audits it", async () => {
    const w = await world();
    const started = await apply(w);
    expect(started).toEqual(["app", "net"]);
    expect(await w.states()).toEqual({ app: "applying", net: "applying" });
    expect(w.triggered()).toBe(1);

    const [id, ...more] = await w.applyPipelines();
    expect(more).toEqual([]);
    // started on the run's branch, with the generated pipeline as a file variable
    expect((await w.api.pipelines.get(w.gl.id, id as number)).ref).toBe("feature");
    const vars = mock.pipelineVariables(id as number) ?? [];
    expect(vars).toHaveLength(1);
    expect(vars[0]).toMatchObject({ key: "ORCH_CHILD_PIPELINE", type: "file" });
    const jobs = Bun.YAML.parse(vars[0]?.value ?? "") as Record<string, { script?: string[] }>;
    expect(
      Object.keys(jobs)
        .filter((k) => k.includes(":"))
        .sort(),
    ).toEqual(["apply:app", "apply:net"]);
    // each applies the plan of its own plan job
    expect(JSON.stringify(jobs["apply:net"])).toContain(`jobs/${PLAN_JOB.net}/artifacts`);
    expect(JSON.stringify(jobs["apply:app"])).toContain(`jobs/${PLAN_JOB.app}/artifacts`);

    const [row] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "run.apply"), eq(auditEvents.resourceId, w.id)));
    expect(row).toMatchObject({
      actorKind: "user",
      actorId: "alice",
      organizationId: o1,
      projectId: w.project.id,
      resourceType: "run",
    });
    expect(row?.metadata).toEqual({
      ref: "feature",
      sha: w.sha,
      mergeRequestIid: w.mr.iid,
      when: "command",
      pipelineId: id,
      // an open request's pipeline runs the commit that was planned
      pipelineSha: w.sha,
      stackCount: 2,
      stacks: ["app", "net"],
    });
  });

  test("applies only the stacks named, when what they depend on is applied or named too", async () => {
    const w = await world();
    expect(await apply(w, { stacks: ["net"] })).toEqual(["net"]);
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
    const [id] = await w.applyPipelines();
    const jobs = Bun.YAML.parse(mock.pipelineVariables(id as number)?.[0]?.value ?? "") as object;
    expect(Object.keys(jobs).filter((k) => k.startsWith("apply:"))).toEqual(["apply:net"]);
  });

  test("a stack is not applied before the stack it depends on", async () => {
    const w = await world();
    const e = await refused(apply(w, { stacks: ["app"] }));
    expect(e).toMatchObject({ status: 409, code: "dependency_not_applied" });
    expect(e.message).toContain("app");
    expect(e.message).toContain("net");
    expect(await w.states()).toEqual(PLANNED);
    expect(w.triggered()).toBe(0);
  });

  test("a stack whose dependency has been applied may follow", async () => {
    const w = await world();
    await apply(w, { stacks: ["net"] });
    await moveRunStack(t.db, o1, w.project.id, w.id, "net", "applying", "applied");
    expect(await apply(w, { stacks: ["app"] })).toEqual(["app"]);
    expect(await w.states()).toEqual({ app: "applying", net: "applied" });
  });

  test("names a stack the run does not have: nothing is asked of GitLab", async () => {
    const w = await world();
    const before = mock.requests.length;
    const e = await refused(apply(w, { stacks: ["net", "other"] }));
    expect(e).toMatchObject({ status: 422, code: "unknown_stack" });
    expect(e.message).toContain("other");
    expect(mock.requests.length).toBe(before);
    expect(await w.states()).toEqual(PLANNED);
  });

  test("a run that has no merge request is not applied: nobody approved it", async () => {
    const w = await world({ mergeRequest: false });
    expect(await refused(apply(w))).toMatchObject({ status: 409, code: "no_merge_request" });
    expect(w.triggered()).toBe(0);
  });

  test("a drift run is never applied, whichever way it is asked for, and nothing is started", async () => {
    for (const when of ["command", "merge"] as const) {
      const w = await world({ drift: true, applyOn: { net: "merge", app: "merge" } });
      const before = mock.requests.length;
      expect(await refused(apply(w, { when }))).toMatchObject({
        status: 409,
        code: "drift_run",
      });
      expect(mock.requests.length).toBe(before);
      expect(w.triggered()).toBe(0);
      expect(await w.states()).toEqual(PLANNED);
    }
  });

  test("a stack that is not planned is refused, and none of the others is started", async () => {
    const w = await world({ states: { app: "failed" } });
    const e = await refused(apply(w, { stacks: ["app", "net"] }));
    expect(e).toMatchObject({ status: 409, code: "not_planned" });
    expect(e.message).toContain("app");
    expect(await w.states()).toEqual({ app: "failed", net: "planned" });
    expect(w.triggered()).toBe(0);
    // still planning: wait for the plan
    const q = await world({ states: { net: "planning" } });
    const waiting = await refused(apply(q, { stacks: ["app", "net"] }));
    expect(waiting).toMatchObject({ status: 409, code: "not_planned" });
    expect(waiting.message).toContain("not finished planning");
  });

  test("with no stacks named, the stacks that are planned are applied and the rest are left as they are", async () => {
    const w = await world({ states: { app: "failed" } });
    expect(await apply(w)).toEqual(["net"]);
    expect(await w.states()).toEqual({ app: "failed", net: "applying" });
    // asking again names nothing that is planned
    const again = await refused(apply(w));
    expect(again).toMatchObject({ status: 409, code: "not_planned" });
    expect(again.message).toContain("No stack");
    expect(w.triggered()).toBe(1);
  });

  test("the stacks are claimed in one order, whatever order they are named in", async () => {
    const w = await world();
    expect(await apply(w, { stacks: ["net", "app"] })).toEqual(["app", "net"]);
  });

  test("a stack the repository no longer has cannot be applied: no pipeline is made, the stack stays planned", async () => {
    const w = await world({ ghost: true });
    const e = await refused(apply(w, { stacks: [GHOST] }));
    expect(e).toMatchObject({ status: 422, code: "cannot_generate" });
    expect(await w.states()).toEqual({ ...PLANNED, [GHOST]: "planned" });
    expect(w.triggered()).toBe(0);
  });

  test("a stack with no recorded plan job is refused", async () => {
    const w = await world({ noPlanJob: ["net"] });
    expect(await refused(apply(w))).toMatchObject({ status: 409, code: "no_plan" });
    expect(await w.states()).toEqual(PLANNED);
    expect(w.triggered()).toBe(0);
  });

  test("a plan older than its artifact lives is refused, one inside that time is not", async () => {
    const w = await world();
    const later = (ms: number) => ({ now: () => new Date(Date.now() + ms) });
    expect(await refused(apply(w, {}, later(PLAN_RETENTION_MS + 60_000)))).toMatchObject({
      status: 409,
      code: "plan_expired",
    });
    expect(w.triggered()).toBe(0);
    expect(await apply(w, {}, later(PLAN_RETENTION_MS - 60_000))).toEqual(["app", "net"]);
  });

  describe("the merge request", () => {
    test("must be at the commit that was planned: a push since makes the plan stale", async () => {
      const w = await world();
      await w.push();
      expect(await refused(apply(w))).toMatchObject({ status: 409, code: "stale_plan" });
      expect(await w.states()).toEqual(PLANNED);
      expect(w.triggered()).toBe(0);
    });

    test("must be approved", async () => {
      const w = await world({ approved: false });
      expect(await refused(apply(w))).toMatchObject({ status: 409, code: "not_approved" });
      expect(w.triggered()).toBe(0);
      mock.setMergeRequest(w.path, w.mr.iid, { approved: true });
      expect(await apply(w)).toEqual(["app", "net"]);
    });

    test("must be mergeable, whatever GitLab says is in the way", async () => {
      const w = await world();
      for (const status of ["conflict", "ci_must_pass", "discussions_not_resolved", "checking"]) {
        mock.setMergeRequest(w.path, w.mr.iid, { mergeStatus: status });
        expect(await refused(apply(w)), status).toMatchObject({
          status: 409,
          code: "not_mergeable",
        });
      }
      expect(w.triggered()).toBe(0);
    });

    test("must not be closed", async () => {
      const w = await world();
      mock.setMergeRequest(w.path, w.mr.iid, { state: "closed" });
      expect(await refused(apply(w))).toMatchObject({ status: 409, code: "not_open" });
      expect(w.triggered()).toBe(0);
    });

    test("is asked about before the stacks are claimed, and its trouble leaves the stacks planned", async () => {
      const w = await world();
      mock.inject({ method: "GET", path: /merge_requests\/\d+$/, status: 500 });
      await expect(apply(w)).rejects.toThrow();
      expect(await w.states()).toEqual(PLANNED);
      expect(w.triggered()).toBe(0);
    });

    test("one that is merged is applied from the target branch, and is not asked for approval", async () => {
      const w = await world({ approved: false });
      w.merge();
      const before = mock.requests.length;
      expect(await apply(w)).toEqual(["app", "net"]);
      const [id] = await w.applyPipelines();
      expect((await w.api.pipelines.get(w.gl.id, id as number)).ref).toBe("main");
      expect(mock.requests.slice(before).some((r) => r.path.endsWith("/approvals"))).toBe(false);
    });

    test("one merged into a branch that is not the default is not applied", async () => {
      const w = await world({ target: "release" });
      w.merge();
      expect(await refused(apply(w))).toMatchObject({ status: 409, code: "not_default_branch" });
      expect(w.triggered()).toBe(0);
    });

    test("one that was merged at another commit than the plan's is stale", async () => {
      const w = await world();
      await w.push();
      w.merge();
      expect(await refused(apply(w))).toMatchObject({ status: 409, code: "stale_plan" });
    });
  });

  describe("twice", () => {
    test("a second apply of the same stacks is refused, and starts nothing", async () => {
      const w = await world();
      await apply(w);
      const e = await refused(apply(w));
      expect(e).toMatchObject({ status: 409, code: "not_planned" });
      expect(w.triggered()).toBe(1);
      expect(await w.applyPipelines()).toHaveLength(1);
    });

    test("two at once: one starts the pipeline, the other finds the stacks taken", async () => {
      const w = await world();
      const results = await Promise.allSettled([apply(w), apply(w)]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(DomainError);
      expect((lost.reason as DomainError).status).toBe(409);
      expect(w.triggered()).toBe(1);
      expect(await w.applyPipelines()).toHaveLength(1);
      expect(await w.states()).toEqual({ app: "applying", net: "applying" });
    });

    test("another run applying the same stack of the project holds it: nothing is started and none is claimed", async () => {
      const w = await world();
      const other = await createRun(t.db, {
        organizationId: o1,
        projectId: w.project.id,
        ref: "other",
        sha: "d".repeat(40),
        stacks: ["net"],
      });
      for (const [from, to] of [
        ["queued", "planning"],
        ["planning", "planned"],
        ["planned", "applying"],
      ] as const) {
        await moveRunStack(t.db, o1, w.project.id, other.id, "net", from, to);
      }
      const e = await refused(apply(w));
      expect(e).toMatchObject({ status: 409, code: "apply_in_progress" });
      expect(e.message).toContain("net");
      expect(w.triggered()).toBe(0);
      // the claim of `app` went with it
      expect(await w.states()).toEqual(PLANNED);
    });

    test("once the other apply has ended, the stack may be applied again by a later run", async () => {
      const w = await world();
      await apply(w);
      for (const s of NAMES) {
        await moveRunStack(t.db, o1, w.project.id, w.id, s, "applying", "applied");
      }
      const next = await world();
      expect(await apply(next)).toEqual(["app", "net"]);
    });
  });

  describe("when GitLab does not cooperate", () => {
    test("a pipeline it would not start leaves the stacks planned, with a fixed message", async () => {
      const w = await world();
      mock.inject({
        method: "POST",
        path: new RegExp(`/projects/${w.gl.id}/pipeline$`),
        status: 400,
      });
      const e = await refused(apply(w));
      expect(e).toMatchObject({ status: 422, code: "gitlab_refused" });
      expect(e.message).not.toContain("injected");
      expect(await w.states()).toEqual(PLANNED);
      expect(await w.applyPipelines()).toEqual([]);
      const rows = await t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, w.id));
      expect(rows.filter((r) => r.action === "run.apply")).toEqual([]);
      // and it can be tried again
      expect(await apply(w)).toEqual(["app", "net"]);
    });

    test("a server error is thrown for the caller to retry, with the stacks planned", async () => {
      const w = await world();
      mock.inject({
        method: "POST",
        path: new RegExp(`/projects/${w.gl.id}/pipeline$`),
        status: 500,
      });
      await expect(apply(w)).rejects.toThrow();
      expect(await w.states()).toEqual(PLANNED);
    });

    test("a push that lands while the pipeline starts makes the plan stale: the pipeline is stopped and the stacks stay planned", async () => {
      const w = await world();
      const base = client();
      let started = 0;
      const racing: Gitlab = {
        ...base,
        pipelines: {
          ...base.pipelines,
          trigger: async (...args: Parameters<Gitlab["pipelines"]["trigger"]>) => {
            await w.push();
            const p = await base.pipelines.trigger(...args);
            started = p.id;
            return p;
          },
        },
      };
      expect(await refused(apply(w, {}, {}, racing))).toMatchObject({
        status: 409,
        code: "stale_plan",
      });
      expect(await w.states()).toEqual(PLANNED);
      expect(await w.applyPipelines()).toEqual([]);
      expect((await w.api.pipelines.get(w.gl.id, started)).status).toBe("canceled");
    });

    test("the note is refreshed, and a note that cannot be written does not undo the apply", async () => {
      const w = await world();
      await apply(w);
      const [note] = w.notes();
      expect(note?.body).toContain("| `net` | applying |");
      expect(note?.body).toContain("| `app` | applying |");

      const v = await world();
      mock.inject({ method: "POST", path: /merge_requests\/\d+\/notes$/, status: 500 });
      expect(await apply(v)).toEqual(["app", "net"]);
      expect(await v.states()).toEqual({ app: "applying", net: "applying" });
    });
  });

  describe("what is left of a failed apply", () => {
    const deliver = async (w: World, pipelineId: number) =>
      runEventHandler({ db: t.db, gitlab: async () => client() })({
        id: "job",
        queue: WEBHOOK_QUEUE,
        payload: {
          event: "pipeline",
          organizationId: o1,
          connectionId: conn1,
          projectId: w.gl.id,
          pipelineId,
          status: "running",
          ref: "feature",
        },
        attempt: 1,
        maxAttempts: 5,
        log: logger,
        signal: new AbortController().signal,
      } satisfies JobContext);

    test("a failed apply job leaves its stack failed with the reason, the other applied, and frees the stack for a later run", async () => {
      const w = await world();
      await apply(w);
      const [id] = (await w.applyPipelines()) as [number];
      mock.setJobStatus(id, "apply:net", "failed");
      mock.setJobStatus(id, "apply:app", "success");
      await deliver(w, id);
      const stacks = (await w.run()).stacks.map((s) => [s.stack, s.status, s.error]);
      expect(stacks).toEqual([
        ["app", "applied", null],
        ["net", "failed", "the apply failed"],
      ]);
      // a finished run cannot be applied again ...
      expect(await refused(apply(w))).toMatchObject({ status: 409, code: "not_planned" });
      // ... and the failed stack is no longer held against another run
      const next = await world();
      expect(await apply(next, { stacks: ["net"] })).toEqual(["net"]);
    });
  });
});

describe("applying on merge", () => {
  test("applies the stacks that opted in and leaves the others planned", async () => {
    const w = await world({ applyOn: { net: "merge" } });
    w.merge();
    expect(await apply(w, { when: "merge" })).toEqual(["net"]);
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
    const [row] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "run.apply"), eq(auditEvents.resourceId, w.id)));
    expect(row?.metadata).toMatchObject({ when: "merge", stacks: ["net"] });
  });

  test("does nothing when no stack opted in", async () => {
    const w = await world();
    w.merge();
    expect(await apply(w, { when: "merge" })).toEqual([]);
    expect(await w.states()).toEqual(PLANNED);
    expect(w.triggered()).toBe(0);
  });

  test("only for a merge request that is merged", async () => {
    const w = await world({ applyOn: { net: "merge" } });
    expect(await refused(apply(w, { when: "merge" }))).toMatchObject({
      status: 409,
      code: "not_merged",
    });
    expect(w.triggered()).toBe(0);
  });

  test("a stack that has not finished planning is refused, so that the merge request says so", async () => {
    const w = await world({ applyOn: { net: "merge" }, states: { net: "planning" } });
    w.merge();
    expect(await refused(apply(w, { when: "merge" }))).toMatchObject({
      status: 409,
      code: "not_planned",
    });
  });

  test("a stack that opted in is not applied before one that did not and that it depends on", async () => {
    const w = await world({ applyOn: { app: "merge" } });
    w.merge();
    expect(await refused(apply(w, { when: "merge" }))).toMatchObject({
      status: 409,
      code: "dependency_not_applied",
    });
  });

  test("stacks already applying, applied or failed are not asked about again", async () => {
    const w = await world({ applyOn: { net: "merge", app: "merge" } });
    w.merge();
    expect(await apply(w, { when: "merge" })).toEqual(["app", "net"]);
    expect(await apply(w, { when: "merge" })).toEqual([]);
    expect(w.triggered()).toBe(1);
  });
});

describe("the merge event handler", () => {
  const handler = (ctx: JobContext) =>
    mrApplyHandler({ db: t.db, gitlab: async () => client() })(ctx);
  const job = (w: World, over: Record<string, unknown> = {}): JobContext => ({
    id: "job-7",
    queue: WEBHOOK_QUEUE,
    payload: {
      event: "merge_request",
      organizationId: o1,
      connectionId: conn1,
      projectId: w.gl.id,
      iid: w.mr.iid,
      action: "merge",
      ...over,
    },
    attempt: 1,
    maxAttempts: 5,
    log: logger,
    signal: new AbortController().signal,
  });

  test("applies what opted in, as the job, and a repeated event starts nothing more", async () => {
    const w = await world({ applyOn: { net: "merge" } });
    w.merge();
    await handler(job(w));
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
    await handler(job(w));
    expect(w.triggered()).toBe(1);
    const [row] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "run.apply"), eq(auditEvents.resourceId, w.id)));
    expect(row).toMatchObject({ actorKind: "job", actorId: "job-7" });
  });

  test("ignores events that are not merges, without asking GitLab", async () => {
    const w = await world({ applyOn: { net: "merge" } });
    w.merge();
    const before = mock.requests.length;
    for (const action of ["open", "update", "close", "approved", "reopen"]) {
      await handler(job(w, { action }));
    }
    await handler(job(w, { event: "pipeline" }));
    await handler(job(w, { iid: "x" }));
    expect(mock.requests.length).toBe(before);
    expect(await w.states()).toEqual(PLANNED);
  });

  test("ignores a project not seen to hold Terraform and a merge request with no run", async () => {
    const w = await world({ applyOn: { net: "merge" } });
    w.merge();
    const before = mock.requests.length;
    await handler(job(w, { projectId: w.gl.id + 100_000 }));
    await handler(job(w, { iid: w.mr.iid + 1 }));
    expect(mock.requests.length).toBe(before);
    expect(w.triggered()).toBe(0);
  });

  test("says nothing when no stack opted in, even if the plan is stale; says so when one did", async () => {
    const quiet = await world({ plannedAt: "main" });
    quiet.merge();
    await handler(job(quiet));
    expect(quiet.notes()).toEqual([]);
    expect(quiet.triggered()).toBe(0);
    const opted = await world({ applyOn: { net: "merge" }, plannedAt: "main" });
    opted.merge();
    await handler(job(opted));
    expect(opted.notes()[0]?.body).toContain("plan it again");
    expect(opted.triggered()).toBe(0);
  });

  test("says on the merge request why nothing was applied", async () => {
    const w = await world({ applyOn: { net: "merge" }, states: { net: "planning" } });
    w.merge();
    await handler(job(w));
    const [note] = w.notes();
    expect(note?.body).toContain("Not applied on merge");
    expect(note?.body).toContain("net");
    expect(await w.states()).toEqual({ app: "planned", net: "planning" });
    expect(w.triggered()).toBe(0);
  });

  test("drops an event whose merge request is gone, and fails the job on any other trouble", async () => {
    const w = await world({ applyOn: { net: "merge" } });
    w.merge();
    mock.inject({ method: "GET", path: /merge_requests\/\d+$/, status: 404 });
    await handler(job(w));
    expect(w.triggered()).toBe(0);
    mock.inject({ method: "GET", path: /merge_requests\/\d+$/, status: 500 });
    await expect(handler(job(w))).rejects.toThrow();
    // the next delivery finds everything as it was
    await handler(job(w));
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
  });
});

describe("the apply route", () => {
  const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();
  const people = {} as Record<"alice" | "bob" | "carol" | "erin", { cookie: string }>;
  type Who = keyof typeof people | null;
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
    let gitlabId = 700;
    for (const name of ["alice", "bob", "carol", "erin"] as const) {
      const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
      const session = randomToken();
      await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
      people[name] = { cookie: `orch_session=${session}` };
    }
    roleTable.set(701, { orgRoles: { [o1]: "admin" }, projectRoles: {} }); // alice: maintainer
    roleTable.set(702, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob: developer
    roleTable.set(703, { orgRoles: { [o1]: "viewer" }, projectRoles: {} }); // carol: reporter
    // erin: nothing
    app = makeApp(keys);
  });

  async function call(who: Who, w: World, body: unknown = {}, a = app, runId = w.id) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (who) headers.cookie = people[who].cookie;
    const res = await a.handle(
      new Request(
        `http://localhost/organizations/${o1}/projects/${w.project.id}/runs/${runId}/apply`,
        { method: "POST", headers, body: JSON.stringify(body) },
      ),
    );
    const text = await res.text();
    return {
      status: res.status,
      text,
      // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
      json: (text ? JSON.parse(text) : undefined) as any,
    };
  }
  const applied = (w: World) =>
    t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "run.apply"), eq(auditEvents.resourceId, w.id)));

  test("a maintainer starts the apply: the run is returned with its stacks applying, and audited as them", async () => {
    const w = await world();
    const res = await call("alice", w);
    expect(res.status).toBe(202);
    expect(res.json.id).toBe(w.id);
    expect(
      res.json.stacks.map((s: { name: string; status: string }) => [s.name, s.status]),
    ).toEqual([
      ["app", "applying"],
      ["net", "applying"],
    ]);
    const rows = await applied(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorKind: "user", projectId: w.project.id });
    expect(w.triggered()).toBe(1);
  });

  test("a developer or a reporter may not, someone with no role cannot tell it exists; nothing is started", async () => {
    const w = await world();
    for (const who of ["bob", "carol"] as const) {
      const res = await call(who, w);
      expect([who, res.status, res.json.code]).toEqual([who, 403, "forbidden"]);
    }
    expect((await call("erin", w)).status).toBe(404);
    expect((await call(null, w)).status).toBe(401);
    expect(w.triggered()).toBe(0);
    expect(await w.states()).toEqual(PLANNED);
    expect(await applied(w)).toEqual([]);
  });

  test("a run that is not this project's, or does not exist, is not found", async () => {
    const w = await world();
    const other = await world();
    expect((await call("alice", w, {}, app, other.id)).status).toBe(404);
    expect((await call("alice", w, {}, app, "00000000-0000-4000-8000-000000000009")).status).toBe(
      404,
    );
    expect(other.triggered() + w.triggered()).toBe(0);
  });

  test("a stack named may be applied alone; a stack the run lacks is a 422", async () => {
    const w = await world();
    expect((await call("alice", w, { stacks: ["nope"] })).status).toBe(422);
    const res = await call("alice", w, { stacks: ["net"] });
    expect(res.status).toBe(202);
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
  });

  test("a body that is not a list of stacks is refused with nothing started", async () => {
    const w = await world();
    for (const body of [{ stacks: [] }, { stacks: "net" }, { stacks: ["net", "net"] }, { x: 1 }]) {
      expect([JSON.stringify(body), (await call("alice", w, body)).status]).toEqual([
        JSON.stringify(body),
        422,
      ]);
    }
    expect(w.triggered()).toBe(0);
  });

  test("a failed precondition is a 409 with its code, and a second request finds the stacks taken", async () => {
    const stale = await world();
    await stale.push();
    const res = await call("alice", stale);
    expect([res.status, res.json.code]).toEqual([409, "stale_plan"]);

    const w = await world();
    expect((await call("alice", w)).status).toBe(202);
    const again = await call("alice", w);
    expect([again.status, again.json.code]).toEqual([409, "not_planned"]);
    expect(w.triggered()).toBe(1);
  });

  test("without the master keys it cannot open a connection, and says so", async () => {
    const w = await world();
    const res = await call("alice", w, {}, makeApp(undefined));
    expect(res.status).toBe(503);
    expect(w.triggered()).toBe(0);
    // the keys are asked for before anything is read: the operator's problem comes first
    const bare = await world({ connection: false });
    expect((await call("alice", bare, {}, makeApp(undefined))).status).toBe(503);
  });

  test("a run no connection has read is not applied", async () => {
    const w = await world({ connection: false });
    const res = await call("alice", w);
    expect([res.status, res.json.code]).toEqual([409, "no_connection"]);
    expect(await w.states()).toEqual(PLANNED);
  });

  test("a merge request GitLab no longer has is a 422, and GitLab failing is a 502: fixed words, stacks left planned", async () => {
    const w = await world();
    mock.inject({ method: "GET", path: /merge_requests\/\d+$/, status: 404 });
    const gone = await call("alice", w);
    expect([gone.status, gone.json.code]).toEqual([422, "gitlab_gone"]);
    // the connection retries once
    mock.inject({ method: "GET", path: /merge_requests\/\d+$/, status: 500, times: 2 });
    const down = await call("alice", w);
    expect([down.status, down.json.code]).toEqual([502, "gitlab_failed"]);
    expect(down.text).not.toContain("injected");
    expect(await w.states()).toEqual(PLANNED);
  });

  test("shows no token, no plan and no GitLab text", async () => {
    const w = await world();
    mock.inject({
      method: "POST",
      path: new RegExp(`/projects/${w.gl.id}/pipeline$`),
      status: 400,
    });
    const res = await call("alice", w);
    expect(res.status).toBe(422);
    expect(res.text).not.toContain(mock.token);
    expect(res.text).not.toContain("injected");
    expect(lines.join("\n")).not.toContain(mock.token);
  });
});
