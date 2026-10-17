import { setDefaultTimeout, test } from "bun:test";
import { gitlabContract } from "./contract";
import { readE2eConfig } from "./e2e-config";
import { createGitlab } from "./index";

// Opt-in: runs the same contract as the mock against a real GitLab sandbox group.
// See "GitLab contract against a real instance" in the README.
let cfg: ReturnType<typeof readE2eConfig> = null;
try {
  cfg = readE2eConfig(process.env);
} catch (e) {
  test("real-instance contract configuration", () => {
    throw e;
  });
}

if (cfg) {
  const { baseUrl, token, group, project } = cfg;
  setDefaultTimeout(60_000);
  gitlabContract("real sandbox", async () => {
    const api = createGitlab({ baseUrl, auth: { type: "private-token", token } });
    const g = await api.groups.get(group);
    return { target: { api, project, group: { id: g.id, path: g.path } }, stop: () => {} };
  });
} else if (!process.env.GITLAB_E2E_URL) {
  test.skip("real-instance contract (set GITLAB_E2E_URL to run it)", () => {});
}
