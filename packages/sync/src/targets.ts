import { GITLAB_VARIABLES, parseGitlabVariablesConfig } from "./gitlab-variables";

/**
 * The kinds of sync target the platform knows, and for each what its config looks like and which
 * kind of connection reaches it. The API checks a stored target against this without a client, so
 * nothing here may need a credential.
 */
export const TARGET_TYPES = {
  [GITLAB_VARIABLES]: { connection: "gitlab", validate: parseGitlabVariablesConfig },
} as const;

export type TargetType = keyof typeof TARGET_TYPES;
export const TARGET_TYPE_NAMES = Object.keys(TARGET_TYPES) as [TargetType, ...TargetType[]];
