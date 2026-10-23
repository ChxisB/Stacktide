import { afterEach, describe, expect, test } from "bun:test";
import { createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import { GitlabError } from "@orch/gitlab";
import { githubForge } from "./github";

// FRG-30: GitHub has no single "approved". The reviews are reduced to the latest word of each person and set against
// what the branch is required to have; a count that cannot be read is an error, never "approved".

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

const project = "platform/api";

async function setup(opts: Parameters<typeof createMockGithub>[0] = {}) {
  const mock = createMockGithub(opts);
  stops.push(mock.stop);
  mock.addRepo("platform", "api");
  const forge = githubForge(
    createGithubClient({
      baseUrl: mock.url,
      allowInsecureHttp: true,
      token: "ghp_not-a-real-token-1234",
      maxRetries: 0,
    }),
  );
  await forge.repository.createBranch(project, "feat", "main");
  await forge.repository.commitFiles(project, { branch: "feat", message: "change" }, [
    { action: "create", path: "a.txt", content: "1" },
  ]);
  const mr = await forge.mergeRequests.create(project, {
    sourceBranch: "feat",
    targetBranch: "main",
    title: "change",
  });
  const review = (login: string, state: string, commit?: string) =>
    mock.addReview("platform", "api", mr.iid, { login, state, commit });
  const approved = async () => (await forge.mergeRequests.approvals(project, mr.iid)).approved;
  return { mock, forge, mr, review, approved };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as GitlabError;
  }
  throw new Error("expected a failure");
};

describe("the reviews against the required count", () => {
  test("enough approvals on the current commit: approved", async () => {
    const { mock, review, approved } = await setup();
    mock.protectBranch("platform", "api", "main", { approvals: 2 });
    review("ada", "APPROVED");
    review("bob", "APPROVED");
    expect(await approved()).toBe(true);
  });

  test("one short: not approved", async () => {
    const { mock, review, approved } = await setup();
    mock.protectBranch("platform", "api", "main", { approvals: 2 });
    review("ada", "APPROVED");
    expect(await approved()).toBe(false);
  });

  test("the same person approving twice counts once", async () => {
    const { mock, review, approved } = await setup();
    mock.protectBranch("platform", "api", "main", { approvals: 2 });
    review("ada", "APPROVED");
    review("ada", "APPROVED");
    expect(await approved()).toBe(false);
  });

  test("a person's latest word stands: a change requested after an approval takes it back, and blocks", async () => {
    const { mock, review, approved } = await setup();
    mock.protectBranch("platform", "api", "main", { approvals: 1 });
    review("ada", "APPROVED");
    review("bob", "APPROVED");
    expect(await approved()).toBe(true);
    review("ada", "CHANGES_REQUESTED");
    // bob's approval alone would be enough for the count; ada's open request still blocks
    expect(await approved()).toBe(false);
    review("ada", "APPROVED");
    expect(await approved()).toBe(true);
  });

  test("a comment does not take an approval back; a dismissal does", async () => {
    const { mock, review, approved } = await setup();
    mock.protectBranch("platform", "api", "main", { approvals: 1 });
    review("ada", "APPROVED");
    review("ada", "COMMENTED");
    expect(await approved()).toBe(true);
    review("ada", "DISMISSED");
    expect(await approved()).toBe(false);
  });

  test("an approval of an older commit does not count for the current one", async () => {
    const { mock, review, approved, forge, mr } = await setup();
    mock.protectBranch("platform", "api", "main", { approvals: 1 });
    review("ada", "APPROVED");
    expect(await approved()).toBe(true);
    await forge.repository.commitFiles(project, { branch: "feat", message: "more" }, [
      { action: "create", path: "b.txt", content: "2" },
    ]);
    expect((await forge.mergeRequests.get(project, mr.iid)).sha).not.toBe(mr.sha);
    expect(await approved()).toBe(false);
  });

  test("an unknown review word neither approves nor blocks", async () => {
    const { mock, review, approved } = await setup();
    mock.protectBranch("platform", "api", "main", { approvals: 1 });
    review("ada", "SOMETHING_NEW");
    expect(await approved()).toBe(false);
    review("bob", "APPROVED");
    expect(await approved()).toBe(true);
  });

  test("reviews on several pages are all read", async () => {
    const { mock, review, approved } = await setup({ maxPerPage: 2 });
    mock.protectBranch("platform", "api", "main", { approvals: 4 });
    for (const n of ["a", "b", "c", "d", "e"]) review(n, "APPROVED");
    expect(await approved()).toBe(true);
  });
});

