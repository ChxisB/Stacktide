import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { canTransition, RUN_STATES, type RunState } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import { and, eq } from "drizzle-orm";
import { createConnection, deleteConnection } from "./connections";
import { pgConstraint } from "./pg-error";
import { recordPipelineRun } from "./pipeline-runs";
import { createOrganization, createProject, deleteProject } from "./repo";
import {
  applyPipelinesOfRun,
  attachRunPipeline,
  connectionOfRun,
  createRun,
  getPlanResources,
  getRun,
  IllegalTransition,
  latestRunOfMergeRequest,
  listRuns,
  moveRunStack,
  type NewRun,
  type PlanSummary,
  planPipelinesOfRun,
  recordStackJobs,
  runOfPipeline,
  storePlanSummary,
  supersedeRuns,
} from "./runs";
import { runPipelines, runStacks, runs } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

let n = 0;
async function world() {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
  return { org, project };
}

const SHA = "a".repeat(40);
const input = (
  w: Awaited<ReturnType<typeof world>>,
  stacks: string[],
  extra: Partial<NewRun> = {},
): NewRun => ({
  organizationId: w.org.id,
  projectId: w.project.id,
  ref: "feature/net",
  sha: SHA,
  stacks,
  ...extra,
});

/** The constraint a failed statement names, or the error itself when it is not a database's. */
const refusedBy = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return pgConstraint(e) ?? e;
  }
  return undefined;
};

const setStatus = (runId: string, stack: string, status: RunState) =>
  t.db
    .update(runStacks)
    .set({ status })
    .where(and(eq(runStacks.runId, runId), eq(runStacks.stack, stack)));

describe("createRun", () => {
  test("stores the run and queues each stack, listed by name", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["net", "app", "db"], { mergeRequestIid: 12 }));
    expect(run).toMatchObject({
      organizationId: w.org.id,
      projectId: w.project.id,
      ref: "feature/net",
      sha: SHA,
      mergeRequestIid: 12,
    });
    expect(run.stacks.map((s) => [s.stack, s.status, s.error])).toEqual([
      ["app", "queued", null],
      ["db", "queued", null],
      ["net", "queued", null],
    ]);
    expect(await getRun(t.db, w.org.id, w.project.id, run.id)).toEqual(run);
  });

  test("the stacks come in the same order made as read, by code point, not by collation", async () => {
    const w = await world();
    // an en_US-style collation ignores the hyphen and would put `ab` before `a-b`
    const run = await createRun(t.db, input(w, ["ab", "a0", "a-b"]));
    const order = ["a-b", "a0", "ab"];
    expect(run.stacks.map((s) => s.stack)).toEqual(order);
    const read = await getRun(t.db, w.org.id, w.project.id, run.id);
    expect(read?.stacks.map((s) => s.stack)).toEqual(order);
    const listed = await listRuns(t.db, w.org.id, w.project.id, { limit: 5 });
    expect(listed[0]?.stacks.map((s) => s.stack)).toEqual(order);
  });

  test("a stack keeps the tags it had when the run was made, and none when none were given", async () => {
    const w = await world();
    const run = await createRun(
      t.db,
      input(w, ["net", "app", "db"], {
        tags: { net: ["prod", "core"], db: ["prod"], other: ["x"] },
      }),
    );
    // the order the repository wrote them in; a name that is not a stack of the run is ignored
    expect(run.stacks.map((s) => [s.stack, s.tags])).toEqual([
      ["app", []],
      ["db", ["prod"]],
      ["net", ["prod", "core"]],
    ]);
    const read = await getRun(t.db, w.org.id, w.project.id, run.id);
    expect(read?.stacks.map((s) => s.tags)).toEqual([[], ["prod"], ["prod", "core"]]);
    expect((await createRun(t.db, input(w, ["net"]))).stacks[0]?.tags).toEqual([]);
  });

  test("a run with no merge request says so", async () => {
    const w = await world();
    expect((await createRun(t.db, input(w, ["net"]))).mergeRequestIid).toBeNull();
  });

  test("a run of no stacks is refused, and so is one that names a stack twice, leaving nothing", async () => {
    const w = await world();
    await expect(createRun(t.db, input(w, []))).rejects.toThrow("at least one stack");
    expect(await refusedBy(createRun(t.db, input(w, ["net", "net"])))).toBe(
      "run_stacks_run_id_stack_pk",
    );
    expect(await listRuns(t.db, w.org.id, w.project.id, { limit: 10 })).toEqual([]);
  });

  test("the database refuses what is not a commit, a stack name, a ref or a merge request", async () => {
    const w = await world();
    const bad: [string, Partial<NewRun>, string][] = [
      ["short sha", { sha: "abc123" }, "runs_sha_check"],
      ["upper-case sha", { sha: "A".repeat(40) }, "runs_sha_check"],
      ["sha with a suffix", { sha: `${SHA}0` }, "runs_sha_check"],
      ["empty ref", { ref: "" }, "runs_ref_check"],
      ["long ref", { ref: "r".repeat(256) }, "runs_ref_check"],
      ["merge request 0", { mergeRequestIid: 0 }, "runs_mr_check"],
      ["stack with a space", { stacks: ["a b"] }, "run_stacks_stack_check"],
      ["stack in capitals", { stacks: ["Net"] }, "run_stacks_stack_check"],
    ];
    for (const [what, extra, constraint] of bad) {
      expect(await refusedBy(createRun(t.db, input(w, ["net"], extra))), what).toBe(constraint);
    }
    // both lengths of a git object id are fine
    await createRun(t.db, input(w, ["net"], { sha: "b".repeat(64) }));
    await createRun(t.db, input(w, ["net"], { ref: "r".repeat(255) }));
    expect(await listRuns(t.db, w.org.id, w.project.id, { limit: 10 })).toHaveLength(2);
  });

  test("the database refuses a state that is not one of the eight, whoever writes it", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["net"]));
    const set = (status: string) =>
      t.db.update(runStacks).set({ status }).where(eq(runStacks.runId, run.id));
    for (const status of ["Queued", "done", "", "applying "]) {
      expect(await refusedBy(set(status)), status).toBe("run_stacks_status_check");
    }
    for (const status of RUN_STATES) await set(status);
  });

  test("a project of another organization is not accepted", async () => {
    const a = await world();
    const b = await world();
    const crossed = { ...input(a, ["net"]), projectId: b.project.id };
    expect(await refusedBy(createRun(t.db, crossed))).toBe("runs_project_org_fk");
  });
});

