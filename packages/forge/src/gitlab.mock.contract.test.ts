import { expect, test } from "bun:test";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { forgeContract } from "./contract";
import { gitlabForge } from "./gitlab";

async function onTheMock() {
  const mock = createMockGitlab();
  const group = mock.addGroup("platform");
  mock.addProject({ path: "platform/other", files: { "package.json": "{}" } });
  const project = mock.addProject({ path: "platform/api" });
  mock.addMember({ group: group.id }, mock.tokenUser.id, 40);
  mock.addMember({ project: project.id }, mock.tokenUser.id, 30);
  const forge = gitlabForge(
    createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: mock.token },
      maxRetries: 0,
    }),
  );
  return {
    target: { forge, project: project.path, group: { id: group.id, path: group.full_path } },
    stop: mock.stop,
  };
}

forgeContract("GitLab on the in-process mock", onTheMock);

// A forge that says it lacks a capability is not asked to do it: here those operations throw if anything calls them.
const refuses = () => {
  throw new Error("called an operation the forge says it lacks");
};
forgeContract("a forge that claims no optional capability", async () => {
  const { target, stop } = await onTheMock();
  const { forge } = target;
  return {
    target: {
      ...target,
      forge: {
        ...forge,
        capabilities: {
          ...forge.capabilities,
          ciLint: false,
          accessTokens: false,
          tokenScopes: false,
          runners: false,
          deployments: false,
        },
        ci: { ...forge.ci, lint: refuses },
        accessTokens: { create: refuses, get: refuses, rotate: refuses, revoke: refuses },
        users: { ...forge.users, tokenInfo: refuses },
        runners: { list: refuses },
        deployments: { list: refuses, get: refuses },
        environments: { list: refuses },
      },
    },
    stop,
  };
});

// The one case of the old suite the interface does not carry: nothing calls `groups`, so it is GitLab's alone.
test("GitLab only: lists and gets groups; an unknown one is not_found", async () => {
  const mock = createMockGitlab();
  try {
    const group = mock.addGroup("platform");
    const api = createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: mock.token },
      maxRetries: 0,
    });
    mock.addMember({ group: group.id }, mock.tokenUser.id, 40);
    const seen: number[] = [];
    for await (const g of api.groups.list()) seen.push(g.id);
    expect(seen).toContain(group.id);
    expect((await api.groups.get(group.id)).path).toBe(group.full_path);
    expect(await api.groups.get(2_000_000_000).catch((e) => e.kind)).toBe("not_found");
  } finally {
    await mock.stop();
  }
});
