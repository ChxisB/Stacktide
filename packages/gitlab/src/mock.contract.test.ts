import { gitlabContract } from "./contract";
import { createGitlab } from "./index";
import { createMockGitlab } from "./mock/server";

gitlabContract("in-process mock", async () => {
  const mock = createMockGitlab();
  const group = mock.addGroup("platform");
  mock.addProject({ path: "platform/other", files: { "package.json": "{}" } });
  const project = mock.addProject({ path: "platform/api" });
  mock.addMember({ group: group.id }, mock.tokenUser.id, 40);
  mock.addMember({ project: project.id }, mock.tokenUser.id, 30);
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  return {
    target: { api, project: project.path, group: { id: group.id, path: group.full_path } },
    stop: mock.stop,
  };
});