describe("getRun and listRuns", () => {
  test("every lookup repeats the organization and the project", async () => {
    const a = await world();
    const b = await world();
    const run = await createRun(t.db, input(a, ["net"]));
    expect(await getRun(t.db, b.org.id, a.project.id, run.id)).toBeUndefined();
    expect(await getRun(t.db, a.org.id, b.project.id, run.id)).toBeUndefined();
    expect(await getRun(t.db, a.org.id, a.project.id, run.id)).toEqual(run);
    expect(await listRuns(t.db, b.org.id, b.project.id, { limit: 10 })).toEqual([]);
    expect(await listRuns(t.db, b.org.id, a.project.id, { limit: 10 })).toEqual([]);
  });

  test("newest first, with its stacks, a page at a time", async () => {
    const w = await world();
    const made = [];
    for (const name of ["one", "two", "three", "four", "five"]) {
      made.push(await createRun(t.db, input(w, [name, "shared"])));
    }
    await createRun(t.db, input(await world(), ["elsewhere"]));
    const newest = [...made].reverse();

    // one of several in the project is found by its own id
    expect(await getRun(t.db, w.org.id, w.project.id, made[2]?.id ?? "")).toEqual(made[2]);

    const first = await listRuns(t.db, w.org.id, w.project.id, { limit: 2 });
    expect(first.map((r) => r.id)).toEqual(newest.slice(0, 2).map((r) => r.id));
    expect(first[0]).toEqual(newest[0]);

    const second = await listRuns(t.db, w.org.id, w.project.id, {
      limit: 2,
      before: first[1]?.id,
    });
    expect(second.map((r) => r.id)).toEqual(newest.slice(2, 4).map((r) => r.id));
    const last = await listRuns(t.db, w.org.id, w.project.id, { limit: 2, before: second[1]?.id });
    expect(last.map((r) => r.id)).toEqual(newest.slice(4).map((r) => r.id));
    expect(last[0]?.stacks.map((s) => s.stack)).toEqual(["one", "shared"]);
  });
});

