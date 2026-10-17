import { describe, expect, test } from "bun:test";
import { readE2eConfig } from "./e2e-config";

const full = {
  GITLAB_E2E_URL: "https://gitlab.example.com",
  GITLAB_E2E_TOKEN: "glpat-SECRET-CANARY-123",
  GITLAB_E2E_GROUP: "sandbox/orch",
  GITLAB_E2E_PROJECT: "sandbox/orch/demo",
  GITLAB_E2E_ALLOW_WRITES: "yes",
};

describe("readE2eConfig", () => {
  test("is off unless a URL is given", () => {
    expect(readE2eConfig({})).toBeNull();
    expect(readE2eConfig({ GITLAB_E2E_TOKEN: "x" })).toBeNull();
  });

  test("returns the settings when complete, trimming slashes", () => {
    expect(
      readE2eConfig({
        ...full,
        GITLAB_E2E_GROUP: "/sandbox/orch/",
        GITLAB_E2E_PROJECT: "sandbox/orch/demo/",
      }),
    ).toEqual({
      baseUrl: "https://gitlab.example.com",
      token: "glpat-SECRET-CANARY-123",
      group: "sandbox/orch",
      project: "sandbox/orch/demo",
    });
  });

  test("trims the URL; an unset-but-blank one is off", () => {
    expect(
      readE2eConfig({ ...full, GITLAB_E2E_URL: "  https://gitlab.example.com\n" })?.baseUrl,
    ).toBe("https://gitlab.example.com");
    expect(readE2eConfig({ ...full, GITLAB_E2E_URL: "  " })).toBeNull();
  });

  test("names what is missing, never the token", () => {
    const { GITLAB_E2E_GROUP: _g, GITLAB_E2E_PROJECT: _p, ...rest } = full;
    expect(() => readE2eConfig(rest)).toThrow("GITLAB_E2E_GROUP, GITLAB_E2E_PROJECT");
    for (const bad of [
      { ...full, GITLAB_E2E_PROJECT: "other/demo" },
      { ...full, GITLAB_E2E_PROJECT: "sandbox/orchestra/demo" },
      { ...full, GITLAB_E2E_ALLOW_WRITES: "true" },
      { ...full, GITLAB_E2E_ALLOW_WRITES: undefined },
    ]) {
      expect(() => readE2eConfig(bad)).toThrow();
      try {
        readE2eConfig(bad);
      } catch (e) {
        expect(String(e)).not.toContain("SECRET-CANARY");
      }
    }
  });
});
