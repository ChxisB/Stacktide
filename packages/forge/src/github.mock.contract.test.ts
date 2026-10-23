import { expect, test } from "bun:test";
import { createGithubClient } from "@orch/github";
import { createMockGithub, type MockRequest } from "@orch/github/mock";
import { forgeContract } from "./contract";
import { githubForge } from "./github";

function onTheMock() {
  const mock = createMockGithub();
  mock.addRepo("platform", "other", { files: { "package.json": "{}" } });
  mock.addRepo("platform", "api");
  const forge = githubForge(
    createGithubClient({
      baseUrl: mock.url,
      allowInsecureHttp: true,
      token: "ghp_not-a-real-token-1234",
      maxRetries: 0,
    }),
  );
  return { mock, forge };
}

// The groups the adapter has built so far; each task that builds another adds its name here (FRG-14, 15, 20, ...).
// shortcut: `group` is only read by the members cases, which are not run yet; the owner stands in for it.
forgeContract(
  "GitHub on the in-process mock",
  async () => {
    const { mock, forge } = onTheMock();
    return {
      target: { forge, project: "platform/api", group: { id: 0, path: "platform" } },
      stop: mock.stop,
    };
  },
  { areas: ["projects", "repository", "merge requests"] },
);

/** What would change a branch of the repository: every write that names the branch in its path or its body. */
const writesTo = (log: MockRequest[], branch: string) =>
  log.filter(
    (r) =>
      r.method !== "GET" &&
      (r.path.endsWith(`/heads/${branch}`) ||
        JSON.stringify(r.body ?? "").includes(`refs/heads/${branch}"`) ||
        JSON.stringify(r.body ?? "").includes(`"branch":"${branch}"`)),
  );

// Invariant 6: nothing is pushed to a default branch. Whatever a caller asks, no write names it.
test("no call, refused or allowed, ever writes the default branch", async () => {
  const { mock, forge } = onTheMock();
  try {
    const project = "platform/api";
    const before = await forge.repository.getBranch(project, "main");
    const asks: (() => Promise<unknown>)[] = [
      () =>
        forge.repository.commitFiles(project, { branch: "main", message: "no" }, [
          { action: "create", path: "a.txt", content: "1" },
        ]),
      () =>
        forge.repository.commitFiles(project, { branch: "refs/heads/main", message: "no" }, [
          { action: "create", path: "a.txt", content: "1" },
        ]),
      () =>
        forge.repository.commitFiles(
          project,
          { branch: "main", startBranch: "main", message: "no" },
          [{ action: "create", path: "a.txt", content: "1" }],
        ),
      () => forge.repository.deleteBranch(project, "main"),
      () => forge.repository.deleteBranch(project, "refs/heads/main"),
      () => forge.repository.createBranch(project, "main", "main"),
      // the allowed ones, which start from the default branch but only ever write the new one
      () => forge.repository.createBranch(project, "orch/one", "main"),
      () =>
        forge.repository.commitFiles(project, { branch: "orch/one", message: "ok" }, [
          { action: "create", path: "a.txt", content: "1" },
        ]),
      () =>
        forge.repository.commitFiles(
          project,
          { branch: "orch/two", startBranch: "main", message: "ok" },
          [{ action: "create", path: "b.txt", content: "2" }],
        ),
      () =>
        forge.mergeRequests.create(project, {
          sourceBranch: "orch/one",
          targetBranch: "main",
          title: "ok",
        }),
      () => forge.mergeRequests.update(project, 1, { state: "closed" }),
      () => forge.repository.deleteBranch(project, "orch/two"),
    ];
    for (const ask of asks) await ask().catch((e) => e);
    expect(await forge.repository.getBranch(project, "main")).toEqual(before);
    expect(writesTo(mock.requests, "main")).toEqual([]);
    // the guard above is not blind: the writes that were allowed are in the log
    expect(writesTo(mock.requests, "orch/one").length).toBeGreaterThan(0);
  } finally {
    mock.stop();
  }
});