describe("moveRunStack", () => {
  const move = (
    w: Awaited<ReturnType<typeof world>>,
    runId: string,
    stack: string,
    a: string,
    b: string,
    error?: string,
  ) =>
    moveRunStack(t.db, w.org.id, w.project.id, runId, stack, a as RunState, b as RunState, error);

  test("moves a stack along its lifecycle and leaves the others where they are", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["a", "b"]));
    for (const [from, to] of [
      ["queued", "planning"],
      ["planning", "planned"],
      ["planned", "applying"],
      ["applying", "applied"],
    ] as const) {
      expect(await move(w, run.id, "a", from, to)).toMatchObject({ stack: "a", status: to });
    }
    const now = await getRun(t.db, w.org.id, w.project.id, run.id);
    expect(now?.stacks.map((s) => [s.stack, s.status])).toEqual([
      ["a", "applied"],
      ["b", "queued"],
    ]);
  });

  test("a failure keeps its reason, a longer one than 500 characters is refused", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["a", "b"]));
    const row = await move(w, run.id, "a", "queued", "failed", "the pipeline could not be created");
    expect(row).toMatchObject({ status: "failed", error: "the pipeline could not be created" });
    expect(await move(w, run.id, "b", "queued", "canceled")).toMatchObject({ error: null });
    expect(await refusedBy(move(w, run.id, "b", "canceled", "canceled", "x"))).toBeInstanceOf(
      IllegalTransition,
    );
    const c = await createRun(t.db, input(w, ["c"]));
    expect(await refusedBy(move(w, c.id, "c", "queued", "failed", "x".repeat(501)))).toBe(
      "run_stacks_error_check",
    );
    expect(await move(w, c.id, "c", "queued", "failed", "x".repeat(500))).toBeDefined();
  });

  test("only a move into a finished state keeps a reason", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["a", "b"]));
    expect(await move(w, run.id, "a", "queued", "planning", "stray")).toMatchObject({
      status: "planning",
      error: null,
    });
    expect(await move(w, run.id, "a", "planning", "planned", "stray")).toMatchObject({
      error: null,
    });
    expect(await move(w, run.id, "b", "queued", "canceled", "superseded")).toMatchObject({
      error: "superseded",
    });
  });

  test("a stack that is not where the caller thinks is left alone (a repeated or late event)", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["a"]));
    expect(await move(w, run.id, "a", "queued", "planning")).toBeDefined();
    // the same event again, and one that arrives after the stack has gone on
    expect(await move(w, run.id, "a", "queued", "planning")).toBeUndefined();
    expect(await move(w, run.id, "a", "queued", "canceled")).toBeUndefined();
    expect(await move(w, run.id, "nope", "queued", "planning")).toBeUndefined();
    const now = await getRun(t.db, w.org.id, w.project.id, run.id);
    expect(now?.stacks[0]?.status).toBe("planning");
  });

  test("every pair of states, against the database: legal ones move, the rest throw and change nothing", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["a"]));
    let moved = 0;
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        await setStatus(run.id, "a", from);
        const outcome = await refusedBy(move(w, run.id, "a", from, to));
        const stored = (await getRun(t.db, w.org.id, w.project.id, run.id))?.stacks[0]?.status;
        if (canTransition(from, to)) {
          expect(outcome, `${from} -> ${to}`).toBeUndefined();
          expect(stored).toBe(to);
          moved++;
        } else {
          expect(outcome, `${from} -> ${to}`).toBeInstanceOf(IllegalTransition);
          expect(stored).toBe(from);
        }
      }
    }
    expect(moved).toBe(10);
  });

  test("the state a caller names must be one: not a typo or an inherited name", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["a"]));
    for (const bad of ["Queued", "constructor", ""]) {
      expect(await refusedBy(move(w, run.id, "a", bad, "planning"))).toBeInstanceOf(
        IllegalTransition,
      );
      expect(await refusedBy(move(w, run.id, "a", "queued", bad))).toBeInstanceOf(
        IllegalTransition,
      );
    }
  });

  test("an id from another organization or project moves nothing", async () => {
    const a = await world();
    const b = await world();
    const run = await createRun(t.db, input(a, ["a"]));
    const other = (org: string, project: string) =>
      moveRunStack(t.db, org, project, run.id, "a", "queued", "planning");
    expect(await other(b.org.id, a.project.id)).toBeUndefined();
    expect(await other(a.org.id, b.project.id)).toBeUndefined();
    expect((await getRun(t.db, a.org.id, a.project.id, run.id))?.stacks[0]?.status).toBe("queued");
  });
});

describe("the apply mutex", () => {
  const ready = async (w: Awaited<ReturnType<typeof world>>, stack: string) => {
    const run = await createRun(t.db, input(w, [stack]));
    await setStatus(run.id, stack, "planned");
    return run;
  };
  const apply = (w: Awaited<ReturnType<typeof world>>, id: string, stack: string) =>
    moveRunStack(t.db, w.org.id, w.project.id, id, stack, "planned", "applying");

  test("one run at a time applies a stack, until it is done", async () => {
    const w = await world();
    const first = await ready(w, "net");
    const second = await ready(w, "net");
    const other = await ready(w, "app");
    expect(await apply(w, first.id, "net")).toBeDefined();
    expect(await refusedBy(apply(w, second.id, "net"))).toBe("run_stacks_one_applying");
    // another stack is free, and the refused one is still planned
    expect(await apply(w, other.id, "app")).toBeDefined();
    expect((await getRun(t.db, w.org.id, w.project.id, second.id))?.stacks[0]?.status).toBe(
      "planned",
    );

    expect(
      await moveRunStack(
        t.db,
        w.org.id,
        w.project.id,
        first.id,
        "net",
        "applying",
        "failed",
        "the apply failed",
      ),
    ).toBeDefined();
    expect(await apply(w, second.id, "net")).toBeDefined();
  });

  test("the same stack name in another project is another stack", async () => {
    const a = await world();
    const b = await world();
    expect(await apply(a, (await ready(a, "net")).id, "net")).toBeDefined();
    expect(await apply(b, (await ready(b, "net")).id, "net")).toBeDefined();
  });
});

