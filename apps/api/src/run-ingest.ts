import {
  type Outcome,
  outcomeOfJob,
  outcomeOfMissingJob,
  pathTo,
  type RunAction,
  type RunState,
} from "@orch/core";
import {
  getRun,
  linkedProjects,
  moveRunStack,
  type RunStack,
  recordStackJobs,
  runOfPipeline,
} from "@orch/db";
import type { Job } from "@orch/gitlab";
import { hopeless, pipelineEvent, type RunDeps } from "./pipeline-runs";
import type { JobHandler } from "./worker";

// A run's pipeline has two jobs per stack and a run at most a hundred stacks; a pipeline with more
// jobs than this is not one a run made.
const MAX_JOBS = 1000;
// How often a stack is walked again after another handler moved it first.
const MAX_TRIES = 3;
// The states a pipeline's events may move a stack out of: a plan only acts before there is a plan, an
// apply only on a stack whose apply has begun (whoever starts an apply moves it into `applying`).
const PLAN_FROM = ["queued", "planning"] as const;
const APPLY_FROM = ["applying"] as const;

/** The names of the generated jobs (IAC-4): `plan:<stack>`, `summary:<stack>` and `apply:<stack>`. */
const JOB_NAME = /^(plan|summary|apply):(.+)$/;

type Kind = "plan" | "summary" | "apply";
type StackJobs = Partial<Record<Kind, Job>>;

/** The newest job (the highest id: a retry is a new job) of each kind, for each stack. */
export function jobsByStack(jobs: readonly Job[]) {
  const out = new Map<string, StackJobs>();
  for (const job of jobs) {
    const m = JOB_NAME.exec(job.name);
    if (!m) continue;
    const [, kind, stack] = m as unknown as [string, Kind, string];
    const mine = out.get(stack) ?? {};
    const have = mine[kind];
    if (!have || job.id > have.id) mine[kind] = job;
    out.set(stack, mine);
  }
  return out;
}

/**
 * Moves a stack to where its job says, through the states in between, as long as it is in one of
 * `from`: the states this kind of pipeline may move a stack out of. A step finds the stack moved
 * (another handler read a later state first) when it is no longer where this one saw it: then the
 * stack is read again, and the rest of the way is worked out from where it is, if that is still
 * in `from`.
 */
async function walk(
  deps: RunDeps,
  at: { organizationId: string; projectId: string; runId: string },
  stack: RunStack,
  outcome: Outcome,
  from: readonly string[],
) {
  let now: RunStack | undefined = stack;
  for (let tries = 0; tries < MAX_TRIES && now; tries++) {
    if (!from.includes(now.status)) return;
    const path = pathTo(now.status, outcome.to);
    if (!path?.length) return;
    let state = now.status as RunState;
    let moved = true;
    for (const [i, to] of path.entries()) {
      const row = await moveRunStack(
        deps.db,
        at.organizationId,
        at.projectId,
        at.runId,
        stack.stack,
        state,
        to,
        i === path.length - 1 ? outcome.error : undefined,
      );
      if (!row) {
        moved = false;
        break;
      }
      state = to;
    }
    if (moved) return;
    now = (await getRun(deps.db, at.organizationId, at.projectId, at.runId))?.stacks.find(
      (s) => s.stack === stack.stack,
    );
  }
}

/**
 * The `gitlab.event` consumer for runs (IAC-6). A pipeline event only says that a pipeline
 * changed, so the job reads the pipeline and its jobs from GitLab and moves each stack of the run
 * to where its job says it is: a repeated event reads the same thing, a late one reads the present,
 * and a stack never goes back (see `pathTo`). An event for a pipeline that no run started (the
 * table `run_pipelines` says which are) is ignored, so is one that no retry could serve (the
 * pipeline or connection is gone, GitLab refuses the token); any other failure fails the job so the
 * queue retries it.
 *
 * - A plan pipeline moves `queued` and `planning` stacks along `plan:<stack>`, and notes the ids of
 *   the stack's plan and summary jobs: the summary route lets only that summary job post.
 * - An apply pipeline moves only stacks that are `applying` along `apply:<stack>`: entering
 *   `applying` takes the mutex and belongs to whoever starts the apply (IAC-8).
 */
export const runEventHandler =
  (deps: RunDeps): JobHandler =>
  async (ctx) => {
    const parsed = pipelineEvent.safeParse(ctx.payload);
    if (!parsed.success) return;
    const e = parsed.data;
    const [project] = await linkedProjects(deps.db, e.organizationId, [e.projectId]);
    if (!project) return;
    const found = await runOfPipeline(deps.db, e.organizationId, project.id, e.pipelineId);
    if (!found) return;
    const { run, action } = found;

    let status: string;
    const jobs: Job[] = [];
    try {
      const gitlab = await deps.gitlab(e.organizationId, e.connectionId);
      status = (await gitlab.pipelines.get(e.projectId, e.pipelineId)).status;
      for await (const job of gitlab.pipelines.jobs(e.projectId, e.pipelineId)) {
        jobs.push(job);
        if (jobs.length > MAX_JOBS) break;
      }
    } catch (error) {
      const why = hopeless(error);
      if (!why) throw error;
      ctx.log.warn("run event dropped", { reason: why, connection: e.connectionId });
      return;
    }
    if (jobs.length > MAX_JOBS) {
      ctx.log.warn("run event dropped", { reason: "the pipeline has too many jobs" });
      return;
    }

    const at = { organizationId: e.organizationId, projectId: project.id, runId: run.id };
    const byStack = jobsByStack(jobs);
    for (const stack of run.stacks) {
      const mine = byStack.get(stack.stack) ?? {};
      if (action === "plan") {
        const ids = { planJobId: mine.plan?.id, summaryJobId: mine.summary?.id };
        await recordStackJobs(deps.db, at.organizationId, at.projectId, at.runId, stack.stack, {
          planJobId: ids.planJobId === stack.planJobId ? undefined : ids.planJobId,
          summaryJobId: ids.summaryJobId === stack.summaryJobId ? undefined : ids.summaryJobId,
        });
      }
      const outcome = outcomeFor(action, mine, status);
      if (outcome) await walk(deps, at, stack, outcome, action === "plan" ? PLAN_FROM : APPLY_FROM);
    }
    ctx.log.debug("run event handled", { action, status, jobs: jobs.length });
  };

function outcomeFor(action: RunAction, mine: StackJobs, pipelineStatus: string) {
  if (action === "apply") return mine.apply ? outcomeOfJob("apply", mine.apply.status) : undefined;
  return mine.plan ? outcomeOfJob("plan", mine.plan.status) : outcomeOfMissingJob(pipelineStatus);
}
