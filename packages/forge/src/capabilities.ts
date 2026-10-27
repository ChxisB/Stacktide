export type ForgeKind = "gitlab" | "github";

/**
 * What a forge may not be able to do. A forge that lacks one refuses the feature with a message that names it,
 * never a half-built button (ADR-0019). GitLab has all of them. The `Record` makes the list below the whole truth:
 * a flag added here is a compile error in every adapter until it says yes or no.
 */
export const CAPABILITY_FLAGS = [
  "tokenScopes", // the token's scopes can be read back (`users.tokenInfo`)
  "listSearch", // `projects.list` filters by name on the server
  "approvalState", // `mergeRequests.approvals` has one answer: approved or not
  "dynamicPipeline", // a pipeline can be started with a whole generated pipeline as a file variable (`ORCH_CHILD_PIPELINE`)
  "stages", // a job knows its stage
  "jobArtifactFile", // one file out of a job's artifact can be read
  "childPipelines", // a pipeline can have child pipelines (`pipelines.bridges`)
  "ciLint", // the forge validates a CI file (`ci.lint`)
  "deployments", // deployments and environments can be listed
  "secretValuesReadable", // a CI variable's value can be read back
  "fileVariables", // a CI variable can be a file
  "accessTokens", // project access tokens can be made, rotated and revoked
  "runners", // a project's runners can be listed
  "managedState", // the forge keeps Terraform state
] as const;
export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];
export type ForgeCapabilities = Record<CapabilityFlag, boolean>;

/**
 * What each forge can do, as a table the adapters and the screens (the project's `capabilities`, FRG-24) both read.
 * A flag turns on for GitHub with the task that makes it true.
 */
const GITLAB_CAPABILITIES: ForgeCapabilities = {
  tokenScopes: true,
  listSearch: true,
  approvalState: true,
  dynamicPipeline: true,
  stages: true,
  jobArtifactFile: true,
  childPipelines: true,
  ciLint: true,
  deployments: true,
  secretValuesReadable: true,
  fileVariables: true,
  accessTokens: true,
  runners: true,
  managedState: true,
};
const GITHUB_CAPABILITIES: ForgeCapabilities = {
  tokenScopes: false,
  listSearch: false,
  approvalState: true,
  dynamicPipeline: false,
  stages: false,
  jobArtifactFile: false,
  childPipelines: false,
  ciLint: false,
  deployments: true,
  secretValuesReadable: false,
  fileVariables: false,
  accessTokens: false,
  runners: false,
  managedState: false,
};
export const capabilitiesOf = (kind: ForgeKind): ForgeCapabilities => ({
  ...(kind === "github" ? GITHUB_CAPABILITIES : GITLAB_CAPABILITIES),
});
