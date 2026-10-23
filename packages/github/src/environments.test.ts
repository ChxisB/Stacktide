import { afterEach, describe, expect, test } from "bun:test";
import { GitlabError } from "@orch/gitlab";
import { createGithubClient } from "./client";
import { environmentsApi } from "./environments";
import { createMockGithub } from "./mock/server";
import { repoBase } from "./projects";

// FRG-29: an apply on GitHub waits behind an environment with required reviewers. GitHub makes an environment, with no
// rules at all, the first time a job names one, so the platform reads the rules before it asks for an apply.

let mock: ReturnType<typeof createMockGithub>;
afterEach(() => mock?.stop());

const reviewers = (n: number) => ({
  id: 1,
  type: "required_reviewers",
  reviewers: Array.from({ length: n }, (_, i) => ({
    type: "User",
    reviewer: { id: 10 + i, login: `person-${i}` },
  })),
});

function setup(opts: Parameters<typeof createMockGithub>[0] = {}) {
  mock?.stop();
  mock = createMockGithub(opts);
  mock.addRepo("acme", "svc");
  const client = createGithubClient({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    token: "ghp_not-a-real-token-1234",
    maxRetries: 0,
  });
  const { applyGate } = environmentsApi(client, repoBase(client));
  const asked = () => mock.requests.map((r) => `${r.method} ${r.path}`);
  return { applyGate, asked };
}

describe("whether an environment can hold an apply", () => {
  test("required reviewers: gated, with how many there are", async () => {
    const { applyGate, asked } = setup();
    mock.addEnvironment("acme", "svc", "orch-apply", [{ id: 2, type: "wait_timer" }, reviewers(2)]);
    expect(await applyGate("acme/svc", "orch-apply")).toEqual({ gated: true, reviewers: 2 });
    expect(asked()).toEqual(["GET /repos/acme/svc/environments/orch-apply"]);
  });

  test("a team counts as a reviewer the same way a person does", async () => {
    const { applyGate } = setup();
    mock.addEnvironment("acme", "svc", "orch-apply", [
      {
        id: 1,
        type: "required_reviewers",
        reviewers: [{ type: "Team", reviewer: { id: 7, slug: "ops" } }],
      },
    ]);
    expect(await applyGate("acme/svc", "orch-apply")).toEqual({ gated: true, reviewers: 1 });
  });

  test("an environment with no rules is not gated, and the reason says what to do", async () => {
    const { applyGate } = setup();
    mock.addEnvironment("acme", "svc", "orch-apply", []);
    const gate = await applyGate("acme/svc", "orch-apply");
    expect(gate.gated).toBe(false);
    if (gate.gated) return;
    expect(gate.reason).toContain('"orch-apply"');
    expect(gate.reason).toContain("no required reviewers");
    expect(gate.reason).toContain("GitHub Enterprise");
  });

  test("a wait timer or a branch policy alone is not an approval", async () => {
    const { applyGate } = setup();
    mock.addEnvironment("acme", "svc", "orch-apply", [
      { id: 1, type: "wait_timer", wait_timer: 30 },
      { id: 2, type: "branch_policy" },
    ]);
    expect((await applyGate("acme/svc", "orch-apply")).gated).toBe(false);
  });

  test("a reviewers rule with nobody in it is not gated", async () => {
    const { applyGate } = setup();
    mock.addEnvironment("acme", "svc", "orch-apply", [reviewers(0)]);
    expect((await applyGate("acme/svc", "orch-apply")).gated).toBe(false);
  });

  test("an environment that is not there is not gated: GitHub would make one without rules", async () => {
    const { applyGate } = setup();
    const gate = await applyGate("acme/svc", "orch-apply");
    expect(gate.gated).toBe(false);
    if (gate.gated) return;
    expect(gate.reason).toContain("does not exist");
    expect(gate.reason).toContain("without");
  });

  test("a token that may not read environments is not gated, and says so", async () => {
    const { applyGate } = setup({ denied: ["/environments/orch-apply"] });
    mock.addEnvironment("acme", "svc", "orch-apply", [reviewers(1)]);
    const gate = await applyGate("acme/svc", "orch-apply");
    expect(gate.gated).toBe(false);
    if (gate.gated) return;
    expect(gate.reason).toContain("cannot read");
  });

  test("an answer that is not an environment is an error, not a pass", async () => {
    const { applyGate } = setup();
    mock.inject({
      method: "GET",
      path: "/repos/acme/svc/environments/orch-apply",
      status: 200,
      times: 1,
      body: { name: "orch-apply", protection_rules: "none" },
    });
    await expect(applyGate("acme/svc", "orch-apply")).rejects.toThrow(GitlabError);
  });

  test("a server error is an error, not a pass", async () => {
    const { applyGate } = setup();
    mock.inject({
      method: "GET",
      path: "/repos/acme/svc/environments/orch-apply",
      status: 500,
      times: 1,
    });
    await expect(applyGate("acme/svc", "orch-apply")).rejects.toThrow(GitlabError);
  });

  test("a name that could leave the path is refused before anything is sent", async () => {
    const { applyGate, asked } = setup();
    for (const name of ["../x", "a/b", "", "a b", ".."]) {
      await expect(applyGate("acme/svc", name)).rejects.toThrow(GitlabError);
    }
    expect(asked()).toEqual([]);
  });
});
