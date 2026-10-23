import { describe, expect, test } from "bun:test";
import { readGithubE2eConfig } from "./e2e-config";

const full = {
  GITHUB_E2E_REPO: "sandbox-orch/demo",
  GITHUB_E2E_OWNER: "sandbox-orch",
  GITHUB_E2E_TOKEN: "github_pat_SECRET-CANARY-123",
  GITHUB_E2E_ALLOW_WRITES: "yes",
};

describe("readGithubE2eConfig", () => {
  test("is off unless a repository is given", () => {
    expect(readGithubE2eConfig({})).toBeNull();
    expect(readGithubE2eConfig({ GITHUB_E2E_TOKEN: "x" })).toBeNull();
    expect(readGithubE2eConfig({ ...full, GITHUB_E2E_REPO: "  " })).toBeNull();
  });

  test("returns the settings when complete, github.com unless an address is given, slashes trimmed", () => {
    expect(readGithubE2eConfig({ ...full, GITHUB_E2E_REPO: "/sandbox-orch/demo/" })).toEqual({
      baseUrl: "https://github.com",
      token: "github_pat_SECRET-CANARY-123",
      owner: "sandbox-orch",
      repo: "sandbox-orch/demo",
    });
    expect(
      readGithubE2eConfig({ ...full, GITHUB_E2E_URL: " https://ghe.example.com\n" })?.baseUrl,
    ).toBe("https://ghe.example.com");
  });

  test("names what is missing, never the token", () => {
    const { GITHUB_E2E_OWNER: _o, ...rest } = full;
    expect(() => readGithubE2eConfig(rest)).toThrow("GITHUB_E2E_OWNER");
    const { GITHUB_E2E_TOKEN: _t, ...noToken } = full;
    expect(() => readGithubE2eConfig(noToken)).toThrow("GITHUB_E2E_TOKEN");
    for (const bad of [
      { ...full, GITHUB_E2E_REPO: "other/demo" },
      { ...full, GITHUB_E2E_REPO: "sandbox-orchestra/demo" },
      { ...full, GITHUB_E2E_REPO: "sandbox-orch/demo/extra" },
      { ...full, GITHUB_E2E_REPO: "sandbox-orch" },
      { ...full, GITHUB_E2E_ALLOW_WRITES: "true" },
      { ...full, GITHUB_E2E_ALLOW_WRITES: undefined },
    ]) {
      expect(() => readGithubE2eConfig(bad)).toThrow();
      try {
        readGithubE2eConfig(bad);
      } catch (e) {
        expect(String(e)).not.toContain("SECRET-CANARY");
      }
    }
  });
});
