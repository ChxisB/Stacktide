import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, DomainError, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  type AuditEvent,
  allCostLimits,
  allPools,
  approveChangeRequest,
  attachRunPipeline,
  audit,
  auditEvents,
  changeRequests,
  createApplyRequest,
  createConnection,
  createEnvironment,
  createOrganization,
  createPolicySet,
  createPool,
  createProject,
  createRun,
  createSession,
  deleteCostLimit,
  deletePolicySet,
  deletePool,
  dismissFinding,
  getRun,
  listFindings,
  listPolicySets,
  moveRunStack,
  type Person,
  recordPipelineRun,
  recordStackJobs,
  resolveMissing,
  runPipelines,
  setCostLimit,
  setEnvironmentProtection,
  setSecretGate,
  storePlanSummary,
  storePolicyVerdict,
  type Tx,
  updatePool,
  upsertFindings,
  upsertUser,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab, type Gitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { PLAN_RETENTION_MS } from "@orch/iac";
import { and, eq } from "drizzle-orm";
import { type AppDeps, createApp } from "./app";
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
const repo = (
  applyOn: Partial<Record<Name, string>> = {},
  tags: Partial<Record<Name, string[]>> = {},
  environment: Partial<Record<Name, string>> = {},
  pool: Partial<Record<Name, string>> = {},
  state: Partial<Record<Name, string>> = {},
) => ({
  ".gitlab-ci.yml": '"apply:net":\n  script: [echo]\n"apply:app":\n  script: [echo]\n',
  "stacks/net/stack.yml": `name: net\ntool: terraform\nversion: 1.9.0\n${
    applyOn.net ? `apply_on: ${applyOn.net}\n` : ""
  }${tags.net ? `tags: [${tags.net.join(", ")}]\n` : ""}${
    environment.net ? `environment: ${environment.net}\n` : ""
  }${pool.net ? `pool: ${pool.net}\n` : ""}${state.net ? `state: ${state.net}\n` : ""}`,
  "stacks/net/main.tf": BACKEND,
  "stacks/app/stack.yml": `name: app\ntool: terraform\nversion: 1.9.0\ndepends_on: [net]\n${
    applyOn.app ? `apply_on: ${applyOn.app}\n` : ""
  }${tags.app ? `tags: [${tags.app.join(", ")}]\n` : ""}${
    environment.app ? `environment: ${environment.app}\n` : ""
  }`,
  "stacks/app/main.tf": BACKEND,
});

