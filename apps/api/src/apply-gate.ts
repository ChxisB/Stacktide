import { DomainError } from "@orch/core";
import type { Forge } from "@orch/forge";
import type { ProjectRef } from "@orch/gitlab";

/**
 * Refuses to ask for an apply that nobody would have to let through (FRG-29). On a forge whose apply waits in an
 * environment (GitHub's, with required reviewers) the environment is read first: GitHub makes one with no rules the
 * first time a job names it, so a missing or unprotected environment would apply at once. The reason is the forge
 * adapter's own words (fixed text and the environment's name). A forge with no such gate (GitLab: the platform's
 * approval holds its apply) is let through, and a failure to read the environment is thrown, never a pass.
 */
export async function requireApplyGate(forge: Forge, project: ProjectRef, environment: string) {
  if (!forge.applyGate) return;
  const gate = await forge.applyGate(project, environment);
  if (!gate.gated) throw new DomainError("apply_not_gated", 409, gate.reason);
}
