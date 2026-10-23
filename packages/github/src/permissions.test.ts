import { afterEach, describe, expect, test } from "bun:test";
import { GitlabError } from "@orch/gitlab";
import { createGithubClient } from "./client";
import { createMockGithub, type MockGithub } from "./mock/server";
import { PERMISSIONS, probePermissions } from "./permissions";

let mock: MockGithub | undefined;
afterEach(() => mock?.stop());

function setup(opts: Parameters<typeof createMockGithub>[0] = {}, repo = true) {
  mock = createMockGithub(opts);
  if (repo) mock.addRepo("acme", "api");
  const client = createGithubClient({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    token: "ghp_not-a-real-token-1234",
    maxRetries: 0,
  });
  return { mock, client };
}

const ALL = PERMISSIONS.map((p) => p.id);

describe("probing a token's permissions", () => {
  test("every permission answers: the login, the repository tried and all of them granted", async () => {
    const { client, mock } = setup();
    const found = await probePermissions(client);
    expect(found).toEqual({
      login: "mock-user",
      repo: "acme/api",
      granted: ALL,
      refused: [],
      unknown: [],
    });
    // one read each, nothing written
    expect(mock.requests.every((r) => r.method === "GET")).toBe(true);
  });

  test("a permission the token lacks is refused; the others are still granted", async () => {
    const { client } = setup({ denied: ["/hooks", "/environments"] });
    const found = await probePermissions(client);
    expect(found.refused).toEqual(["environments", "webhooks"]);
    expect(found.granted).toEqual(ALL.filter((id) => id !== "environments" && id !== "webhooks"));
    expect(found.unknown).toEqual([]);
  });

  test("a 404 counts as refused: GitHub hides what a token may not see", async () => {
    const { client, mock } = setup();
    mock.inject({ method: "GET", path: "/repos/acme/api/contents", status: 404, times: 1 });
    expect((await probePermissions(client)).refused).toEqual(["contents"]);
  });

  test("any other answer is unknown, not a refusal", async () => {
    const { client, mock } = setup();
    mock.inject({ method: "GET", path: "/repos/acme/api/pulls", status: 500, times: 1 });
    mock.inject({
      method: "GET",
      path: "/repos/acme/api/actions/workflows",
      status: 422,
      times: 1,
    });
    const found = await probePermissions(client);
    expect(found.unknown).toEqual(["pull_requests", "actions"]);
    expect(found.refused).toEqual([]);
  });

  test("a token that sees no repository proves nothing: nothing is probed", async () => {
    const { client, mock } = setup({}, false);
    expect(await probePermissions(client)).toEqual({
      login: "mock-user",
      repo: null,
      granted: [],
      refused: [],
      unknown: ALL,
    });
    expect(mock.requests.some((r) => r.path.startsWith("/repos/"))).toBe(false);
  });

  test("a rejected token is the client's error, not an answer", async () => {
    const { client } = setup({ token: "ghp_another-token-1234567" });
    await expect(probePermissions(client)).rejects.toMatchObject({
      constructor: GitlabError,
      kind: "unauthorized",
    });
  });
});
