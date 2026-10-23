import { DomainError } from "@orch/core";
import { type Executor, storeRunPlan } from "@orch/db";
import type { Forge } from "@orch/forge";
import type { Pipeline, ProjectRef } from "@orch/gitlab";
import {
  APPLY_ENVIRONMENT,
  GenerateError,
  type GithubApplyInput,
  githubRunPlan,
  type PlanInput,
  STACK_WORKFLOW_FILE,
  stackRunName,
} from "@orch/iac";
import { requireApplyGate } from "./apply-gate";

export interface ForgeRun {
  organizationId: string;
  projectId: string;
  /** The forge's name for the project: `owner/repo`, or the repository's number. */
  project: ProjectRef;
  runId: string;
  ref: string;
  input: PlanInput | GithubApplyInput;
}

/**
 * Starts a run on a forge that runs a fixed workflow instead of a generated pipeline (GitHub, FRG-30): the plan is kept
 * where the workflow reads it (FRG-17), then the workflow is dispatched with the run's id and action, nothing more:
 * no stack, command or value is sent in the dispatch. An apply is asked for only behind a gate (FRG-29), and the plan
 * is kept before the dispatch so a workflow that starts at once finds it. The run is the one the forge reports under
 * `stackRunName`, or an error that says the outcome is unknown.
 */
export async function startForgeRun(
  deps: { db: Executor; forge: Forge },
  run: ForgeRun,
): Promise<Pipeline> {
  const { forge } = deps;
  if (!forge.startRun) {
    throw new DomainError(
      "forge_cannot_dispatch",
      422,
      `The ${forge.kind} forge starts a run with a generated pipeline, not a workflow dispatch`,
    );
  }
  const action = run.input.action;
  if (action === "apply") await requireApplyGate(forge, run.project, APPLY_ENVIRONMENT);
  let plan: ReturnType<typeof githubRunPlan>;
  try {
    plan = githubRunPlan(run.input);
  } catch (error) {
    if (!(error instanceof GenerateError)) throw error;
    throw new DomainError(
      "cannot_generate",
      422,
      `The run could not be planned for ${forge.kind}: ${error.problems.slice(0, 3).join("; ")}`,
    );
  }
  await storeRunPlan(deps.db, run.organizationId, run.projectId, run.runId, action, plan);
  return forge.startRun(run.project, {
    workflow: STACK_WORKFLOW_FILE.slice(STACK_WORKFLOW_FILE.lastIndexOf("/") + 1),
    ref: run.ref,
    inputs: { run_id: run.runId, action },
    name: stackRunName(run.runId, action),
  });
}
