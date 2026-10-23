import { describe, expect, test } from "bun:test";
import { createGitlab, GitlabError } from "./index";
import { capabilitiesOf, parseInstance } from "./instance";
import { createMockGitlab } from "./mock/server";

const state = (version: string, enterprise?: boolean, id = "hiddenVariables") =>
  capabilitiesOf(parseInstance(version, enterprise)).find((c) => c.id === id)?.state;

describe("what a GitLab version string says", () => {
  test("is a version, with or without a suffix, and an edition from the field or the suffix", () => {
    expect(parseInstance("17.4.1-ee")).toMatchObject({ major: 17, minor: 4, enterprise: true });
    expect(parseInstance("17.4.1")).toMatchObject({ major: 17, minor: 4, enterprise: false });
    expect(parseInstance("18.0.0-pre")).toMatchObject({ major: 18, minor: 0, enterprise: false });
    // The field wins: it is GitLab's own statement of the edition.
    expect(parseInstance("17.4.1", true).enterprise).toBe(true);
    expect(parseInstance("17.4.1-ee", false).enterprise).toBe(false);
  });

  test("a string that is not a version is kept as it came, and says nothing of its number", () => {
    expect(parseInstance("nightly")).toEqual({
      version: "nightly",
      major: null,
      minor: null,
      enterprise: false,
    });
  });
});

describe("hidden variables need GitLab 17.4", () => {
  test.each([
    ["16.11.9", "no"],
    ["17.0.0", "no"],
    ["17.3.9", "no"],
    ["17.4.0", "yes"],
    ["17.4.1-ee", "yes"],
    ["17.10.2", "yes"],
    ["18.0.0", "yes"],
    ["19.2.0-ee", "yes"],
  ])("%s is %s", (version, expected) => {
    expect(state(version)).toBe(expected as "yes" | "no");
  });

  test("a version it cannot read is unknown, not a refusal", () => {
    expect(state("nightly")).toBe("unknown");
  });
});

describe("environment scopes on group variables need Premium or Ultimate", () => {
  const scopes = "groupVariableScopes";
  test("a Community Edition cannot have them, whatever its version", () => {
    expect(state("18.1.1", undefined, scopes)).toBe("no");
    expect(state("18.1.1", false, scopes)).toBe("no");
  });
  test("an Enterprise Edition may: the licence is not in the API, so it is unknown", () => {
    expect(state("18.1.1-ee", undefined, scopes)).toBe("unknown");
    expect(state("18.1.1", true, scopes)).toBe("unknown");
  });
});

describe("every capability says what it needs", () => {
  test("a label and a need, in words, for each", () => {
    for (const c of capabilitiesOf(parseInstance("17.0.0"))) {
      expect(c.label.length).toBeGreaterThan(5);
      expect(c.needs.length).toBeGreaterThan(5);
    }
  });
});

describe("asking the instance", () => {
  const setup = (opts: Parameters<typeof createMockGitlab>[0] = {}) => {
    const mock = createMockGitlab(opts);
    const api = createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: mock.token },
      maxRetries: 0,
    });
    return { mock, api };
  };

  test("reads the version and the edition the mock was given, and follows a change", async () => {
    const { mock, api } = setup({ version: "17.3.2", enterprise: false });
    expect(await api.instance.info()).toMatchObject({ version: "17.3.2", major: 17, minor: 3 });
    mock.setVersion("18.2.0-ee");
    const now = await api.instance.info();
    expect([now.version, now.enterprise]).toEqual(["18.2.0-ee", true]);
    mock.stop();
  });

  test("a version that is not a string is an unexpected-answer error, and a refusal keeps its kind", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ version: 17 }) });
    const odd = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-odd-server" },
      maxRetries: 0,
    });
    const e = await odd.instance.info().catch((x) => x);
    expect([e instanceof GitlabError, (e as GitlabError).kind]).toEqual([true, "unexpected"]);
    server.stop(true);

    const { mock, api } = setup();
    mock.inject({ path: "/api/v4/version", status: 404 });
    const gone = await api.instance.info().catch((x) => x);
    expect((gone as GitlabError).kind).toBe("not_found");
    mock.stop();
  });
});
