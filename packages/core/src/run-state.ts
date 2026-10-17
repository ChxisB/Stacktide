/**
 * The states of one stack in a run (IAC-5). A run has no state of its own: it is as far along as
 * its stacks are, and each stack moves on its own.
 *
 *   queued -> planning -> planned -> applying -> applied
 *
 * `canceled` is a stop before there is a plan (queued or planning), `discarded` throws away a plan
 * that exists and was never applied, and an apply that has begun can only end `applied` or
 * `failed`: its outcome is read from the job, never guessed. Nothing leaves a finished state; to
 * try again, start a new run.
 */
export const RUN_STATES = [
  "queued",
  "planning",
  "planned",
  "applying",
  "applied",
  "failed",
  "discarded",
  "canceled",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["planning", "canceled", "failed"],
  planning: ["planned", "failed", "canceled"],
  planned: ["applying", "discarded"],
  applying: ["applied", "failed"],
  applied: [],
  failed: [],
  discarded: [],
  canceled: [],
};

const known = (state: string): state is RunState => Object.hasOwn(TRANSITIONS, state);

/** Total: a name that is not a state (also one an object has, like `constructor`) is a no. */
export const canTransition = (from: string, to: string) =>
  known(from) && known(to) && TRANSITIONS[from].includes(to);

/** Nothing moves a finished run again. */
export const isFinishedRun = (state: string) => known(state) && TRANSITIONS[state].length === 0;

/** The two kinds of pipeline a run has (IAC-4): one that plans stacks and one that applies their plans. */
export const RUN_ACTIONS = ["plan", "apply"] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

/**
 * The states between `from` and `to`, the shortest way and ending with `to` (empty when they are the
 * same state), or `undefined` when the lifecycle has no way there. Events can be missed or arrive
 * late, so a stack whose job already finished is walked through the states it did not see. Never
 * *through* `applying`: entering it takes the stack's apply lock, which only whoever starts an apply
 * may do, so `planned -> failed` is no way (and `planned -> applying` is one, as the target).
 */
export function pathTo(from: string, to: string): RunState[] | undefined {
  if (!(known(from) && known(to))) return undefined;
  if (from === to) return [];
  const came = new Map<RunState, RunState>();
  const todo: RunState[] = [from];
  for (let at = todo.shift(); at !== undefined; at = todo.shift()) {
    for (const next of TRANSITIONS[at]) {
      if (next === from || came.has(next) || (next === "applying" && to !== next)) continue;
      came.set(next, at);
      if (next === to) {
        const path: RunState[] = [];
        for (let s: RunState | undefined = to; s !== undefined && s !== from; s = came.get(s)) {
          path.unshift(s);
        }
        return path;
      }
      todo.push(next);
    }
  }
  return undefined;
}

/** Where a stack should be, and why when that is a stop; `error` is in fixed words, never a tool's output. */
export interface Outcome {
  to: RunState;
  error?: string;
}

/**
 * What the state of a stack's job says about the stack, or `undefined` when it says nothing yet. A
 * plan job that never ran (`skipped`: a stack it needed failed, or the pipeline stopped) leaves no
 * plan, so the stack is `canceled`; an apply that has begun can only end `applied` or `failed`.
 * shortcut: GitLab's `skipped` is read this way without a real pipeline to confirm it; upgrade with
 * the first real run.
 */
export function outcomeOfJob(action: RunAction, jobStatus: string): Outcome | undefined {
  if (action === "plan") {
    switch (jobStatus) {
      case "running":
      case "canceling":
        return { to: "planning" };
      case "success":
        return { to: "planned" };
      case "failed":
        return { to: "failed", error: "the plan failed" };
      case "canceled":
      case "skipped":
        return { to: "canceled" };
      default:
        return undefined;
    }
  }
  switch (jobStatus) {
    case "success":
      return { to: "applied" };
    case "failed":
      return { to: "failed", error: "the apply failed" };
    case "canceled":
      return { to: "failed", error: "the apply was canceled" };
    case "skipped":
      return { to: "failed", error: "the apply was skipped" };
    default:
      return undefined;
  }
}

/**
 * What a finished pipeline that has no job for a stack says about it: a pipeline that was canceled
 * stops the stack, any other end means a plan that could not be made. Nothing for a pipeline that
 * is still going.
 */
export function outcomeOfMissingJob(pipelineStatus: string): Outcome | undefined {
  if (pipelineStatus === "canceled") return { to: "canceled" };
  if (["success", "failed", "skipped"].includes(pipelineStatus)) {
    return { to: "failed", error: "no job ran for this stack" };
  }
  return undefined;
}
