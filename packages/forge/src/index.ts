import type { ApplyGate, StartRun } from "@orch/github";
import type { Gitlab, Pipeline, ProjectRef } from "@orch/gitlab";
import type { ForgeCapabilities, ForgeKind } from "./capabilities";

export * from "./capabilities";

/**
 * What the platform asks of a forge: the operations of `@orch/gitlab`'s gateway that something calls or the contract
 * needs (everything but `groups`, which nothing calls), and what the forge cannot do.
 * shortcut: the operations and their domain types are still `@orch/gitlab`'s (a pull request is a "merge request",
 * a workflow run a "pipeline"); a GitHub adapter returns the same shapes. Reshape an operation in the task that
 * finds GitHub cannot fill it (FRG-14, FRG-17, FRG-30), and move the types here when callers move (FRG-15).
 */
export type Forge = Omit<Gitlab, "groups"> & {
  readonly kind: ForgeKind;
  readonly capabilities: ForgeCapabilities;
  /**
   * Whether an apply of this project waits in `environment` for someone's say-so (FRG-29). Only a forge whose runner
   * holds a job for an approval has one (GitHub's environments with required reviewers); GitLab's apply is held by the
   * platform's own approval, so it has none to ask.
   */
  readonly applyGate?: (project: ProjectRef, environment: string) => Promise<ApplyGate>;
  /**
   * Starts a workflow that is a file in the repository (FRG-30) and returns the run it made, found by `name`. Only
   * a forge that takes no generated pipeline has one (GitHub's dispatch); GitLab starts its pipeline with
   * `pipelines.trigger` and the child pipeline.
   */
  readonly startRun?: (project: ProjectRef, input: StartRun) => Promise<Pipeline>;
};

export { githubForge } from "./github";
export { gitlabForge } from "./gitlab";
export type { ApplyGate, StartRun };