describe("where the required count comes from", () => {
  test("a ruleset counts the same as a protection rule, and the larger of the two is the count", async () => {
    const { mock, review, approved } = await setup();
    mock.addRuleset("platform", "api", "main", { approvals: 2 });
    review("ada", "APPROVED");
    expect(await approved()).toBe(false);
    review("bob", "APPROVED");
    expect(await approved()).toBe(true);
    mock.protectBranch("platform", "api", "main", { approvals: 3 });
    expect(await approved()).toBe(false);
  });

  test("a branch that is not protected, or protected without reviews, needs none; a change request still blocks", async () => {
    const { mock, review, approved } = await setup();
    expect(await approved()).toBe(true);
    mock.protectBranch("platform", "api", "main", { approvals: null });
    expect(await approved()).toBe(true);
    review("ada", "CHANGES_REQUESTED");
    expect(await approved()).toBe(false);
  });

  test("the rules are asked about the pull request's target branch", async () => {
    const { mock, approved } = await setup();
    await approved();
    const paths = mock.requests.map((r) => r.path);
    expect(paths).toContain(
      "/repos/platform/api/branches/main/protection/required_pull_request_reviews",
    );
    expect(paths).toContain("/repos/platform/api/rules/branches/main");
    expect(paths).toContain("/repos/platform/api/pulls/1/reviews");
  });
});

describe("what cannot be read is an error, not an approval", () => {
  test.each([
    ["the protection rule", "/branches/main/protection/required_pull_request_reviews"],
    ["the rulesets", "/rules/branches/main"],
    ["the reviews", "/pulls/1/reviews"],
  ])("%s the token may not read", async (_, route) => {
    const { review, approved } = await setup({ denied: [route] });
    review("ada", "APPROVED");
    const e = await failure(approved());
    expect(e).toBeInstanceOf(GitlabError);
    expect(e.kind).toBe("forbidden");
  });

  test("a 404 that does not say the branch is unprotected is a refusal: GitHub also hides what a token may not see", async () => {
    const { mock, approved } = await setup();
    mock.inject({
      method: "GET",
      path: "/repos/platform/api/branches/main/protection/required_pull_request_reviews",
      status: 404,
      times: 1,
      body: { message: "Not Found" },
    });
    expect((await failure(approved())).kind).toBe("not_found");
  });

  test("only a 404 can mean the branch is unprotected: the same words in a refusal are still a refusal", async () => {
    const { mock, approved } = await setup();
    mock.inject({
      method: "GET",
      path: "/repos/platform/api/branches/main/protection/required_pull_request_reviews",
      status: 403,
      times: 1,
      body: { message: "Branch not protected" },
    });
    expect((await failure(approved())).kind).toBe("forbidden");
  });

  test("a review whose author is gone says nothing and does not stop the count", async () => {
    const { mock, mr, review, approved } = await setup();
    mock.protectBranch("platform", "api", "main", { approvals: 1 });
    mock.inject({
      method: "GET",
      path: "/repos/platform/api/pulls/1/reviews",
      status: 200,
      times: 1,
      body: [{ id: 1, user: null, state: "APPROVED", commit_id: mr.sha }],
    });
    expect(await approved()).toBe(false);
    review("ada", "APPROVED");
    expect(await approved()).toBe(true);
  });

  test("a count that is not a number is an error", async () => {
    const { mock, approved } = await setup();
    mock.inject({
      method: "GET",
      path: "/repos/platform/api/branches/main/protection/required_pull_request_reviews",
      status: 200,
      times: 1,
      body: { required_approving_review_count: "two" },
    });
    expect(await failure(approved())).toBeInstanceOf(GitlabError);
  });
});
