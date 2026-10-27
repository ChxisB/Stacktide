/**
 * The name a hand start of a cloud deploy workflow gives its run (the workflow's `run-name`): how the platform finds the
 * run it dispatched, as it does for a stack run (FRG-30). Both values are checked as a slug and a full sha before they get here.
 */
export const deployRunName = (environment: string, sha: string) =>
  `orch deploy ${environment} ${sha}`;