describe("history", () => {
  test("deleting the project deletes its runs and their stacks, and nobody else's", async () => {
    const a = await world();
    const b = await world();
    const gone = await createRun(t.db, input(a, ["net"]));
    const kept = await createRun(t.db, input(b, ["net"]));
    await deleteProject(t.db, a.org.id, a.project.id);
    expect(await t.db.select().from(runs).where(eq(runs.id, gone.id))).toEqual([]);
    expect(await t.db.select().from(runStacks).where(eq(runStacks.runId, gone.id))).toEqual([]);
    expect(await getRun(t.db, b.org.id, b.project.id, kept.id)).toEqual(kept);
  });
});

describe("run pipelines", () => {
  const attach = (
    w: Awaited<ReturnType<typeof world>>,
    runId: string,
    gitlabPipelineId: number,
    action: "plan" | "apply" = "plan",
  ) =>
    attachRunPipeline(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      runId,
      gitlabPipelineId,
      action,
    });

  test("a pipeline is found with its run and what it does, in that project only", async () => {
    const w = await world();
    const other = await world();
    const run = await createRun(t.db, input(w, ["net", "app"]));
    await attach(w, run.id, 4001, "plan");
    await attach(w, run.id, 4002, "apply");
    const plan = await runOfPipeline(t.db, w.org.id, w.project.id, 4001);
    expect(plan?.action).toBe("plan");
    expect(plan?.run).toEqual(run);
    expect((await runOfPipeline(t.db, w.org.id, w.project.id, 4002))?.action).toBe("apply");
    expect(await runOfPipeline(t.db, w.org.id, w.project.id, 4003)).toBeUndefined();
    expect(await runOfPipeline(t.db, other.org.id, w.project.id, 4001)).toBeUndefined();
    expect(await runOfPipeline(t.db, w.org.id, other.project.id, 4001)).toBeUndefined();
    expect(await runOfPipeline(t.db, other.org.id, other.project.id, 4001)).toBeUndefined();
  });

  test("a pipeline belongs to one run, and a run to the project it was made in", async () => {
    const w = await world();
    const other = await world();
    const a = await createRun(t.db, input(w, ["net"]));
    const b = await createRun(t.db, input(w, ["net"]));
    const foreign = await createRun(t.db, input(other, ["net"]));
    await attach(w, a.id, 4100);
    expect(await refusedBy(attach(w, b.id, 4100))).toBe(
      "run_pipelines_project_id_gitlab_pipeline_id_pk",
    );
    expect(await refusedBy(attach(w, b.id, 4100, "apply"))).toBe(
      "run_pipelines_project_id_gitlab_pipeline_id_pk",
    );
    expect(await refusedBy(attach(w, foreign.id, 4101))).toBe("run_pipelines_run_fk");
    // the same GitLab number in another project is another pipeline
    await attach(other, foreign.id, 4100);
    expect((await runOfPipeline(t.db, w.org.id, w.project.id, 4100))?.run.id).toBe(a.id);
    expect((await runOfPipeline(t.db, other.org.id, other.project.id, 4100))?.run.id).toBe(
      foreign.id,
    );
  });

  test("the same GitLab number in two projects of one organization finds each project's own run", async () => {
    const first = await world();
    const second = {
      org: first.org,
      project: await createProject(t.db, { organizationId: first.org.id, name: `p${++n}` }),
    };
    const a = await createRun(t.db, input(first, ["net"]));
    const b = await createRun(t.db, input(second, ["net"]));
    await attach(first, a.id, 4300);
    await attach(second, b.id, 4300, "apply");
    const found = (w: typeof first) => runOfPipeline(t.db, w.org.id, w.project.id, 4300);
    expect(await found(first)).toMatchObject({ run: { id: a.id }, action: "plan" });
    expect(await found(second)).toMatchObject({ run: { id: b.id }, action: "apply" });
  });

  test("the database refuses an action that is not one and an id that is not a pipeline's", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["net"]));
    const bad = (over: object) =>
      t.db.insert(runPipelines).values({
        organizationId: w.org.id,
        projectId: w.project.id,
        runId: run.id,
        gitlabPipelineId: 4200,
        action: "plan",
        ...over,
      });
    expect(await refusedBy(bad({ action: "destroy" }))).toBe("run_pipelines_action_check");
    expect(await refusedBy(bad({ gitlabPipelineId: 0 }))).toBe("run_pipelines_pipeline_check");
    expect(await refusedBy(bad({ gitlabPipelineId: -5 }))).toBe("run_pipelines_pipeline_check");
  });

  test("they go with the run, and with the project", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["net"]));
    await attach(w, run.id, 4300);
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(await t.db.select().from(runPipelines).where(eq(runPipelines.runId, run.id))).toEqual(
      [],
    );
  });
});

