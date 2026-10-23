import { afterEach, describe, expect, test } from "bun:test";
import { DomainError } from "@orch/core";
import { githubForge, gitlabForge } from "@orch/forge";
import { createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import { requireApplyGate } from "./apply-gate";

// FRG-29: the platform does not ask for an apply on a forge that would run it without waiting for anyone.

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function github() {
  const mock = createMockGithub();
  stops.push(mock.stop);
  mock.addRepo("acme", "svc");
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

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as DomainError;
  }
  throw new Error("expected a refusal");
};

describe("the gate of an apply", () => {
  test("an environment with required reviewers lets the apply be asked for", async () => {
    const { mock, forge } = github();
    mock.addEnvironment("acme", "svc", "orch-apply", [
      { id: 1, type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1 } }] },
    ]);
    await requireApplyGate(forge, "acme/svc", "orch-apply");
  });

  test("an environment with no reviewers refuses the apply with the reason, as a 409", async () => {
    const { mock, forge } = github();
    mock.addEnvironment("acme", "svc", "orch-apply", []);
    const e = await refusal(requireApplyGate(forge, "acme/svc", "orch-apply"));
    expect(e).toBeInstanceOf(DomainError);
    expect(e.status).toBe(409);
    expect(e.code).toBe("apply_not_gated");
    expect(e.message).toContain('"orch-apply"');
    expect(e.message).toContain("no required reviewers");
  });

  test("an environment GitHub has not made yet refuses it too: the first job would make it without reviewers", async () => {
    const { forge } = github();
    const e = await refusal(requireApplyGate(forge, "acme/svc", "orch-apply"));
    expect(e.code).toBe("apply_not_gated");
    expect(e.message).toContain("does not exist");
  });

  test("a failure to read the environment is not a pass", async () => {
    const { mock, forge } = github();
    mock.inject({
      method: "GET",
      path: "/repos/acme/svc/environments/orch-apply",
      status: 500,
      times: 1,
    });
    await expect(requireApplyGate(forge, "acme/svc", "orch-apply")).rejects.toThrow();
  });

  test("GitLab has no environment gate to ask: the platform's own approval holds its apply", async () => {
    // the adapter is not called at all
    await requireApplyGate(gitlabForge({} as never), "group/project", "orch-apply");
  });
});
