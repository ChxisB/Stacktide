import {
  type Outcome,
  outcomeOfJob,
  outcomeOfMissingJob,
  pathTo,
  type RunAction,
  type RunState,
} from "@orch/core";
import {
  applyPipelinesOfRun,
  describeError,
  getRun,
  linkedProjects,
  moveRunStack,
  type RunStack,
  recordStackJobs,
  runOfPipeline,
  setStackApproval,
} from "@orch/db";
import { GitlabError, type Job } from "@orch/gitlab";
import { z } from "zod";
import { type NoteForge, refreshNote } from "./mr-note";
import {
  type EventDeps,
  githubRunEvent,
  hopeless,
  pipelineEvent,
  type RunDeps,
  type RunForge,
} from "./pipeline-runs";
import type { JobHandler } from "./worker";

// A run's pipeline has up to four jobs per stack (plan, estimate, summary, apply) and a run at most a
// hundred stacks; a pipeline with more jobs than this is not one a run made.
const MAX_JOBS = 1000;
// The generated pipeline is one child of the pipeline the run started; an author's own
// `.gitlab-ci.yml` may start more, and a pipeline with more than this is not one a run made.
const MAX_CHILDREN = 20;
// How often a stack is walked again after another handler moved it first.
const MAX_TRIES = 3;
// The states a pipeline's events may move a stack out of: a plan only acts before there is a plan, an
// apply only on a stack whose apply has begun (whoever starts an apply moves it into `applying`).
const PLAN_FROM = ["queued", "planning"] as const;
const APPLY_FROM = ["applying"] as const;

/**
 * The names of the generated jobs (IAC-4): `plan:<stack>`, `summary:<stack>` and `apply:<stack>`. The
 * `estimate:<stack>` job (COST-4) is left out on purpose: no state of a stack follows from it, and a
 * failed estimate shows as the plan having no cost, which the apply denies as `cost-unavailable`.
 */
const JOB_NAME = /^(plan|summary|apply):(.+)$/;

// A child pipeline's event names the pipeline that started it. Only a hint, for finding the pipeline
// a run started: what the run is, and what its jobs say, is read from GitLab. Anything else in these
// fields is no hint.
const runEvent = pipelineEvent.extend({
  sourcePipelineId: z.number().int().positive().optional().catch(undefined),
  sourceProjectId: z.number().int().positive().optional().catch(undefined),
});