describe("recordStackJobs", () => {
  const scope = (w: Awaited<ReturnType<typeof world>>, runId: string) =>
    [t.db, w.org.id, w.project.id, runId] as const;

  test("notes the jobs of a stack, only what is given, and the latest wins (a retry is a new job)", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["net", "app"]));
    await recordStackJobs(...scope(w, run.id), "net", { planJobId: 11, summaryJobId: 12 });
    await recordStackJobs(...scope(w, run.id), "net", { summaryJobId: 22 });
    await recordStackJobs(...scope(w, run.id), "net", {});
    await recordStackJobs(...scope(w, run.id), "net", { planJobId: undefined });
    const got = await getRun(t.db, w.org.id, w.project.id, run.id);
    expect(got?.stacks.map((s) => [s.stack, s.planJobId, s.summaryJobId])).toEqual([
      ["app", null, null],
      ["net", 11, 22],
    ]);
  });

  test("an id from another organization, project or run changes nothing, and a bad job id is refused", async () => {
    const w = await world();
    const other = await world();
    const run = await createRun(t.db, input(w, ["net"]));
    await recordStackJobs(t.db, other.org.id, w.project.id, run.id, "net", { planJobId: 5 });
    await recordStackJobs(t.db, w.org.id, other.project.id, run.id, "net", { planJobId: 5 });
    await recordStackJobs(...scope(w, run.id), "web", { planJobId: 5 });
    expect((await getRun(t.db, w.org.id, w.project.id, run.id))?.stacks[0]?.planJobId).toBeNull();
    expect(await refusedBy(recordStackJobs(...scope(w, run.id), "net", { summaryJobId: 0 }))).toBe(
      "run_stacks_jobs_check",
    );
  });
});

