import { AWS_ASSUME_ROLE } from "./aws";
import { AWS_SSM, parseAwsSsmConfig } from "./aws-ssm";
import { GITLAB_VARIABLES, parseGitlabVariablesConfig } from "./gitlab-variables";

/**
 * The kinds of sync target the platform knows, and for each what its config looks like and which
 * kind of connection reaches it. The API checks a stored target against this without a client, so
 * nothing here may need a credential.
 */
export const TARGET_TYPES = {
  [GITLAB_VARIABLES]: { connection: "gitlab", validate: parseGitlabVariablesConfig },
  [AWS_SSM]: { connection: AWS_ASSUME_ROLE, validate: parseAwsSsmConfig },
} as const;

export type TargetType = keyof typeof TARGET_TYPES;
export const TARGET_TYPE_NAMES = Object.keys(TARGET_TYPES) as [TargetType, ...TargetType[]];

/**
 * Whether a stored config marks the target protected (it is where production lives, so the production
 * guardrail applies). Every target type's config carries the flag in the same place.
 */
export const isProtected = (config: unknown) =>
  typeof config === "object" &&
  config !== null &&
  (config as { protected?: unknown }).protected === true;
