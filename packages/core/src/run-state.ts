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
