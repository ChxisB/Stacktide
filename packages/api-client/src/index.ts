import { type Treaty, treaty } from "@elysiajs/eden";
import type { App, Problem } from "@orch/api";

export type { App, Problem } from "@orch/api";

/**
 * Typed client for the control-plane API, derived from the app's routes: a renamed route or a
 * changed body fails to compile. `target` is the API origin, or the app itself (tests, in-process).
 */
export const createClient = (target: string | App, config?: Treaty.Config) =>
  treaty<App>(target, config);

export type Client = ReturnType<typeof createClient>;

// Eden types `error` as `unknown` here: Elysia adds its own 422 type next to our 422 problem
// schema and the two collide. Every error body is a problem, so narrow with this.
export const problemOf = (res: { error: unknown }) =>
  (res.error as { value: Problem } | null)?.value;
