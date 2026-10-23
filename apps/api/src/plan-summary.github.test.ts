import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import {
  attachRunPipeline,
  createCiToken,
  createOrganization,
  createProject,
  createRun,
  getRun,
  type NewStack,
  syncStacks,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { newCiToken } from "./tokens";

/** FRG-33: a GitHub job has no job id; the workflow run it belongs to stands for it. */
let t: TestDb;
let app: ReturnType<typeof createApp>;
const ids = {} as Record<"o1" | "p1" | "p2", string>;

const stack = (name: string): NewStack => ({
  name,
  path: name,
  tool: "tofu",
  version: "1.9.8",
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command",
  backend: "http",
});

const SHA = "c".repeat(40);
const REF = "feature/net";
const PLAN_RUN = 7001; // the GitHub workflow run that plans
const APPLY_RUN = 7002;
const OTHER_RUN = 7003;

beforeAll(async () => {
  t = await createTestDb();
  ids.o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  ids.p1 = (await createProject(t.db, { organizationId: ids.o1, name: "p1" })).id;
  ids.p2 = (await createProject(t.db, { organizationId: ids.o1, name: "p2" })).id;
  await syncStacks(t.db, ids.o1, ids.p1, ["net", "app"].map(stack), { prune: false });
  await syncStacks(t.db, ids.o1, ids.p2, ["net"].map(stack), { prune: false });
  app = createApp({
    logger: createLogger({ level: "error", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({ db: t.db }),
    ready: async () => {},
  });
});
afterAll(async () => {
  await t.drop();
});

/** A run of the two stacks, planned by workflow run `PLAN_RUN` and applied by `APPLY_RUN`; `OTHER_RUN` is another run's. */
let counter = 0;
async function newRun() {
  const run = await createRun(t.db, {
    organizationId: ids.o1,
    projectId: ids.p1,
    ref: REF,
    sha: SHA,
    stacks: ["net", "app"],
  });
  // each test has its own workflow run ids: a pipeline belongs to one run
  const base = ++counter * 10;
  const pipelines = { plan: PLAN_RUN + base, apply: APPLY_RUN + base, other: OTHER_RUN + base };
  await attachRunPipeline(t.db, {
    organizationId: ids.o1,
    projectId: ids.p1,
    runId: run.id,
    gitlabPipelineId: pipelines.plan,
    action: "plan",
  });
  await attachRunPipeline(t.db, {
    organizationId: ids.o1,
    projectId: ids.p1,
    runId: run.id,
    gitlabPipelineId: pipelines.apply,
    action: "apply",
  });
  const other = await createRun(t.db, {
    organizationId: ids.o1,
    projectId: ids.p1,
    ref: REF,
    sha: SHA,
    stacks: ["net"],
  });
  await attachRunPipeline(t.db, {
    organizationId: ids.o1,
    projectId: ids.p1,
    runId: other.id,
    gitlabPipelineId: pipelines.other,
    action: "plan",
  });
  return { runId: run.id, ...pipelines };
}

/** A CI token as `/auth/ci/exchange` issues it to a GitHub job: a workflow run id, no job id. */
async function ciToken(
  over: { projectId?: string; pipelineId?: number | null; jobId?: number; ref?: string } = {},
) {
  const fresh = newCiToken();
  await createCiToken(t.db, {
    organizationId: ids.o1,
    projectId: over.projectId ?? ids.p1,
    tokenHash: fresh.tokenHash,
    scopes: ["project.read", "run.summary"],
    gitlabProjectId: 5501,
    ...(over.pipelineId === null ? {} : { gitlabPipelineId: over.pipelineId }),
    ...(over.jobId === undefined ? {} : { gitlabJobId: over.jobId }),
    ref: over.ref ?? REF,
    refProtected: false,
    ttlMs: 60_000,
  });
  return fresh.token;
}

const path = (runId: string, what: "plan-summary" | "policy-verdict", project = ids.p1) =>
  `/organizations/${ids.o1}/projects/${project}/runs/${runId}/${what}`;
const summary = (stackName = "net") => ({
  stack: stackName,
  add: 1,
  change: 0,
  destroy: 0,
  resources: [{ address: "aws_s3_bucket.logs", actions: ["create"] }],
});
const verdict = (stackName = "net") => ({
  stack: stackName,
  evaluated: true,
  denied: [],
  warned: [],
});

async function post(url: string, body: unknown, bearer: string) {
  const res = await app.handle(
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, text: await res.text() };
}

describe("a GitHub job posting a plan summary", () => {
  test("the plan workflow run of the stack-run, on its ref, may post a summary and a policy verdict", async () => {
    const r = await newRun();
    const bearer = await ciToken({ pipelineId: r.plan });
    expect((await post(path(r.runId, "plan-summary"), summary(), bearer)).status).toBe(204);
    expect((await post(path(r.runId, "policy-verdict"), verdict("app"), bearer)).status).toBe(204);
    const run = await getRun(t.db, ids.o1, ids.p1, r.runId);
    expect(run?.stacks.find((s) => s.stack === "net")).toMatchObject({ planAdd: 1 });
  });

  test("the workflow run of another stack-run, the apply run and no run at all are refused", async () => {
    const r = await newRun();
    const none = await ciToken({ pipelineId: null });
    for (const [why, bearer] of [
      ["another stack-run's workflow run", await ciToken({ pipelineId: r.other })],
      ["the apply workflow run", await ciToken({ pipelineId: r.apply })],
      ["a run nobody dispatched", await ciToken({ pipelineId: 999_999_999 })],
      ["no run id and no job id", none],
    ] as const) {
      for (const [what, body] of [
        ["plan-summary", summary()],
        ["policy-verdict", verdict()],
      ] as const) {
        const res = await post(path(r.runId, what), body, bearer);
        expect([why, what, res.status]).toEqual([why, what, 403]);
      }
    }
    const run = await getRun(t.db, ids.o1, ids.p1, r.runId);
    expect(run?.stacks.every((s) => s.planAdd === null)).toBe(true);
  });

  test("a wrong ref, a stack that is not in the run and another project's token are refused", async () => {
    const r = await newRun();
    const wrongRef = await ciToken({ pipelineId: r.plan, ref: "main" });
    expect((await post(path(r.runId, "plan-summary"), summary(), wrongRef)).status).toBe(403);
    const good = await ciToken({ pipelineId: r.plan });
    expect((await post(path(r.runId, "plan-summary"), summary("db"), good)).status).toBe(403);
    // p2's token for the same workflow run id: the route is p1's, so it never gets as far as the run
    const foreign = await ciToken({ projectId: ids.p2, pipelineId: r.plan });
    const res = await post(path(r.runId, "plan-summary"), summary(), foreign);
    expect([403, 404]).toContain(res.status);
  });

  test("a job id that is not the stack's summary job is still refused, whatever the workflow run", async () => {
    const r = await newRun();
    const bearer = await ciToken({ pipelineId: r.plan, jobId: 31_337 });
    const res = await post(path(r.runId, "plan-summary"), summary(), bearer);
    expect(res.status).toBe(403);
  });

  test("the refusal says nothing about the run, the pipeline or the token", async () => {
    const r = await newRun();
    const bearer = await ciToken({ pipelineId: r.apply });
    const res = await post(path(r.runId, "plan-summary"), summary(), bearer);
    expect(res.text).not.toContain(String(r.apply));
    expect(res.text).not.toContain(bearer);
  });
});