describe("plan summaries", () => {
  const summary: PlanSummary = {
    add: 2,
    change: 1,
    destroy: 3,
    resources: [
      { address: "aws_vpc.main", actions: ["create"] },
      { address: "aws_instance.web[0]", actions: ["delete", "create"] },
    ],
  };
  const store = (
    w: Awaited<ReturnType<typeof world>>,
    runId: string,
    stack: string,
    s: PlanSummary = summary,
  ) => storePlanSummary(t.db, w.org.id, w.project.id, runId, stack, s);

  test("stores counts and resources, and a read of the run shows the counts, not the resources", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["net", "app"]));
    const row = await store(w, run.id, "net");
    expect(row).toMatchObject({ stack: "net", planAdd: 2, planChange: 1, planDestroy: 3 });
    expect(row?.summarizedAt).toBeInstanceOf(Date);
    const got = await getRun(t.db, w.org.id, w.project.id, run.id);
    const net = got?.stacks.find((s) => s.stack === "net");
    expect(net).toMatchObject({ planAdd: 2, planChange: 1, planDestroy: 3 });
    expect(got?.stacks.find((s) => s.stack === "app")).toMatchObject({
      planAdd: null,
      planChange: null,
      planDestroy: null,
      summarizedAt: null,
    });
    for (const s of [
      ...(got?.stacks ?? []),
      ...(await listRuns(t.db, w.org.id, w.project.id, { limit: 5 })).flatMap((r) => r.stacks),
      row,
    ]) {
      expect(s && "planResources" in s).toBe(false);
    }
    expect(await getPlanResources(t.db, w.org.id, w.project.id, run.id, "net")).toEqual(
      summary.resources,
    );
    expect(await getPlanResources(t.db, w.org.id, w.project.id, run.id, "app")).toEqual([]);
  });

  test("a later summary replaces the first, whether or not it differs", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["net"]));
    await store(w, run.id, "net");
    await store(w, run.id, "net");
    await store(w, run.id, "net", { add: 0, change: 0, destroy: 0, resources: [] });
    const net = (await getRun(t.db, w.org.id, w.project.id, run.id))?.stacks[0];
    expect([net?.planAdd, net?.planChange, net?.planDestroy]).toEqual([0, 0, 0]);
    expect(await getPlanResources(t.db, w.org.id, w.project.id, run.id, "net")).toEqual([]);
  });

  test("the database refuses a cost that is not a finite estimate in a currency and a tool name, whatever the caller checked", async () => {
    const w = await world();
    const ok = { monthlyDelta: 10, monthlyTotal: 100, currency: "EUR", tool: "infracost" };
    const run = await createRun(t.db, input(w, ["net"]));
    expect((await store(w, run.id, "net", { ...summary, cost: ok }))?.costCurrency).toBe("EUR");
    for (const cost of [
      { ...ok, monthlyDelta: Number.NaN },
      { ...ok, monthlyDelta: Number.POSITIVE_INFINITY },
      { ...ok, monthlyTotal: -1 },
      { ...ok, monthlyDelta: 2e12 },
      { ...ok, currency: "eur" },
      { ...ok, tool: "Infra Cost" },
    ]) {
      expect(await refusedBy(store(w, run.id, "net", { ...summary, cost }))).toBe(
        "run_stacks_cost_check",
      );
    }
    // the refused summaries changed nothing
    const net = (await getRun(t.db, w.org.id, w.project.id, run.id))?.stacks[0];
    expect([net?.costMonthlyDelta, net?.costCurrency]).toEqual([10, "EUR"]);
  });

  test("only while the stack has no outcome: queued, planning and planned take one, the rest refuse", async () => {
    const w = await world();
    for (const status of RUN_STATES) {
      const run = await createRun(t.db, input(w, ["net"]));
      await setStatus(run.id, "net", status);
      const stored = await store(w, run.id, "net");
      expect(stored !== undefined, status).toBe(["queued", "planning", "planned"].includes(status));
      if (!stored) {
        const net = (await getRun(t.db, w.org.id, w.project.id, run.id))?.stacks[0];
        expect(net?.planAdd, status).toBeNull();
      }
    }
  });

  test("an id from another organization, project or run, or a stack that is not there, stores nothing", async () => {
    const w = await world();
    const other = await world();
    const run = await createRun(t.db, input(w, ["net"]));
    expect(
      await storePlanSummary(t.db, other.org.id, w.project.id, run.id, "net", summary),
    ).toBeUndefined();
    expect(
      await storePlanSummary(t.db, w.org.id, other.project.id, run.id, "net", summary),
    ).toBeUndefined();
    expect(await store(w, run.id, "web")).toBeUndefined();
    expect(await getPlanResources(t.db, other.org.id, w.project.id, run.id, "net")).toEqual([]);
    expect((await getRun(t.db, w.org.id, w.project.id, run.id))?.stacks[0]?.planAdd).toBeNull();
  });

  test("the database refuses a summary that is partial, negative or too big", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["net"]));
    const write = (set: Partial<typeof runStacks.$inferInsert>) =>
      t.db
        .update(runStacks)
        .set(set)
        .where(and(eq(runStacks.runId, run.id), eq(runStacks.stack, "net")));
    const whole = {
      planAdd: 1,
      planChange: 0,
      planDestroy: 0,
      planResources: [],
      summarizedAt: new Date(),
    };
    expect(await refusedBy(write({ planAdd: 1 }))).toBe("run_stacks_summary_check");
    expect(await refusedBy(write({ ...whole, planResources: null }))).toBe(
      "run_stacks_summary_check",
    );
    expect(await refusedBy(write({ ...whole, summarizedAt: null }))).toBe(
      "run_stacks_summary_check",
    );
    expect(await refusedBy(write({ ...whole, planChange: -1 }))).toBe("run_stacks_summary_check");
    expect(await refusedBy(write({ ...whole, planDestroy: -1 }))).toBe("run_stacks_summary_check");
    // the route limits the list to 500 resources; the database only bounds its size
    const big = [{ address: "x".repeat(4_000_001), actions: ["create"] }];
    expect(await refusedBy(write({ ...whole, planResources: big }))).toBe(
      "run_stacks_summary_check",
    );
    const fits = Array.from({ length: 500 }, (_, i) => ({
      address: `module.m["${"k".repeat(900)}"].r.a${i}`,
      actions: ["delete", "create"],
    }));
    expect(await refusedBy(write({ ...whole, planResources: fits }))).toBeUndefined();
    // the worst the route lets through: 500 addresses of 1024 characters that all need escaping
    const worst = Array.from({ length: 500 }, () => ({
      address: '"'.repeat(1024),
      actions: ["create", "create", "create", "create"],
    }));
    expect(await refusedBy(write({ ...whole, planResources: worst }))).toBeUndefined();
  });
});