/** A job's page, kept only as an http(s) link of a sane length: it is shown to people as a link, and a forge's word is not trusted. */
export function safeLink(url: string): string | null {
  if (url.length === 0 || url.length > 2000) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

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
 *
 * A GitHub workflow run is the same thing read through the connection's forge (FRG-22): its events are
 * `workflow_run`, `workflow_job` and `deployment_review`, and the repository is found by the connection. GitHub
 * holds an apply job for the environment's reviewers (read as `manual`), so such a stack stays `applying` and carries
 * the job's page until the job goes on: the platform makes no approval, a person does, in GitHub.
 */
export const runEventHandler =
  (deps: EventDeps): JobHandler =>
  async (ctx) => {
    const github = githubRunEvent.safeParse(ctx.payload);
    const lab = github.success ? undefined : runEvent.safeParse(ctx.payload);
    const e = github.success ? github.data : lab?.success ? lab.data : undefined;
    if (!e) return;
    const open = github.success ? deps.forge : deps.gitlab;
    if (!open) {
      ctx.log.warn("run event dropped", { reason: "no way to open the connection" });
      return;
    }
    const [project] = await linkedProjects(
      deps.db,
      e.organizationId,
      [e.projectId],
      github.success ? e.connectionId : undefined,
    );
    if (!project) return;
    // the pipeline a run started: the event's own, or the parent of the child pipeline it is of
    // (a workflow run has no parent: only a GitLab child pipeline names the pipeline that started it)
    const parent = lab?.success && lab.data.sourceProjectId === e.projectId;
    const root = parent ? (lab.data.sourcePipelineId ?? e.pipelineId) : e.pipelineId;
    const found = await runOfPipeline(deps.db, e.organizationId, project.id, root);
    if (!found) return;
    const { run, action } = found;

    let status: string;
    let jobs: Job[];
    let client: RunForge & NoteForge;
    try {
      client = await open(e.organizationId, e.connectionId);
      ({ status, jobs } = await readPipeline(client, e.projectId, root));
    } catch (error) {
      if (error instanceof TooBig) {
        ctx.log.warn("run event dropped", { reason: error.message });
        return;
      }
      const why = hopeless(error);
      if (!why) throw error;
      ctx.log.warn("run event dropped", { reason: why, connection: e.connectionId });
      return;
    }

    const at = { organizationId: e.organizationId, projectId: project.id, runId: run.id };
    const byStack = jobsByStack(jobs);
    // A stack with no job in an apply pipeline may be applying in another one of the run's. Only
    // when this is the run's one apply pipeline does a missing job mean it never ran.
    // shortcut: with several, a stack whose own pipeline made no job stays `applying` (and holds
    // its mutex); upgrade by recording the pipeline that claimed each stack.
    const alone =
      action !== "apply" ||
      (await applyPipelinesOfRun(deps.db, at.organizationId, at.projectId, at.runId)).length === 1;
    for (const stack of run.stacks) {
      const mine = byStack.get(stack.stack) ?? {};
      if (action === "plan") {
        const ids = { planJobId: mine.plan?.id, summaryJobId: mine.summary?.id };
        await recordStackJobs(deps.db, at.organizationId, at.projectId, at.runId, stack.stack, {
          planJobId: ids.planJobId === stack.planJobId ? undefined : ids.planJobId,
          summaryJobId: ids.summaryJobId === stack.summaryJobId ? undefined : ids.summaryJobId,
        });
      }
      const outcome = outcomeFor(action, mine, status, alone);
      if (outcome) await walk(deps, at, stack, outcome, action === "plan" ? PLAN_FROM : APPLY_FROM);
      if (github.success && action === "apply") {
        // held for reviewers: the job's page, until it goes on (a stack that moved on keeps none)
        const held = mine.apply?.status === "manual" ? safeLink(mine.apply.webUrl) : null;
        await setStackApproval(
          deps.db,
          at.organizationId,
          at.projectId,
          at.runId,
          stack.stack,
          held,
        );
      }
    }
    ctx.log.debug("run event handled", { action, status, jobs: jobs.length });

    // shortcut: the note is written after every event of the newest run, changed or not, and a
    // failed write waits for the next event; upgrade by keeping a hash of the body when GitLab's
    // limits on notes bite.
    if (run.mergeRequestIid !== null) {
      try {
        const where = { ...at, gitlabProjectId: e.projectId };
        // the client is the forge's own (`open`), which writes notes whichever forge it is
        await refreshNote(deps, where, run.mergeRequestIid, client, run.id);
      } catch (error) {
        ctx.log.warn("could not update the merge request note", { error: describeError(error) });
      }
    }
  };

class TooBig extends Error {}

/**
 * The status of the pipeline a run started and the jobs of it and of its child pipelines: the
 * generated pipeline is a child of the project's own (docs/iac.md). A child GitLab does not show
 * (one in another project, or gone) has no jobs to add.
 */
export async function readPipeline(gitlab: RunForge, project: number, root: number) {
  const { status } = await gitlab.pipelines.get(project, root);
  const jobs: Job[] = [];
  const add = async (id: number) => {
    for await (const job of gitlab.pipelines.jobs(project, id)) {
      jobs.push(job);
      if (jobs.length > MAX_JOBS) throw new TooBig("the pipeline has too many jobs");
    }
  };
  await add(root);
  let children = 0;
  for await (const bridge of gitlab.pipelines.bridges(project, root)) {
    if (bridge.downstreamPipelineId === null) continue;
    if (++children > MAX_CHILDREN) throw new TooBig("the pipeline has too many child pipelines");
    try {
      await add(bridge.downstreamPipelineId);
    } catch (error) {
      if (!(error instanceof GitlabError && error.kind === "not_found")) throw error;
    }
  }
  return { status, jobs };
}

function outcomeFor(
  action: RunAction,
  mine: StackJobs,
  pipelineStatus: string,
  alone: boolean,
): Outcome | undefined {
  if (action === "apply") {
    if (mine.apply) return outcomeOfJob("apply", mine.apply.status);
    if (!alone) return undefined;
    // The pipeline ended with no job for the stack: whoever started the apply holds the stack's
    // mutex until it ends, and an apply that has begun can only end applied or failed.
    const missing = outcomeOfMissingJob(pipelineStatus);
    return missing?.to === "canceled" ? { to: "failed", error: "the apply was canceled" } : missing;
  }
  return mine.plan ? outcomeOfJob("plan", mine.plan.status) : outcomeOfMissingJob(pipelineStatus);
}
