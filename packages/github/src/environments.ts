import { GitlabError, type ProjectRef } from "@orch/gitlab";
import { z } from "zod";
import type { GithubClient } from "./client";
import { decode } from "./decode";

/** Whether an apply that waits in an environment is held for someone's say-so (FRG-29). */
export type ApplyGate = { gated: true; reviewers: number } | { gated: false; reason: string };

const environment = z.object({
  protection_rules: z.array(
    z.object({ type: z.string(), reviewers: z.array(z.unknown()).nullish() }).passthrough(),
  ),
});

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Reads an environment's protection rules. GitHub makes an environment, with none, the first time a job names one, so
 * an apply behind `environment: orch-apply` is gated only if someone has put required reviewers on it. Only that rule
 * counts: a wait timer or a branch policy lets the apply through on its own. Private repositories hold required
 * reviewers on GitHub Enterprise only (docs/forge-seam.md section 6), so there the answer is often "not gated".
 * An environment that is missing or that the token may not read is "not gated" with the reason; any other failure is
 * thrown, because an answer that was not read must not pass as a gate.
 * shortcut: the permission the token needs to read environments is not confirmed against GitHub (the documentation
 * names Administration read for the repository); confirm with FRG-27.
 */
export function environmentsApi(
  client: GithubClient,
  base: (p: ProjectRef) => Promise<string>,
): { applyGate: (project: ProjectRef, name: string) => Promise<ApplyGate> } {
  return {
    async applyGate(project, name) {
      if (!NAME.test(name)) {
        throw new GitlabError("invalid", "Not an environment name GitHub can be asked about");
      }
      const at = `${await base(project)}/environments/${name}`;
      let raw: unknown;
      try {
        raw = await client.request("GET", at);
      } catch (e) {
        if (e instanceof GitlabError && e.kind === "not_found") {
          return {
            gated: false,
            reason: `environment "${name}" does not exist (or the token cannot see it): GitHub makes one without required reviewers the first time a job names it, so the apply would not wait for anyone`,
          };
        }
        if (e instanceof GitlabError && e.kind === "forbidden") {
          return {
            gated: false,
            reason: `the token cannot read environment "${name}", so it cannot be seen to hold required reviewers`,
          };
        }
        throw e;
      }
      const rules = decode(environment, raw, "environment").protection_rules;
      const reviewers = rules
        .filter((r) => r.type === "required_reviewers")
        .reduce((n, r) => n + (r.reviewers?.length ?? 0), 0);
      return reviewers > 0
        ? { gated: true, reviewers }
        : {
            gated: false,
            reason: `environment "${name}" has no required reviewers, so anyone who can run the workflow would apply: add reviewers in the repository's settings (private repositories need GitHub Enterprise for them)`,
          };
    },
  };
}
