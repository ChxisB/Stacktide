import { setDefaultTimeout, test } from "bun:test";
import { createGitlab, readE2eConfig } from "@orch/gitlab";
import { forgeContract } from "./contract";
import { gitlabForge } from "./gitlab";

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
  forgeContract("GitLab on a real sandbox", async () => {
    const api = createGitlab({ baseUrl, auth: { type: "private-token", token } });
    const g = await api.groups.get(group); // the interface has no groups; the sandbox group is found with the raw gateway
    return {
      target: { forge: gitlabForge(api), project, group: { id: g.id, path: g.path } },
      stop: () => {},
    };
  });
} else if (!process.env.GITLAB_E2E_URL) {
  test.skip("real-instance contract (set GITLAB_E2E_URL to run it)", () => {});
}
