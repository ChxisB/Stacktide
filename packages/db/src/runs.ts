import {
  type CostResult,
  canTransition,
  isFinishedRun,
  type RunAction,
  type RunState,
} from "@orch/core";
import { and, desc, eq, getTableColumns, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { pipelineRuns, runPipelines, runStacks, runs } from "./schema";

// What the plan would do can be 500 resources long and is read by `getPlanResources` only: every
// other read of a stack leaves it out.
const { planResources: _resources, ...stackColumns } = getTableColumns(runStacks);
export type RunStack = Omit<typeof runStacks.$inferSelect, "planResources">;
export type RunWithStacks = typeof runs.$inferSelect & { stacks: RunStack[] };
export type NewRun = Pick<
  typeof runs.$inferInsert,
  "organizationId" | "projectId" | "ref" | "sha" | "mergeRequestIid" | "kind"
> & {
  /** Names of the stacks to run. The caller has checked that they exist. */
  stacks: readonly string[];
  /** Each stack's tags in the commit, by stack name; a stack left out has none. */
  tags?: Readonly<Record<string, readonly string[]>>;
};

// shortcut: a run holds at most 100 stacks (what the run route accepts and the merge request planner
// plans); upgrade when a repository really has more than that to plan at once.
export const MAX_RUN_STACKS = 100;

/** What an audit event says of a run's stacks: a hundred long names would not fit its 4096 bytes. */
export const auditedStacks = (names: readonly string[]) => ({
  stackCount: names.length,
  stacks: names.slice(0, 20),
});

/** A move the lifecycle of `@orch/core` does not have: a bug in the caller, not a late event. */
export class IllegalTransition extends Error {
  constructor(from: string, to: string) {
    super(`a stack cannot go from ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
    this.name = "IllegalTransition";
  }
}

// By code point, here and not in SQL: a database collation may order `a-b` and `ab` the other way,
// and a run must list its stacks in the same order when it is made and when it is read.
const byStack = (a: RunStack, b: RunStack) => (a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0);

const withStacks = async (db: Executor, rows: (typeof runs.$inferSelect)[]) => {
  if (rows.length === 0) return [];
  const stacks = await db
    .select(stackColumns)
    .from(runStacks)
    .where(
      inArray(
        runStacks.runId,
        rows.map((r) => r.id),
      ),
    );
  const of = Object.groupBy(stacks.sort(byStack), (s) => s.runId);
  return rows.map((run) => ({ ...run, stacks: of[run.id] ?? [] }));
};

/** A run with each of its stacks `queued`. All or nothing. */
export async function createRun(db: Executor, input: NewRun): Promise<RunWithStacks> {
  const { stacks, tags, ...fields } = input;
  if (stacks.length === 0) throw new Error("a run needs at least one stack");
  return db.transaction(async (tx) => {
    const run = (await tx.insert(runs).values(fields).returning())[0];
    if (!run) throw new Error("insert returned no row");
    const rows = await tx
      .insert(runStacks)
      .values(
        stacks.map((stack) => ({
          runId: run.id,
          organizationId: run.organizationId,
          projectId: run.projectId,
          stack,
          tags: [...(tags?.[stack] ?? [])],
        })),
      )
      .returning(stackColumns);
    return { ...run, stacks: rows.sort(byStack) };
  });
}

// Every lookup repeats the organization and the project, so an id from elsewhere matches nothing.
const inProject = (organizationId: string, projectId: string) =>
  and(eq(runs.projectId, projectId), eq(runs.organizationId, organizationId));

export async function getRun(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
): Promise<RunWithStacks | undefined> {
  const rows = await db
    .select()
    .from(runs)
    .where(and(inProject(organizationId, projectId), eq(runs.id, id)));
  return (await withStacks(db, rows))[0];
}

/** A project's runs, newest first (ids are time-ordered), after the run `before`. */
export async function listRuns(
  db: Executor,
  organizationId: string,
  projectId: string,
  o: { before?: string | undefined; limit: number },
): Promise<RunWithStacks[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(
      and(
        inProject(organizationId, projectId),
        o.before === undefined ? undefined : lt(runs.id, o.before),
      ),
    )
    .orderBy(desc(runs.id))
    .limit(o.limit);
  return withStacks(db, rows);
}

/**
 * Moves one stack of a run from `from` to `to`, only if it is still in `from`: a repeated or late
 * event finds it moved on and gets `undefined`, and changes nothing. A pair the lifecycle does not
 * have throws `IllegalTransition`. `error` says why, in fixed words and never a tool's output; only a
 * move into a finished state keeps one (nothing moves out of those), any other drops it. Moving into `applying` fails
 * with the constraint `run_stacks_one_applying` while another run is applying the same stack.
 */
export async function moveRunStack(
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
  stack: string,
  from: RunState,
  to: RunState,
  error?: string,
): Promise<RunStack | undefined> {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
  const [row] = await db
    .update(runStacks)
    .set({ status: to, error: isFinishedRun(to) ? (error ?? null) : null })
    .where(
      and(
        eq(runStacks.runId, runId),
        eq(runStacks.stack, stack),
        eq(runStacks.projectId, projectId),
        eq(runStacks.organizationId, organizationId),
        eq(runStacks.status, from),
      ),
    )
    .returning(stackColumns);
  return row;
}

export interface NewRunPipeline {
  organizationId: string;
  projectId: string;
  runId: string;
  /** GitLab's id of the pipeline. */
  gitlabPipelineId: number;
  action: RunAction;
}

/**
 * Records that a GitLab pipeline belongs to a run, so that its events can be matched to it. A
 * pipeline belongs to one run; a second claim, or a run of another project, throws.
 */
export async function attachRunPipeline(db: Executor, input: NewRunPipeline): Promise<void> {
  await db.insert(runPipelines).values(input);
}

/**
 * The connection that last read one of the run's pipelines: the one that has reached its project in
 * GitLab, for whoever must talk to GitLab about the run. None before a pipeline was read, or once
 * that connection is deleted.
 */
export async function connectionOfRun(
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ connectionId: pipelineRuns.connectionId })
    .from(runPipelines)
    .innerJoin(
      pipelineRuns,
      and(
        eq(pipelineRuns.projectId, runPipelines.projectId),
        eq(pipelineRuns.gitlabPipelineId, runPipelines.gitlabPipelineId),
      ),
    )
    .where(
      and(
        eq(runPipelines.organizationId, organizationId),
        eq(runPipelines.projectId, projectId),
        eq(runPipelines.runId, runId),
        eq(pipelineRuns.organizationId, organizationId),
        isNotNull(pipelineRuns.connectionId),
      ),
    )
    .orderBy(desc(pipelineRuns.observedAt), desc(pipelineRuns.gitlabPipelineId))
    .limit(1);
  return row?.connectionId ?? undefined;
}

/** The run a GitLab pipeline belongs to and what the pipeline does, if it is a run's. */
export async function runOfPipeline(
  db: Executor,
  organizationId: string,
  projectId: string,
  gitlabPipelineId: number,
): Promise<{ run: RunWithStacks; action: RunAction } | undefined> {
  const [link] = await db
    .select()
    .from(runPipelines)
    .where(
      and(
        eq(runPipelines.organizationId, organizationId),
        eq(runPipelines.projectId, projectId),
        eq(runPipelines.gitlabPipelineId, gitlabPipelineId),
      ),
    );
  if (!link) return undefined;
  const run = await getRun(db, organizationId, projectId, link.runId);
  return run && { run, action: link.action as RunAction };
}

const stackOf = (organizationId: string, projectId: string, runId: string, stack: string) =>
  and(
    eq(runStacks.runId, runId),
    eq(runStacks.stack, stack),
    eq(runStacks.projectId, projectId),
    eq(runStacks.organizationId, organizationId),
  );

/**
 * Notes the GitLab jobs of a stack: the one that plans it and the one that posts its summary. The
 * latest seen wins, since a retried job is a new job. Only what is given is changed.
 */
export async function recordStackJobs(
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
  stack: string,
  jobs: { planJobId?: number | undefined; summaryJobId?: number | undefined },
): Promise<void> {
  // A retried plan job is a new plan: the policy's verdict and the cost estimate were of the old one, so they go (POL-3, COST-1).
  // The summary job's retry posts a new one; until then the stack is not judged, and apply waits.
  const forgotten = <T>(column: T) =>
    sql`case when ${runStacks.planJobId} is distinct from ${jobs.planJobId} then null else ${column} end`;
  const set = {
    ...(jobs.planJobId === undefined
      ? {}
      : {
          planJobId: jobs.planJobId,
          policyVerdict: forgotten(runStacks.policyVerdict),
          policyDenied: forgotten(runStacks.policyDenied),
          policyWarned: forgotten(runStacks.policyWarned),
          policyAt: forgotten(runStacks.policyAt),
          // the estimate was of the old plan, as the verdict was (COST-1)
          costMonthlyDelta: forgotten(runStacks.costMonthlyDelta),
          costMonthlyTotal: forgotten(runStacks.costMonthlyTotal),
          costCurrency: forgotten(runStacks.costCurrency),
          costTool: forgotten(runStacks.costTool),
        }),
    ...(jobs.summaryJobId === undefined ? {} : { summaryJobId: jobs.summaryJobId }),
  };
  if (Object.keys(set).length === 0) return;
  await db
    .update(runStacks)
    .set(set)
    .where(stackOf(organizationId, projectId, runId, stack));
}

export interface PlanSummary {
  add: number;
  change: number;
  destroy: number;
  /** At most 500: the counts say how many there are. */
  resources: readonly { address: string; actions: readonly string[] }[];
  /** The estimator's answer, when the plan job had one (COST-1); posting none removes an earlier one. */
  cost?: PlanCost | undefined;
}

/** What a plan is estimated to cost per month, in one currency that is never converted. */
export type PlanCost = CostResult;

/** The estimate a stack's plan summary carried, or `null` when it had none (the columns are all set or all null). */
export const planCostOf = (
  s: Pick<RunStack, "costMonthlyDelta" | "costMonthlyTotal" | "costCurrency" | "costTool">,
): PlanCost | null =>
  s.costMonthlyDelta === null ||
  s.costMonthlyTotal === null ||
  s.costCurrency === null ||
  s.costTool === null
    ? null
    : {
        monthlyDelta: s.costMonthlyDelta,
        monthlyTotal: s.costMonthlyTotal,
        currency: s.costCurrency,
        tool: s.costTool,
      };

/**
 * Stores what a stack's plan would do, replacing an earlier summary (a job may post twice), while
 * the stack is still `queued`, `planning` or `planned`. `undefined` when it is not: after that the
 * plan is applied or gone and the summary is no longer news.
 */
export async function storePlanSummary(
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
  stack: string,
  summary: PlanSummary,
): Promise<RunStack | undefined> {
  const [row] = await db
    .update(runStacks)
    .set({
      planAdd: summary.add,
      planChange: summary.change,
      planDestroy: summary.destroy,
      planResources: summary.resources,
      summarizedAt: new Date(),
      costMonthlyDelta: summary.cost?.monthlyDelta ?? null,
      costMonthlyTotal: summary.cost?.monthlyTotal ?? null,
      costCurrency: summary.cost?.currency ?? null,
      costTool: summary.cost?.tool ?? null,
    })
    .where(
      and(
        stackOf(organizationId, projectId, runId, stack),
        inArray(runStacks.status, ["queued", "planning", "planned"]),
      ),
    )
    .returning(stackColumns);
  return row;
}

/** The resources a stack's plan would change, as its summary listed them; empty before there is one. */
export async function getPlanResources(
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
  stack: string,
): Promise<PlanSummary["resources"]> {
  const [row] = await db
    .select({ resources: runStacks.planResources })
    .from(runStacks)
    .where(stackOf(organizationId, projectId, runId, stack));
  return (row?.resources ?? []) as PlanSummary["resources"];
}

/** The newest run a merge request has had, with its stacks. */
export async function latestRunOfMergeRequest(
  db: Executor,
  organizationId: string,
  projectId: string,
  mergeRequestIid: number,
): Promise<RunWithStacks | undefined> {
  const rows = await db
    .select()
    .from(runs)
    .where(and(inProject(organizationId, projectId), eq(runs.mergeRequestIid, mergeRequestIid)))
    .orderBy(desc(runs.id))
    .limit(1);
  return (await withStacks(db, rows))[0];
}

const SUPERSEDED = "superseded by a newer commit";

/**
 * A new commit on a merge request makes its earlier runs stale: their stacks that have not finished
 * planning are `canceled` and those with a plan are `discarded`, so that no stale plan is applied
 * (a stack whose apply has begun is not touched). Returns the runs it changed, for the caller to
 * record, and GitLab's ids of their plan pipelines, for the caller to stop; a second call finds
 * nothing left to do.
 */
export async function supersedeRuns(
  db: Executor,
  organizationId: string,
  projectId: string,
  mergeRequestIid: number,
  currentSha: string,
): Promise<{ runs: string[]; pipelines: number[] }> {
  return db.transaction(async (tx) => {
    const stale = tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          inProject(organizationId, projectId),
          eq(runs.mergeRequestIid, mergeRequestIid),
          ne(runs.sha, currentSha),
        ),
      );
    const touched = new Set<string>();
    for (const [from, to] of [
      [["queued", "planning"], "canceled"],
      [["planned"], "discarded"],
    ] as const) {
      const moved = await tx
        .update(runStacks)
        .set({ status: to, error: SUPERSEDED })
        .where(
          and(
            eq(runStacks.projectId, projectId),
            eq(runStacks.organizationId, organizationId),
            inArray(runStacks.runId, stale),
            inArray(runStacks.status, from),
          ),
        )
        .returning({ runId: runStacks.runId });
      for (const m of moved) touched.add(m.runId);
    }
    if (touched.size === 0) return { runs: [], pipelines: [] };
    const rows = await tx
      .select({ id: runPipelines.gitlabPipelineId })
      .from(runPipelines)
      .where(and(inArray(runPipelines.runId, [...touched]), eq(runPipelines.action, "plan")))
      .orderBy(runPipelines.gitlabPipelineId);
    return { runs: [...touched].sort(), pipelines: rows.map((r) => r.id) };
  });
}

const pipelinesOfRun = async (
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
  action: RunAction,
): Promise<number[]> => {
  const rows = await db
    .select({ id: runPipelines.gitlabPipelineId })
    .from(runPipelines)
    .where(
      and(
        eq(runPipelines.organizationId, organizationId),
        eq(runPipelines.projectId, projectId),
        eq(runPipelines.runId, runId),
        eq(runPipelines.action, action),
      ),
    )
    .orderBy(runPipelines.gitlabPipelineId);
  return rows.map((r) => r.id);
};

/** GitLab's ids of the pipelines that plan a run, oldest first. */
export const planPipelinesOfRun = (
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
) => pipelinesOfRun(db, organizationId, projectId, runId, "plan");

/** GitLab's ids of the pipelines that apply a run's plans, oldest first. */
export const applyPipelinesOfRun = (
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
) => pipelinesOfRun(db, organizationId, projectId, runId, "apply");