describe("merge request runs", () => {
  const OLD = "b".repeat(40);
  const NEW = "c".repeat(40);
  const states = async (w: Awaited<ReturnType<typeof world>>, id: string) =>
    Object.fromEntries(
      (await getRun(t.db, w.org.id, w.project.id, id))?.stacks.map((s) => [
        s.stack,
        [s.status, s.error],
      ]) ?? [],
    );
  const plan = (w: Awaited<ReturnType<typeof world>>, runId: string, gitlabPipelineId: number) =>
    attachRunPipeline(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      runId,
      gitlabPipelineId,
      action: "plan",
    });

  test("the latest run of a merge request is the newest one of that merge request, and only of that project", async () => {
    const w = await world();
    const other = await world();
    expect(await latestRunOfMergeRequest(t.db, w.org.id, w.project.id, 7)).toBeUndefined();
    await createRun(t.db, input(w, ["a"], { mergeRequestIid: 7, sha: OLD }));
    await createRun(t.db, input(w, ["a"], { mergeRequestIid: 8, sha: OLD }));
    const newest = await createRun(t.db, input(w, ["a", "b"], { mergeRequestIid: 7, sha: NEW }));
    await createRun(t.db, input(w, ["a"], { sha: NEW }));
    await createRun(t.db, input(other, ["a"], { mergeRequestIid: 7, sha: OLD }));
    const found = await latestRunOfMergeRequest(t.db, w.org.id, w.project.id, 7);
    expect(found?.id).toBe(newest.id);
    expect(found?.stacks.map((s) => s.stack)).toEqual(["a", "b"]);
    // another organization's id for this project finds nothing
    expect(await latestRunOfMergeRequest(t.db, other.org.id, w.project.id, 7)).toBeUndefined();
  });

  test("a newer commit cancels what has not planned and discards what has, and says why", async () => {
    const w = await world();
    const stale = await createRun(
      t.db,
      input(w, ["queued", "planning", "planned", "failed", "applying"], {
        mergeRequestIid: 7,
        sha: OLD,
      }),
    );
    const move = (stack: string, ...to: RunState[]) =>
      to.reduce(async (from, next) => {
        const at = await from;
        await moveRunStack(t.db, w.org.id, w.project.id, stale.id, stack, at, next);
        return next;
      }, Promise.resolve<RunState>("queued"));
    await move("planning", "planning");
    await move("planned", "planning", "planned");
    await move("failed", "planning", "failed");
    await move("applying", "planning", "planned", "applying");
    await plan(w, stale.id, 501);
    await plan(w, stale.id, 502);
    const current = await createRun(t.db, input(w, ["queued"], { mergeRequestIid: 7, sha: NEW }));
    await plan(w, current.id, 503);

    expect(await supersedeRuns(t.db, w.org.id, w.project.id, 7, NEW)).toEqual({
      runs: [stale.id],
      pipelines: [501, 502],
    });
    const why = "superseded by a newer commit";
    expect(await states(w, stale.id)).toEqual({
      queued: ["canceled", why],
      planning: ["canceled", why],
      planned: ["discarded", why],
      failed: ["failed", null],
      // an apply that has begun is not cut off
      applying: ["applying", null],
    });
    expect(await states(w, current.id)).toEqual({ queued: ["queued", null] });
    // nothing left to do the second time, and no pipeline to stop
    expect(await supersedeRuns(t.db, w.org.id, w.project.id, 7, NEW)).toEqual({
      runs: [],
      pipelines: [],
    });
  });

  test("it touches only runs of that merge request, of that project, at another commit", async () => {
    const w = await world();
    const other = await world();
    const mine = await createRun(t.db, input(w, ["a"], { mergeRequestIid: 7, sha: OLD }));
    const sameCommit = await createRun(t.db, input(w, ["a"], { mergeRequestIid: 7, sha: NEW }));
    const otherMr = await createRun(t.db, input(w, ["a"], { mergeRequestIid: 8, sha: OLD }));
    const noMr = await createRun(t.db, input(w, ["a"], { sha: OLD }));
    const elsewhere = await createRun(t.db, input(other, ["a"], { mergeRequestIid: 7, sha: OLD }));
    for (const [i, r] of [mine, sameCommit, otherMr, noMr].entries()) await plan(w, r.id, 610 + i);
    await plan(other, elsewhere.id, 600);

    await supersedeRuns(t.db, w.org.id, w.project.id, 7, NEW);
    expect(await states(w, mine.id)).toEqual({ a: ["canceled", "superseded by a newer commit"] });
    for (const r of [sameCommit, otherMr, noMr])
      expect(await states(w, r.id)).toEqual({ a: ["queued", null] });
    expect(await states(other, elsewhere.id)).toEqual({ a: ["queued", null] });
    // an organization that is not the project's moves nothing
    expect(await supersedeRuns(t.db, other.org.id, w.project.id, 7, NEW)).toEqual({
      runs: [],
      pipelines: [],
    });
  });

  test("an apply pipeline of a stale run is not for stopping here", async () => {
    const w = await world();
    const stale = await createRun(t.db, input(w, ["a"], { mergeRequestIid: 7, sha: OLD }));
    await attachRunPipeline(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      runId: stale.id,
      gitlabPipelineId: 700,
      action: "apply",
    });
    // the run is stale and its stacks are canceled, but there is no plan pipeline to stop
    expect(await supersedeRuns(t.db, w.org.id, w.project.id, 7, NEW)).toEqual({
      runs: [stale.id],
      pipelines: [],
    });
    expect(await planPipelinesOfRun(t.db, w.org.id, w.project.id, stale.id)).toEqual([]);
    await plan(w, stale.id, 701);
    expect(await planPipelinesOfRun(t.db, w.org.id, w.project.id, stale.id)).toEqual([701]);
    expect(await planPipelinesOfRun(t.db, w.org.id, w.project.id, crypto.randomUUID())).toEqual([]);
  });
});

