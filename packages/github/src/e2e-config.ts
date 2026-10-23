export interface GithubE2eConfig {
  baseUrl: string;
  token: string;
  /** The sandbox organization or user that owns the repository. */
  owner: string;
  /** `owner/name` of a repository inside it. */
  repo: string;
}

/**
 * The opt-in real-GitHub contract run. `null` when `GITHUB_E2E_REPO` is unset (the normal case); otherwise everything
 * must be set, the repository must be `owner/name` inside the sandbox owner, and the caller must confirm that the run
 * writes branches and pull requests there. Errors never echo the token.
 */
export function readGithubE2eConfig(
  env: Record<string, string | undefined>,
): GithubE2eConfig | null {
  const repo = env.GITHUB_E2E_REPO?.trim().replace(/^\/+|\/+$/g, "");
  if (!repo) return null;
  const token = env.GITHUB_E2E_TOKEN;
  const owner = env.GITHUB_E2E_OWNER?.replace(/^\/+|\/+$/g, "");
  const missing = [
    ["GITHUB_E2E_TOKEN", token],
    ["GITHUB_E2E_OWNER", owner],
  ].filter(([, v]) => !v);
  if (missing.length) {
    throw new Error(`GITHUB_E2E_REPO is set but ${missing.map(([k]) => k).join(", ")} is missing`);
  }
  if (!token || !owner) throw new Error("unreachable");
  if (!repo.startsWith(`${owner}/`) || repo.split("/").length !== 2) {
    throw new Error("GITHUB_E2E_REPO must be owner/name, inside GITHUB_E2E_OWNER (a sandbox only)");
  }
  if (env.GITHUB_E2E_ALLOW_WRITES !== "yes") {
    throw new Error(
      "The real-GitHub contract run writes branches and pull requests to GITHUB_E2E_REPO: set GITHUB_E2E_ALLOW_WRITES=yes to confirm",
    );
  }
  return { baseUrl: env.GITHUB_E2E_URL?.trim() || "https://github.com", token, owner, repo };
}