interface Opts {
  applyOn?: Partial<Record<Name, string>>;
  /** The `tags` of each stack's `stack.yml`; policy sets attach to them. */
  tags?: Partial<Record<Name, string[]>>;
  /** The `environment` of each stack's `stack.yml`: the platform environment whose variables it plans with. */
  environment?: Partial<Record<Name, string>>;
  /** The `pool` of each stack's `stack.yml`: the worker pool whose runners its jobs ask for. */
  pool?: Partial<Record<Name, string>>;
  /** The `state` of each stack's `stack.yml`: where its Terraform state lives. */
  state?: Partial<Record<Name, string>>;
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
  const gl = mock.addProject({
    path,
    files: repo(o.applyOn, o.tags, o.environment, o.pool, o.state),
  });
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

const asker: Person = { kind: "user", id: "bob", ref: "user:bob" };
const approver: Person = { kind: "user", id: "alice", ref: "user:alice" };
/** A protected environment in the world's project. */
async function guard(w: World, slug = "prod") {
  const env = await createEnvironment(t.db, {
    organizationId: o1,
    projectId: w.project.id,
    name: slug,
    slug,
  });
  expect(await setEnvironmentProtection(t.db, o1, w.project.id, env.id, true)).toBeDefined();
  return env;
}
/** A request to apply `stacks` (at the plan jobs given, or the real ones), approved by someone else unless left open. */
async function approval(
  w: World,
  env: { id: string },
  over: { runId?: string; stacks?: Record<string, number>; open?: boolean } = {},
) {
  const at = { organizationId: o1, projectId: w.project.id, environmentId: env.id };
  const stacks = over.stacks ?? { app: PLAN_JOB.app, net: PLAN_JOB.net };
  const made = await createApplyRequest(t.db, {
    ...at,
    kind: "iac_apply",
    subject: { runId: over.runId ?? w.id, stacks },
    diff: Object.keys(stacks).map((key) => ({ action: "apply" as const, key })),
    author: asker,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  if (!over.open) {
    expect((await approveChangeRequest(t.db, keys, at, made.id, approver)).result).toBe("approved");
  }
  return made.id;
}
const statusOf = async (id: string) =>
  (await t.db.select().from(changeRequests).where(eq(changeRequests.id, id)))[0]?.status;

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

describe("applying on a worker pool (POOL-3)", () => {
  const pool = (name: string, over: Record<string, unknown> = {}) =>
    t.db.transaction((tx) =>
      createPool(tx, { organizationId: o1, name, tags: [`${name}-runner`], ...over }),
    );
  afterEach(async () => {
    for (const p of await allPools(t.db, o1)) {
      await t.db.transaction(async (tx) => {
        await updatePool(tx, o1, p.id, { isDefault: false });
        await deletePool(tx, o1, p.id);
      });
    }
  });
  const applyJobs = async (w: World) => {
    const [id] = await w.applyPipelines();
    const yaml = mock.pipelineVariables(id as number)?.[0]?.value ?? "";
    const jobs = Bun.YAML.parse(yaml) as Record<string, { tags?: string[] }>;
    return Object.fromEntries(Object.entries(jobs).map(([name, j]) => [name, j.tags]));
  };

  test("the apply asks for the runners of the stack's pool, and of the default for a stack that names none", async () => {
    await pool("prod");
    await pool("dev", { isDefault: true });
    const w = await world({ pool: { net: "prod" } });
    await apply(w);
    expect(await applyJobs(w)).toMatchObject({
      "apply:net": ["prod-runner"],
      "apply:app": ["dev-runner"],
    });
  });

  test("with no pools the apply has no tags, as before", async () => {
    const w = await world();
    await apply(w);
    const tags = await applyJobs(w);
    expect(tags["apply:net"]).toBeUndefined();
    expect(tags["apply:app"]).toBeUndefined();
  });

  test("a stack whose pool is gone or switched off is refused before anything is claimed or started", async () => {
    const w = await world({ pool: { net: "gone" } });
    const e = await refused(apply(w));
    expect(e).toMatchObject({ status: 422, code: "cannot_generate" });
    expect(e.message).toContain("the organization does not have");
    expect(w.triggered()).toBe(0);
    expect(await w.states()).toEqual(PLANNED);
    await pool("gone", { enabled: false });
    expect((await refused(apply(w))).message).toContain("which is disabled");
    expect(w.triggered()).toBe(0);
    expect(await w.states()).toEqual(PLANNED);
  });
});

describe("applying a stack whose state is on the platform (STATE-5)", () => {
  // its jobs run orch, so the tool image holds it; and an apply must be told where the platform is
  const images = { terraform: "registry.example.com/platform/terraform-orch" };
  const platform = { apiUrl: "https://orch.example.com", audience: "orch.example.com" };
  const jobsOf = async (w: World) => {
    const [id] = await w.applyPipelines();
    const yaml = mock.pipelineVariables(id as number)?.[0]?.value ?? "";
    // biome-ignore lint/suspicious/noExplicitAny: a generated job read back from YAML
    return Bun.YAML.parse(yaml) as Record<string, any>;
  };
  const signsIn = (job: {
    script: string[];
    id_tokens?: unknown;
    variables?: Record<string, string>;
  }) =>
    job.script.includes('login="$(orch ci login --state)"') &&
    job.id_tokens !== undefined &&
    job.variables?.ORCH_API_URL === "https://orch.example.com";

  test("the apply job of the stack signs in for the state and locks it; the stack on GitLab's state is as it was", async () => {
    const w = await world({ state: { net: "orch" } });
    await apply(w, {}, { images, platform });
    const jobs = await jobsOf(w);
    expect(signsIn(jobs["apply:net"])).toBe(true);
    expect(jobs["apply:net"].script).toContain(
      'export TF_HTTP_LOCK_ADDRESS="$TF_HTTP_ADDRESS/lock" TF_HTTP_LOCK_METHOD=POST TF_HTTP_UNLOCK_ADDRESS="$TF_HTTP_ADDRESS/lock" TF_HTTP_UNLOCK_METHOD=DELETE',
    );
    expect(jobs["apply:app"].variables.TF_HTTP_PASSWORD).toBe("$CI_JOB_TOKEN");
    expect(signsIn(jobs["apply:app"])).toBe(false);
  });

  test("without the platform's address and audience it is refused before anything is claimed or started", async () => {
    const w = await world({ state: { net: "orch" } });
    const e = await refused(apply(w, {}, { images }));
    expect(e).toMatchObject({ status: 422, code: "cannot_generate" });
    expect(e.message).toContain("pass platform");
    expect(w.triggered()).toBe(0);
    expect(await w.states()).toEqual(PLANNED);
  });

  test("without an image that holds orch it is refused the same way", async () => {
    const w = await world({ state: { net: "orch" } });
    const e = await refused(apply(w, {}, { platform }));
    expect(e).toMatchObject({ status: 422, code: "cannot_generate" });
    expect(e.message).toContain("an image with terraform and orch");
    expect(w.triggered()).toBe(0);
    expect(await w.states()).toEqual(PLANNED);
  });

  test("a run with no stack on the platform needs neither", async () => {
    const w = await world();
    await apply(w);
    expect(w.triggered()).toBe(1);
  });

  test("the merge handler passes both on", async () => {
    const w = await world({ applyOn: { net: "merge" }, state: { net: "orch" } });
    w.merge();
    const ctx: JobContext = {
      id: "job-9",
      queue: WEBHOOK_QUEUE,
      payload: {
        event: "merge_request",
        organizationId: o1,
        connectionId: conn1,
        projectId: w.gl.id,
        iid: w.mr.iid,
        action: "merge",
      },
      attempt: 1,
      maxAttempts: 5,
      log: logger,
      signal: new AbortController().signal,
    };
    await mrApplyHandler({ db: t.db, gitlab: async () => client(), images, platform })(ctx);
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
    expect(signsIn((await jobsOf(w))["apply:net"])).toBe(true);
  });
});

describe("applying where an environment is protected (GOV-3)", () => {
  const net = { net: PLAN_JOB.net };
  const applyEvent = async (w: World) =>
    (
      await t.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "run.apply"), eq(auditEvents.resourceId, w.id)))
    )[0];

  test("a stack that names a protected environment is applied only with an approved request, which the apply uses up", async () => {
    const w = await world({ environment: { net: "prod" } });
    const env = await guard(w);
    const e = await refused(apply(w));
    expect(e).toMatchObject({ status: 409, code: "approval_required" });
    expect(e.message).toContain("net");
    expect(e.message).toContain("prod");
    expect(await w.states()).toEqual(PLANNED);
    expect(w.triggered()).toBe(0);
    expect(await applyEvent(w)).toBeUndefined();

    // asked for is not approved
    const asked = await approval(w, env, { stacks: net, open: true });
    expect((await refused(apply(w))).code).toBe("approval_required");
    expect(await statusOf(asked)).toBe("open");

    const id = await approval(w, env, { stacks: net });
    expect(await apply(w)).toEqual(["app", "net"]);
    expect(await statusOf(id)).toBe("applied");
    expect(await statusOf(asked)).toBe("open");
    expect((await applyEvent(w))?.metadata).toMatchObject({ changeRequestId: id });
  });

  test("an approval is for its own run and the plan it saw: another run, or a plan made again, needs another", async () => {
    const w = await world({ environment: { net: "prod" } });
    const env = await guard(w);
    const other = await approval(w, env, { stacks: net, runId: crypto.randomUUID() });
    const older = await approval(w, env, { stacks: { net: PLAN_JOB.net - 1 } });
    expect((await refused(apply(w))).code).toBe("approval_required");
    expect(await w.states()).toEqual(PLANNED);
    expect(await statusOf(other)).toBe("approved");
    expect(await statusOf(older)).toBe("approved");

    const right = await approval(w, env, { stacks: net });
    expect(await apply(w)).toEqual(["app", "net"]);
    expect(await statusOf(right)).toBe("applied");
    expect(await statusOf(other)).toBe("approved");
    expect(await statusOf(older)).toBe("approved");
  });

  test("an approval that leaves out a guarded stack of the apply does not serve it; the stacks it names may go alone", async () => {
    const w = await world({ environment: { net: "prod", app: "prod" } });
    const env = await guard(w);
    const id = await approval(w, env, { stacks: net });
    const e = await refused(apply(w));
    expect(e.code).toBe("approval_required");
    expect(e.message).toContain("app");
    expect(await statusOf(id)).toBe("approved");
    expect(await apply(w, { stacks: ["net"] })).toEqual(["net"]);
    expect(await statusOf(id)).toBe("applied");
  });

  test("an approval is one apply, whole: a part of the stacks it names uses it up", async () => {
    const w = await world({ environment: { net: "prod", app: "prod" } });
    const env = await guard(w);
    const id = await approval(w, env);
    expect(await apply(w, { stacks: ["net"] })).toEqual(["net"]);
    expect(await statusOf(id)).toBe("applied");
    expect((await applyEvent(w))?.metadata).toMatchObject({ changeRequestId: id, stacks: ["net"] });
  });

  test("what names no environment, one that is not protected or one the project lacks is applied as before", async () => {
    const plain = await world();
    await guard(plain);
    expect(await apply(plain)).toEqual(["app", "net"]);
    expect((await applyEvent(plain))?.metadata).not.toHaveProperty("changeRequestId");

    const open = await world({ environment: { net: "dev", app: "nowhere" } });
    await createEnvironment(t.db, {
      organizationId: o1,
      projectId: open.project.id,
      name: "Dev",
      slug: "dev",
    });
    expect(await apply(open)).toEqual(["app", "net"]);

    // only the stacks being applied count
    const part = await world({ environment: { app: "prod" } });
    await guard(part);
    expect(await apply(part, { stacks: ["net"] })).toEqual(["net"]);
  });

  test("another project's protected environment of the same slug does not hold it", async () => {
    await guard(await world());
    const w = await world({ environment: { net: "prod" } });
    expect(await apply(w)).toEqual(["app", "net"]);
  });

  test("a pipeline GitLab will not start does not spend the approval", async () => {
    const w = await world({ environment: { net: "prod" } });
    const env = await guard(w);
    const id = await approval(w, env, { stacks: net });
    mock.inject({
      method: "POST",
      path: new RegExp(`/projects/${w.gl.id}/pipeline$`),
      status: 400,
    });
    expect((await refused(apply(w))).code).toBe("gitlab_refused");
    expect(await statusOf(id)).toBe("approved");
    expect(await w.states()).toEqual(PLANNED);
    expect(await apply(w)).toEqual(["app", "net"]);
    expect(await statusOf(id)).toBe("applied");
  });

  test("two applies of one run with one approval: one goes", async () => {
    const w = await world({ environment: { net: "prod" } });
    const env = await guard(w);
    const id = await approval(w, env, { stacks: net });
    const both = await Promise.allSettled([apply(w), apply(w)]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(w.triggered()).toBe(1);
    expect(await statusOf(id)).toBe("applied");
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

  test("a stack of a protected environment that opted in waits for an approval, and the merge request says so", async () => {
    const w = await world({ applyOn: { net: "merge" }, environment: { net: "prod" } });
    const env = await guard(w);
    w.merge();
    await handler(job(w));
    const [note] = w.notes();
    expect(note?.body).toContain("Not applied on merge");
    expect(note?.body).toContain("prod");
    expect(await w.states()).toEqual(PLANNED);
    expect(w.triggered()).toBe(0);

    const id = await approval(w, env, { stacks: { net: PLAN_JOB.net } });
    await handler(job(w));
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
    expect(await statusOf(id)).toBe("applied");
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
  const makeApp = (provider: typeof keys | undefined, extra: Partial<AppDeps> = {}) =>
    createApp({
      logger,
      db: t.db,
      principal: callerPrincipal({
        db: t.db,
        roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
      }),
      ready: async () => {},
      keys: provider,
      ...extra,
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

  test("a stack on the platform's state is applied when the app knows the platform and has an image with orch, and is refused when it does not", async () => {
    const w = await world({ state: { net: "orch" } });
    const refusedRes = await call("alice", w);
    expect(refusedRes.status).toBe(422);
    expect(refusedRes.json.code).toBe("cannot_generate");
    expect(w.triggered()).toBe(0);
    const known = makeApp(keys, {
      images: { terraform: "registry.example.com/platform/terraform-orch" },
      platform: { apiUrl: "https://orch.example.com", audience: "orch.example.com" },
    });
    expect((await call("alice", w, {}, known)).status).toBe(202);
    const [id] = await w.applyPipelines();
    const yaml = mock.pipelineVariables(id as number)?.[0]?.value ?? "";
    expect(yaml).toContain('login="$(orch ci login --state)"');
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

  test("a plan the policy has not passed is a 409 policy_pending, and one it denied a policy_denied", async () => {
    const set = await createPolicySet(t.db, {
      organizationId: o1,
      name: "route",
      source: "platform/policies",
      ref: "v1",
      path: ".",
      tag: "prod",
    });
    try {
      const w = await world({ tags: { net: ["prod"] } });
      const waiting = await call("alice", w);
      expect([waiting.status, waiting.json.code]).toEqual([409, "policy_pending"]);
      await storePolicyVerdict(t.db, o1, w.project.id, w.id, "net", {
        evaluated: true,
        denied: ["data.main.deny_x"],
        warned: [],
      });
      const denied = await call("alice", w);
      expect([denied.status, denied.json.code]).toEqual([409, "policy_denied"]);
      expect(denied.text).toContain("data.main.deny_x");
      expect(w.triggered()).toBe(0);
      expect(await applied(w)).toHaveLength(0);
    } finally {
      if (set) await deletePolicySet(t.db, o1, set.id);
    }
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

  describe("a protected environment (GOV-3)", () => {
    const crs = (w: World, envId: string) =>
      `/organizations/${o1}/projects/${w.project.id}/environments/${envId}/change-requests`;
    async function crCall(who: Who, method: string, path: string, body?: unknown, a = app) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (who) headers.cookie = people[who].cookie;
      const res = await a.handle(
        new Request(`http://localhost${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      const text = await res.text();
      // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
      return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
    }
    const ask = (w: World, envId: string, body: unknown, who: Who = "bob") =>
      crCall(who, "POST", crs(w, envId), body);

    test("the apply is refused with a 409 until an approval exists, then goes once and is audited with it", async () => {
      const w = await world({ environment: { net: "prod" } });
      const env = await guard(w);
      const res = await call("alice", w);
      expect([res.status, res.json.code]).toEqual([409, "approval_required"]);
      expect(w.triggered()).toBe(0);
      expect(await applied(w)).toEqual([]);

      const id = await approval(w, env, { stacks: { net: PLAN_JOB.net } });
      expect((await call("alice", w)).status).toBe(202);
      expect((await applied(w))[0]?.metadata).toMatchObject({ changeRequestId: id });
      expect(await statusOf(id)).toBe("applied");
    });

    test("a developer asks, a maintainer other than them approves, and the apply goes", async () => {
      const w = await world({ environment: { net: "prod" } });
      const env = await guard(w);
      const made = await ask(w, env.id, { kind: "iac_apply", runId: w.id });
      expect(made.status).toBe(201);
      expect(made.json).toMatchObject({
        kind: "iac_apply",
        status: "open",
        subject: { runId: w.id, stacks: { app: PLAN_JOB.app, net: PLAN_JOB.net } },
        author: { kind: "user" },
      });
      expect(made.json.diff.map((d: { key: string }) => d.key).sort()).toEqual(["app", "net"]);
      expect(made.json.diff.every((d: { action: string }) => d.action === "apply")).toBe(true);
      expect((await call("alice", w)).json.code).toBe("approval_required");

      const path = `${crs(w, env.id)}/${made.json.id}`;
      // not by the one who asked, nor by a developer
      expect((await crCall("bob", "POST", `${path}/approve`)).status).toBe(403);
      const ok = await crCall("alice", "POST", `${path}/approve`);
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ status: "approved", appliedAt: null });
      expect(w.triggered()).toBe(0);

      expect((await call("alice", w)).status).toBe(202);
      expect(await statusOf(made.json.id)).toBe("applied");
      expect((await applied(w))[0]?.metadata).toMatchObject({ changeRequestId: made.json.id });
    });

    test("an approval is revoked by rejecting it, and approving needs no keys", async () => {
      const w = await world({ environment: { net: "prod" } });
      const env = await guard(w);
      const made = await ask(w, env.id, { kind: "iac_apply", runId: w.id, stacks: ["net"] });
      const path = `${crs(w, env.id)}/${made.json.id}`;
      // nothing was sealed, so approving needs no key provider
      const keyless = makeApp(undefined);
      const ok = await crCall("alice", "POST", `${path}/approve`, undefined, keyless);
      expect([ok.status, ok.json.status]).toEqual([200, "approved"]);
      const revoked = await crCall("alice", "POST", `${path}/reject`);
      expect([revoked.status, revoked.json.status]).toEqual([200, "rejected"]);
      expect((await call("alice", w)).json.code).toBe("approval_required");
      expect((await crCall("alice", "POST", `${path}/approve`)).status).toBe(409);
      expect(w.triggered()).toBe(0);
    });

    test("a request is made in a protected environment only", async () => {
      const w = await world({ environment: { net: "prod" } });
      const open = await createEnvironment(t.db, {
        organizationId: o1,
        projectId: w.project.id,
        name: "Dev",
        slug: "dev",
      });
      const res = await ask(w, open.id, { kind: "iac_apply", runId: w.id });
      expect([res.status, res.json.code]).toEqual([409, "environment_not_protected"]);
    });

    test("a maintainer cannot approve their own request", async () => {
      const w = await world({ environment: { net: "prod" } });
      const env = await guard(w);
      const made = await ask(
        w,
        env.id,
        { kind: "iac_apply", runId: w.id, stacks: ["net"] },
        "alice",
      );
      expect(made.status).toBe(201);
      expect(made.json.subject.stacks).toEqual({ net: PLAN_JOB.net });
      const own = await crCall("alice", "POST", `${crs(w, env.id)}/${made.json.id}/approve`);
      expect([own.status, own.json.code]).toEqual([403, "self_approval"]);
      expect(await statusOf(made.json.id)).toBe("open");
      expect((await call("alice", w)).json.code).toBe("approval_required");
    });

    test("only a run that can be applied is asked for", async () => {
      const w = await world();
      const env = await guard(w);
      const unknownStack = await ask(w, env.id, {
        kind: "iac_apply",
        runId: w.id,
        stacks: ["nope"],
      });
      expect([unknownStack.status, unknownStack.json.code]).toEqual([422, "unknown_stack"]);
      const noRun = await ask(w, env.id, { kind: "iac_apply", runId: crypto.randomUUID() });
      expect(noRun.status).toBe(404);
      const waiting = await world({ states: { net: "planning" } });
      const waitEnv = await guard(waiting);
      const notPlanned = await ask(waiting, waitEnv.id, {
        kind: "iac_apply",
        runId: waiting.id,
        stacks: ["net"],
      });
      expect([notPlanned.status, notPlanned.json.code]).toEqual([409, "not_planned"]);
      // left to default, it asks for what is planned, and for nothing when nothing is
      const idle = await world({ states: { net: "planning", app: "planning" } });
      const idleEnv = await guard(idle);
      const nothing = await ask(idle, idleEnv.id, { kind: "iac_apply", runId: idle.id });
      expect([nothing.status, nothing.json.code]).toEqual([409, "not_planned"]);
      const drift = await world({ drift: true });
      const driftEnv = await guard(drift);
      const onDrift = await ask(drift, driftEnv.id, { kind: "iac_apply", runId: drift.id });
      expect([onDrift.status, onDrift.json.code]).toEqual([409, "drift_run"]);
      // a reporter may not ask
      const reporter = await ask(w, env.id, { kind: "iac_apply", runId: w.id }, "carol");
      expect(reporter.status).toBe(403);
      expect(
        (await t.db.select().from(changeRequests).where(eq(changeRequests.projectId, w.project.id)))
          .length,
      ).toBe(0);
    });
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

describe("policy", () => {
  const SET = { name: "prod", source: "platform/policies", ref: "v1", path: ".", tag: "prod" };
  const addSet = async (over: Partial<typeof SET> = {}) => {
    const made = await createPolicySet(t.db, { organizationId: o1, ...SET, ...over });
    if (!made) throw new Error("set not made");
    return made;
  };
  const clearSets = async () => {
    for (const set of await listPolicySets(t.db, o1, { limit: 100 })) {
      await deletePolicySet(t.db, o1, set.id);
    }
  };
  afterEach(clearSets);
  const say = (w: World, stack: Name, report: Parameters<typeof storePolicyVerdict>[5]) =>
    storePolicyVerdict(t.db, o1, w.project.id, w.id, stack, report);
  const pass = { evaluated: true, denied: [], warned: [] };

  test("a stack no set reaches is applied with no verdict, as before", async () => {
    await addSet({ tag: "pci" });
    const w = await world({ tags: { net: ["prod"], app: ["prod"] } });
    expect(await apply(w)).toEqual(["app", "net"]);
  });

  test("a stack that a set judges is applied when it passed or was warned, and not before it was judged", async () => {
    await addSet();
    const w = await world({ tags: { net: ["prod"] } });
    // judged by a set and not yet by the policy: it waits
    const waiting = await refused(apply(w));
    expect(waiting).toMatchObject({ status: 409, code: "policy_pending" });
    expect(waiting.message).toContain("net");
    expect(await w.states()).toEqual(PLANNED);
    expect(w.triggered()).toBe(0);

    await say(w, "net", { evaluated: true, denied: [], warned: ["data.main.warn_tags"] });
    expect(await apply(w)).toEqual(["app", "net"]);
    expect(w.triggered()).toBe(1);
  });

  test("a deny stops the apply of the whole request, naming the rules, and starts nothing", async () => {
    await addSet();
    const w = await world({ tags: { net: ["prod"], app: ["prod"] } });
    await say(w, "app", pass);
    await say(w, "net", {
      evaluated: true,
      denied: ["data.main.deny_public", "data.s3.deny_unencrypted"],
      warned: [],
    });
    const e = await refused(apply(w));
    expect(e).toMatchObject({ status: 409, code: "policy_denied" });
    expect(e.message).toContain("data.main.deny_public");
    expect(await w.states()).toEqual(PLANNED);
    expect(w.triggered()).toBe(0);
    // the stack that passed is not held back by name: applied alone it has to wait for net
    expect(await refused(apply(w, { stacks: ["app"] }))).toMatchObject({
      code: "dependency_not_applied",
    });
  });

  test("an evaluator that crashed is a deny", async () => {
    await addSet();
    const w = await world({ tags: { net: ["prod"] } });
    await say(w, "net", { evaluated: false, denied: [], warned: [] });
    const e = await refused(apply(w));
    expect(e).toMatchObject({ status: 409, code: "policy_denied" });
    expect(e.message).toContain("evaluator-failed");
    expect(w.triggered()).toBe(0);
  });

  test("a verdict stands after its set is removed: only a new plan lifts it", async () => {
    const set = await addSet();
    const w = await world({ tags: { net: ["prod"] } });
    await say(w, "net", { evaluated: true, denied: ["data.main.deny_x"], warned: [] });
    await deletePolicySet(t.db, o1, set.id);
    expect(await refused(apply(w))).toMatchObject({ code: "policy_denied" });
  });

  test("a set added after the plan makes the stack wait for a plan that policy has judged", async () => {
    const w = await world({ tags: { net: ["prod"] } });
    await addSet();
    expect(await refused(apply(w))).toMatchObject({ code: "policy_pending" });
  });

  test("a plan job that is replaced by a retry drops the verdict of the old plan", async () => {
    await addSet();
    const w = await world({ tags: { net: ["prod"] } });
    await say(w, "net", pass);
    // the same job seen again changes nothing
    await recordStackJobs(t.db, o1, w.project.id, w.id, "net", { planJobId: PLAN_JOB.net });
    expect((await w.run()).stacks.find((s) => s.stack === "net")?.policyVerdict).toBe("pass");
    // a retried plan job is a new job with a new plan
    await recordStackJobs(t.db, o1, w.project.id, w.id, "net", { planJobId: 777 });
    const stack = (await w.run()).stacks.find((s) => s.stack === "net");
    expect(stack).toMatchObject({
      planJobId: 777,
      policyVerdict: null,
      policyDenied: null,
      policyWarned: null,
      policyAt: null,
    });
    expect(await refused(apply(w))).toMatchObject({ code: "policy_pending" });
  });

  test("the merge path says why, in the note, and applies nothing", async () => {
    await addSet();
    const w = await world({ applyOn: { net: "merge" }, tags: { net: ["prod"] } });
    await say(w, "net", { evaluated: true, denied: ["data.main.deny_x"], warned: [] });
    w.merge();
    expect(await refused(apply(w, { when: "merge" }))).toMatchObject({ code: "policy_denied" });
    expect(w.triggered()).toBe(0);
  });
});

describe("cost limits", () => {
  const clearLimits = async () => {
    for (const l of await allCostLimits(t.db, o1)) await deleteCostLimit(t.db, o1, l.id);
  };
  afterEach(clearLimits);
  const limit = async (
    maxMonthlyDelta: number,
    over: { tag?: string | null; warnAt?: number | null; currency?: string } = {},
  ) => {
    const made = await setCostLimit(t.db, {
      organizationId: o1,
      tag: over.tag ?? null,
      maxMonthlyDelta,
      warnAt: over.warnAt ?? null,
      currency: over.currency ?? "USD",
    });
    if (!made) throw new Error("limit not made");
    return made.row;
  };
  /** What the plan job's summary said of a stack, with an estimate unless `cost` is null. */
  const estimate = (
    w: World,
    stack: Name,
    cost: { monthlyDelta: number; currency?: string } | null,
  ) =>
    storePlanSummary(t.db, o1, w.project.id, w.id, stack, {
      add: 1,
      change: 0,
      destroy: 0,
      resources: [],
      ...(cost
        ? { cost: { monthlyTotal: 1000, currency: "USD", tool: "infracost", ...cost } }
        : {}),
    });
  const both = async (w: World, monthlyDelta: number) => {
    await estimate(w, "net", { monthlyDelta });
    await estimate(w, "app", { monthlyDelta });
  };

  test("with no limit nothing changes: a plan of any estimate, or none, is applied", async () => {
    const w = await world();
    await both(w, 1e9);
    expect(await apply(w)).toEqual(["app", "net"]);
    const bare = await world();
    await estimate(bare, "net", null);
    expect(await apply(bare)).toEqual(["app", "net"]);
  });

  test("a plan under the limit, at it, and one that is only warned about are applied", async () => {
    await limit(500, { warnAt: 300 });
    for (const delta of [-50, 0, 299, 400, 500]) {
      const w = await world();
      await both(w, delta);
      expect([delta, await apply(w)]).toEqual([delta, ["app", "net"]]);
    }
  });

  test("a plan over the limit is a 409 cost_denied naming the stack and the rule, and starts nothing", async () => {
    await limit(500, { warnAt: 300 });
    const w = await world();
    await estimate(w, "net", { monthlyDelta: 500.01 });
    await estimate(w, "app", { monthlyDelta: 10 });
    const e = await refused(apply(w));
    expect(e).toMatchObject({ status: 409, code: "cost_denied" });
    expect(e.message).toContain("net");
    expect(e.message).toContain("cost-over-limit");
    expect(await w.states()).toEqual(PLANNED);
    expect(w.triggered()).toBe(0);
  });

  test("a limit and no estimate blocks the apply: an estimator that crashed never lets a plan through", async () => {
    await limit(500);
    const w = await world();
    await estimate(w, "net", { monthlyDelta: 1 });
    // app's summary came without a cost
    await estimate(w, "app", null);
    const e = await refused(apply(w));
    expect(e).toMatchObject({ status: 409, code: "cost_denied" });
    expect(e.message).toContain("app");
    expect(e.message).toContain("cost-unavailable");
    expect(w.triggered()).toBe(0);
  });

  test("an estimate in another currency is denied and never converted", async () => {
    await limit(500, { currency: "USD" });
    const w = await world();
    await estimate(w, "net", { monthlyDelta: 1, currency: "EUR" });
    await estimate(w, "app", { monthlyDelta: 1 });
    const e = await refused(apply(w));
    expect(e).toMatchObject({ status: 409, code: "cost_denied" });
    expect(e.message).toContain("cost-currency-mismatch");
    expect(w.triggered()).toBe(0);
  });

  test("a tag's limit judges the stacks that carry it, and the organization's the rest", async () => {
    await limit(100);
    await limit(5000, { tag: "prod" });
    const w = await world({ tags: { net: ["prod"] } });
    await estimate(w, "net", { monthlyDelta: 1000 });
    await estimate(w, "app", { monthlyDelta: 1000 });
    // net is inside its tag's 5000, app is over the organization's 100
    const e = await refused(apply(w));
    expect(e.message).toContain("app");
    expect(e.message).not.toContain("net");
    await estimate(w, "app", { monthlyDelta: 99 });
    expect(await apply(w)).toEqual(["app", "net"]);
  });

  test("the limits are the ones in force at the apply: a lowered one stops a plan, a removed one frees it", async () => {
    const l = await limit(500);
    const w = await world();
    await both(w, 400);
    await limit(300);
    expect(await refused(apply(w))).toMatchObject({ code: "cost_denied" });
    await deleteCostLimit(t.db, o1, l.id);
    // setting the organization's limit again replaced its row (same id), so this removes the only one
    expect(await apply(w)).toEqual(["app", "net"]);
  });

  test("a retried plan job drops the estimate of the old plan, so a limit waits for the new one", async () => {
    await limit(500);
    const w = await world();
    await both(w, 1);
    await recordStackJobs(t.db, o1, w.project.id, w.id, "net", { planJobId: 777 });
    const e = await refused(apply(w));
    expect(e.message).toContain("cost-unavailable");
  });

  test("for one stack the policy's refusal comes before the cost's", async () => {
    await limit(500);
    const set = await createPolicySet(t.db, {
      organizationId: o1,
      name: "cost",
      source: "platform/policies",
      ref: "v1",
      path: ".",
      tag: "prod",
    });
    try {
      const w = await world({ tags: { net: ["prod"] } });
      await estimate(w, "app", { monthlyDelta: 1 });
      await estimate(w, "net", { monthlyDelta: 9999 });
      await storePolicyVerdict(t.db, o1, w.project.id, w.id, "net", {
        evaluated: true,
        denied: ["data.main.deny_x"],
        warned: [],
      });
      expect(await refused(apply(w))).toMatchObject({ code: "policy_denied" });
    } finally {
      if (set) await deletePolicySet(t.db, o1, set.id);
    }
  });

  test("the merge path refuses the same way and applies nothing", async () => {
    await limit(500);
    const w = await world({ applyOn: { net: "merge" } });
    await both(w, 900);
    w.merge();
    expect(await refused(apply(w, { when: "merge" }))).toMatchObject({ code: "cost_denied" });
    expect(w.triggered()).toBe(0);
  });
});

describe("the secret gate (SCAN-6)", () => {
  afterEach(async () => {
    await setSecretGate(t.db, o1, "off");
  });
  const finding = (fingerprint: string) => ({
    fingerprint,
    rule: "aws-access-token",
    path: "src/config.ts",
    line: 3,
    commit: "a1b2c3d",
    severity: "critical" as const,
  });
  /** Findings seen on `ref` of the world's project. */
  const seen = (w: World, fingerprints: string[], ref = "main") =>
    upsertFindings(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      ref,
      findings: fingerprints.map(finding),
    });

  test("off, the default, applies whatever is open", async () => {
    const w = await world();
    await seen(w, ["f1", "f2"]);
    expect(await apply(w)).toEqual(["app", "net"]);
  });

  test("warn applies: it is shown in the note, not enforced", async () => {
    await setSecretGate(t.db, o1, "warn");
    const w = await world();
    await seen(w, ["f1"]);
    expect(await apply(w)).toEqual(["app", "net"]);
  });

  test("deny with an open finding is a 409 secret_findings_open with the count, and starts nothing", async () => {
    await setSecretGate(t.db, o1, "deny");
    const w = await world();
    await seen(w, ["f1", "f2"]);
    const e = await refused(apply(w));
    expect(e).toMatchObject({ status: 409, code: "secret_findings_open" });
    expect(e.message).toContain("2 secret findings are open");
    expect(e.message).toContain("secret-findings-open");
    expect(await w.states()).toEqual(PLANNED);
    expect(w.triggered()).toBe(0);
  });

  test("deny with nothing open applies, and so does a project whose findings were dismissed or resolved", async () => {
    await setSecretGate(t.db, o1, "deny");
    const clean = await world();
    expect(await apply(clean)).toEqual(["app", "net"]);

    const w = await world();
    await seen(w, ["gone", "dis"]);
    await resolveMissing(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      ref: "main",
      seen: ["dis"],
    });
    const [dis] = await listFindings(t.db, o1, w.project.id, { limit: 10 }, { status: "open" });
    if (!dis) throw new Error("no finding");
    await dismissFinding(
      t.db,
      { organizationId: o1, projectId: w.project.id, id: dis.id },
      "user:alice",
      "a test key",
    );
    expect(await apply(w)).toEqual(["app", "net"]);
  });

  test("a finding on a feature branch, or on another project, does not block", async () => {
    await setSecretGate(t.db, o1, "deny");
    const w = await world();
    const other = await world();
    await seen(w, ["on-branch"], "feature");
    await seen(other, ["theirs"]);
    expect(await apply(w)).toEqual(["app", "net"]);
  });

  test("dismissing the finding frees the apply, and the gate is read at the apply", async () => {
    const w = await world();
    await seen(w, ["f1"]);
    await setSecretGate(t.db, o1, "deny");
    const one = await refused(apply(w));
    expect(one).toMatchObject({ code: "secret_findings_open" });
    expect(one.message).toContain("1 secret finding is open");
    const [open] = await listFindings(t.db, o1, w.project.id, { limit: 10 }, { status: "open" });
    if (!open) throw new Error("no finding");
    await dismissFinding(
      t.db,
      { organizationId: o1, projectId: w.project.id, id: open.id },
      "user:alice",
      "revoked",
    );
    expect(await apply(w)).toEqual(["app", "net"]);
  });

  test("the merge path refuses the same way and applies nothing", async () => {
    await setSecretGate(t.db, o1, "deny");
    const w = await world({ applyOn: { net: "merge" } });
    await seen(w, ["f1"]);
    w.merge();
    expect(await refused(apply(w, { when: "merge" }))).toMatchObject({
      code: "secret_findings_open",
    });
    expect(w.triggered()).toBe(0);
  });

  test("a merge with nothing opted in to apply is not held by findings: nothing would start", async () => {
    await setSecretGate(t.db, o1, "deny");
    const w = await world();
    await seen(w, ["f1"]);
    w.merge();
    expect(await apply(w, { when: "merge" })).toEqual([]);
  });

  test("the finding's text is not in the refusal", async () => {
    await setSecretGate(t.db, o1, "deny");
    const w = await world();
    await seen(w, ["f1"]);
    const e = await refused(apply(w));
    expect(e.message).not.toContain("src/config.ts");
    expect(e.message).not.toContain("aws-access-token");
  });
});
