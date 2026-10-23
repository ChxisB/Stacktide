import { setDefaultTimeout, test } from "bun:test";
import { createGithubClient, readGithubE2eConfig } from "@orch/github";
import { forgeContract } from "./contract";
import { githubForge } from "./github";

// Opt-in: runs the same contract as the mock against a real GitHub sandbox repository.
// See "GitHub contract against a real repository" in the README.
// shortcut: the areas are the three the mock run has (`github.mock.contract.test.ts`); add one here when you add it there.
let cfg: ReturnType<typeof readGithubE2eConfig> = null;
try {
  cfg = readGithubE2eConfig(process.env);
} catch (e) {
  test("real-GitHub contract configuration", () => {
    throw e;
  });
}

if (cfg) {
  const { baseUrl, token, owner, repo } = cfg;
  setDefaultTimeout(60_000);
  forgeContract(
    "GitHub on a real sandbox",
    async () => ({
      target: {
        forge: githubForge(createGithubClient({ baseUrl, token })),
        project: repo,
        group: { id: 0, path: owner },
      },
      stop: () => {},
    }),
    { areas: ["projects", "repository", "merge requests"] },
  );
} else if (!process.env.GITHUB_E2E_REPO) {
  test.skip("real-GitHub contract (set GITHUB_E2E_REPO to run it)", () => {});
}
