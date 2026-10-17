export interface E2eConfig {
  baseUrl: string;
  token: string;
  /** Full path of the sandbox group. */
  group: string;
  /** Full path of a project inside it. */
  project: string;
}

/**
 * The opt-in real-instance contract run. `null` when `GITLAB_E2E_URL` is unset (the normal case);
 * otherwise everything must be set, the project must sit inside the sandbox group, and the caller
 * must confirm that the run writes branches, variables and pipelines there. Errors never echo the token.
 */
export function readE2eConfig(env: Record<string, string | undefined>): E2eConfig | null {
  const baseUrl = env.GITLAB_E2E_URL?.trim();
  if (!baseUrl) return null;
  const token = env.GITLAB_E2E_TOKEN;
  const group = env.GITLAB_E2E_GROUP?.replace(/^\/+|\/+$/g, "");
  const project = env.GITLAB_E2E_PROJECT?.replace(/^\/+|\/+$/g, "");
  const missing = [
    ["GITLAB_E2E_TOKEN", token],
    ["GITLAB_E2E_GROUP", group],
    ["GITLAB_E2E_PROJECT", project],
  ].filter(([, v]) => !v);
  if (missing.length) {
    throw new Error(`GITLAB_E2E_URL is set but ${missing.map(([k]) => k).join(", ")} is missing`);
  }
  if (!token || !group || !project) throw new Error("unreachable");
  if (!project.startsWith(`${group}/`)) {
    throw new Error("GITLAB_E2E_PROJECT must be inside GITLAB_E2E_GROUP (a sandbox group only)");
  }
  if (env.GITLAB_E2E_ALLOW_WRITES !== "yes") {
    throw new Error(
      "The real-instance contract run writes branches, variables and pipelines to GITLAB_E2E_PROJECT: set GITLAB_E2E_ALLOW_WRITES=yes to confirm",
    );
  }
  return { baseUrl, token, group, project };
}