describe("the apply pipelines of a run", () => {
  test("are only the ones that apply, oldest first, and only the run's own", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["a", "b"]));
    const other = await createRun(t.db, input(w, ["a"]));
    const attach = (runId: string, id: number, action: "plan" | "apply") =>
      attachRunPipeline(t.db, {
        organizationId: w.org.id,
        projectId: w.project.id,
        runId,
        gitlabPipelineId: id,
        action,
      });
    await attach(run.id, 802, "apply");
    await attach(run.id, 800, "plan");
    await attach(run.id, 801, "apply");
    await attach(other.id, 803, "apply");
    expect(await applyPipelinesOfRun(t.db, w.org.id, w.project.id, run.id)).toEqual([801, 802]);
    expect(await applyPipelinesOfRun(t.db, w.org.id, w.project.id, other.id)).toEqual([803]);
    expect(await applyPipelinesOfRun(t.db, w.org.id, w.project.id, crypto.randomUUID())).toEqual(
      [],
    );
  });
});

describe("the connection of a run", () => {
  const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
  const read = (w: Awaited<ReturnType<typeof world>>, id: number, connectionId: string, at = 1) =>
    recordPipelineRun(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      connectionId,
      gitlabPipelineId: id,
      iid: id,
      status: "success",
      ref: "feature/net",
      sha: SHA,
      webUrl: `https://gitlab.example.com/p/-/pipelines/${id}`,
      failureReason: null,
      failedJob: null,
      observedAt: new Date(at * 1000),
    });
  const connection = (w: Awaited<ReturnType<typeof world>>, name: string) =>
    createConnection(t.db, keys, {
      organizationId: w.org.id,
      type: "gitlab",
      name,
      token: "glpat-SECRET-TOKEN-0123456789",
    }).then((c) => c.id);

  test("is the one that last read a pipeline of the run, and none before one was read", async () => {
    const w = await world();
    const run = await createRun(t.db, input(w, ["a"]));
    expect(await connectionOfRun(t.db, w.org.id, w.project.id, run.id)).toBeUndefined();
    await attachRunPipeline(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      runId: run.id,
      gitlabPipelineId: 900,
      action: "plan",
    });
    // attached, but not read yet
    expect(await connectionOfRun(t.db, w.org.id, w.project.id, run.id)).toBeUndefined();
    const first = await connection(w, "first");
    const second = await connection(w, "second");
    await read(w, 900, first, 1);
    expect(await connectionOfRun(t.db, w.org.id, w.project.id, run.id)).toBe(first);
    // a later pipeline of the run read through another connection wins
    await attachRunPipeline(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      runId: run.id,
      gitlabPipelineId: 901,
      action: "apply",
    });
    await read(w, 901, second, 2);
    expect(await connectionOfRun(t.db, w.org.id, w.project.id, run.id)).toBe(second);
  });

  test("is gone with the connection, and is never another project's or organization's", async () => {
    const w = await world();
    const other = await world();
    const run = await createRun(t.db, input(w, ["a"]));
    await attachRunPipeline(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      runId: run.id,
      gitlabPipelineId: 910,
      action: "plan",
    });
    const only = await connection(w, "only");
    await read(w, 910, only);
    expect(await connectionOfRun(t.db, other.org.id, w.project.id, run.id)).toBeUndefined();
    expect(await connectionOfRun(t.db, w.org.id, other.project.id, run.id)).toBeUndefined();
    expect(await connectionOfRun(t.db, w.org.id, w.project.id, run.id)).toBe(only);
    await deleteConnection(t.db, w.org.id, only);
    expect(await connectionOfRun(t.db, w.org.id, w.project.id, run.id)).toBeUndefined();
  });
});
