/**
 * What a resource is, as the screens and the CLI say it. Never stored: it is read from the resource's
 * stack (ADR-0024, feature 34's rule), so it cannot disagree with the stack.
 */
export const RESOURCE_STATES = ["proposed", "applying", "ready", "failed"] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

/**
 * The state of a resource from the newest run state of its stack, and whether the stack was ever
 * applied. Only an apply changes the cloud, so a plan, a discard or a cancel leaves a resource as it
 * was: `ready` if it had been applied, else still `proposed`.
 *
 * shortcut: `failed` is the stack's newest run failing, a plan or an apply (the run state does not
 * say which), so a live resource whose change fails to plan shows `failed`; split it when a screen needs it.
 */
export function resourceStateOf(newest: string | undefined, everApplied: boolean): ResourceState {
  if (newest === "applying") return "applying";
  if (newest === "applied") return "ready";
  if (newest === "failed") return "failed";
  return everApplied ? "ready" : "proposed";
}
