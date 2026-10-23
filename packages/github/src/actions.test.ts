import { afterEach, describe, expect, test } from "bun:test";
import { GitlabError } from "@orch/gitlab";
import { type ActionsScope, actionsApi } from "./actions";
import { createGithubClient } from "./client";
import { createMockGithub } from "./mock/server";

// FRG-20: Actions secrets and variables at three scopes. A secret goes up sealed to the scope's own key and never comes
// back; a variable is plain. The mock opens every secret with the key it handed out, so what it holds is what was meant.

let mock: ReturnType<typeof createMockGithub>;
afterEach(() => mock?.stop());

const TOKEN = "ghp_not-a-real-token-1234";
const CANARY = "canary-value-9f3a";

const REPO: ActionsScope = { repository: "acme/svc" };
const ENV: ActionsScope = { repository: "acme/svc", environment: "prod" };
const ORG: ActionsScope = { organization: "acme" };
const SCOPES: [string, ActionsScope][] = [
  ["a repository", REPO],
  ["an environment", ENV],
  ["an organization", ORG],
];
const held = (scope: ActionsScope) => mock.actions(scope);

function setup(opts: Parameters<typeof createMockGithub>[0] = {}) {
  mock?.stop();
  mock = createMockGithub(opts);
  mock.addOrg("acme");
  mock.addRepo("acme", "svc");
  mock.addEnvironment("acme", "svc", "prod", []);
  const client = createGithubClient({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    token: TOKEN,
    maxRetries: 0,
  });
  return {
    api: actionsApi(client),
    asked: () => mock.requests.map((r) => `${r.method} ${r.path}`),
  };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as GitlabError;
  }
  throw new Error("expected a failure");
};

describe.each(SCOPES)("secrets of %s", (_, scope) => {
  test("a secret is sealed to the scope's key, and the mock opens what was meant", async () => {
    const { api } = setup();
    await api.secrets.put(scope, "DB_PASSWORD", "p@ss é w0rd");
    expect(held(scope).secrets.DB_PASSWORD?.value).toBe("p@ss é w0rd");
  });

  test("a list gives names and when they changed, not values, and an overwrite moves the time", async () => {
    const { api } = setup();
    await api.secrets.put(scope, "A_KEY", "one");
    const [first] = await api.secrets.list(scope);
    expect(first).toEqual({ name: "A_KEY", updatedAt: expect.any(String) });
    expect(Object.keys(first ?? {}).sort()).toEqual(["name", "updatedAt"]);
    await api.secrets.put(scope, "A_KEY", "two");
    const [second] = await api.secrets.list(scope);
    expect(second?.updatedAt).not.toBe(first?.updatedAt);
    expect(held(scope).secrets.A_KEY?.value).toBe("two");
  });

  test("it can be asked about, and removed; removing what is not there is not_found", async () => {
    const { api } = setup();
    expect(await api.secrets.has(scope, "GONE")).toBe(false);
    await api.secrets.put(scope, "GONE", "x");
    expect(await api.secrets.has(scope, "GONE")).toBe(true);
    await api.secrets.delete(scope, "GONE");
    expect(await api.secrets.has(scope, "GONE")).toBe(false);
    expect((await failure(api.secrets.delete(scope, "GONE"))).kind).toBe("not_found");
  });

  test("every page of a long list is read", async () => {
    const { api } = setup({ maxPerPage: 2 });
    for (const n of ["A", "B", "C", "D", "E"]) await api.secrets.put(scope, n, n);
    expect((await api.secrets.list(scope)).map((s) => s.name)).toEqual(["A", "B", "C", "D", "E"]);
  });

  test("the plaintext is in no request, and the token is in no body", async () => {
    const { api } = setup();
    await api.secrets.put(scope, "S", CANARY);
    for (const r of mock.requests) {
      expect(JSON.stringify(r)).not.toContain(CANARY);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });
});

describe.each(SCOPES)("variables of %s", (_, scope) => {
  test("created, read in a list with its value, changed, and removed", async () => {
    const { api } = setup();
    await api.variables.create(scope, "REGION", "eu-west-1");
    expect(await api.variables.list(scope)).toEqual([
      { name: "REGION", value: "eu-west-1", updatedAt: expect.any(String) },
    ]);
    const before = held(scope).variables.REGION?.updatedAt;
    await api.variables.update(scope, "REGION", "us-east-1");
    expect(held(scope).variables.REGION?.value).toBe("us-east-1");
    expect(held(scope).variables.REGION?.updatedAt).not.toBe(before);
    expect(await api.variables.has(scope, "REGION")).toBe(true);
    await api.variables.delete(scope, "REGION");
    expect(await api.variables.list(scope)).toEqual([]);
  });

  test("a name that is taken is a conflict, and one that is not there is not_found", async () => {
    const { api } = setup();
    await api.variables.create(scope, "TAKEN", "1");
    expect((await failure(api.variables.create(scope, "TAKEN", "2"))).kind).toBe("conflict");
    expect((await failure(api.variables.update(scope, "NOPE", "2"))).kind).toBe("not_found");
    expect((await failure(api.variables.delete(scope, "NOPE"))).kind).toBe("not_found");
    expect(held(scope).variables.TAKEN?.value).toBe("1");
  });

  test("every page of a long list is read", async () => {
    const { api } = setup({ maxPerPage: 2 });
    for (const n of ["A", "B", "C", "D", "E"]) await api.variables.create(scope, n, n);
    expect((await api.variables.list(scope)).map((v) => v.name)).toEqual(["A", "B", "C", "D", "E"]);
  });
});

describe("an organization's items", () => {
  test("are for private repositories unless the caller says otherwise, secret or variable", async () => {
    const { api } = setup();
    await api.secrets.put(ORG, "S1", "x");
    await api.secrets.put(ORG, "S2", "x", { visibility: "all" });
    await api.variables.create(ORG, "V1", "x");
    await api.variables.create(ORG, "V2", "x", { visibility: "all" });
    const { secrets, variables } = held(ORG);
    expect([secrets.S1, secrets.S2, variables.V1, variables.V2].map((i) => i?.visibility)).toEqual([
      "private",
      "all",
      "private",
      "all",
    ]);
  });

  test("a change sets the visibility again, as a PUT does", async () => {
    const { api } = setup();
    await api.secrets.put(ORG, "S", "x", { visibility: "all" });
    await api.secrets.put(ORG, "S", "y");
    expect(held(ORG).secrets.S?.visibility).toBe("private");
    await api.variables.create(ORG, "V", "x", { visibility: "all" });
    await api.variables.update(ORG, "V", "y");
    expect(held(ORG).variables.V?.visibility).toBe("private");
  });

  test("a repository's and an environment's carry no visibility", async () => {
    const { api } = setup();
    await api.secrets.put(REPO, "S", "x", { visibility: "all" });
    await api.variables.create(ENV, "V", "x", { visibility: "all" });
    expect(mock.requests.filter((r) => r.method !== "GET").map((r) => r.body)).toEqual([
      { encrypted_value: expect.any(String), key_id: expect.any(String) },
      { name: "V", value: "x" },
    ]);
  });

  test("an organization that is not there is not_found", async () => {
    const { api } = setup();
    expect((await failure(api.secrets.list({ organization: "other" }))).kind).toBe("not_found");
  });

  test("a token that may not read them is forbidden", async () => {
    const { api } = setup({ denied: ["/orgs/acme/actions/secrets"] });
    expect((await failure(api.secrets.list(ORG))).kind).toBe("forbidden");
  });
});

describe("the scopes are kept apart", () => {
  test("a secret written at one scope is at no other, and each scope has its own key", async () => {
    const { api } = setup();
    mock.addRepo("acme", "other");
    await api.secrets.put(REPO, "S", "repo");
    await api.secrets.put(ENV, "S", "env");
    await api.secrets.put(ORG, "S", "org");
    await api.secrets.put({ repository: "acme/other" }, "T", "other");
    expect(held(REPO).secrets.S?.value).toBe("repo");
    expect(held(ENV).secrets.S?.value).toBe("env");
    expect(held(ORG).secrets.S?.value).toBe("org");
    expect(held({ repository: "acme/other" }).secrets).not.toHaveProperty("S");
    const keys = mock.requests.filter((r) => r.path.endsWith("/public-key")).map((r) => r.path);
    expect(new Set(keys).size).toBe(4);
  });

  test("an environment the repository does not have is not_found", async () => {
    const { api } = setup();
    const e = await failure(api.variables.list({ repository: "acme/svc", environment: "ghost" }));
    expect(e.kind).toBe("not_found");
  });
});

describe("GitHub's names, held to before anything is sent", () => {
  test.each([
    ["has a dash", "MY-KEY"],
    ["starts with a digit", "1KEY"],
    ["starts with GITHUB_", "GITHUB_TOKEN"],
    ["starts with github_ in lower case", "github_x"],
    ["is empty", ""],
    ["has a slash", "A/B"],
    ["has a dot segment", ".."],
    ["has a space", "A B"],
  ])("a name that %s is refused", async (_, name) => {
    const { api, asked } = setup();
    for (const call of [
      () => api.secrets.put(REPO, name, CANARY),
      () => api.secrets.has(REPO, name),
      () => api.secrets.delete(REPO, name),
      () => api.variables.create(REPO, name, CANARY),
      () => api.variables.update(REPO, name, CANARY),
      () => api.variables.has(REPO, name),
      () => api.variables.delete(REPO, name),
    ]) {
      const e = await failure(call());
      expect(e).toBeInstanceOf(GitlabError);
      expect(e.kind).toBe("invalid");
      expect(e.message).not.toContain(CANARY);
    }
    expect(asked()).toEqual([]);
  });

  test("a scope that would climb out of its path is refused", async () => {
    const { api, asked } = setup();
    for (const scope of [
      { repository: "acme/../svc" },
      { repository: "acme/svc", environment: "../x" },
      { organization: "a/b" },
    ]) {
      expect(await failure(api.secrets.list(scope))).toBeInstanceOf(GitlabError);
    }
    expect(asked()).toEqual([]);
  });
});

describe("what GitHub refuses is an error that does not hold the value", () => {
  test("a value over 48 KB is refused by GitHub, and the error does not carry it", async () => {
    const { api } = setup();
    const big = `${CANARY}${"x".repeat(49 * 1024)}`;
    const v = await failure(api.variables.create(REPO, "BIG", big));
    expect(v.kind).toBe("invalid");
    expect(v.message).not.toContain(CANARY);
    const s = await failure(api.secrets.put(REPO, "BIG", big));
    expect(s.kind).toBe("invalid");
    expect(s.message).not.toContain(CANARY);
  });

  test("a secret sealed to a key the scope did not give is refused by GitHub", async () => {
    const { api } = setup();
    mock.inject({
      method: "GET",
      path: "/repos/acme/svc/actions/secrets/public-key",
      status: 200,
      times: 1,
      body: { key_id: "1", key: Buffer.alloc(32, 7).toString("base64") },
    });
    const e = await failure(api.secrets.put(REPO, "S", CANARY));
    expect(e.kind).toBe("invalid");
    expect(e.message).not.toContain(CANARY);
    expect(held(REPO).secrets).toEqual({});
  });

  test("a public key that is not a key is an error before the value is sent", async () => {
    const { api, asked } = setup();
    mock.inject({
      method: "GET",
      path: "/repos/acme/svc/actions/secrets/public-key",
      status: 200,
      times: 1,
      body: { key_id: "1", key: "bm90IGEga2V5" },
    });
    const e = await failure(api.secrets.put(REPO, "S", CANARY));
    expect(e).toBeInstanceOf(GitlabError);
    expect(asked().filter((r) => r.startsWith("PUT"))).toEqual([]);
  });

  test("a reply that is not the shape asked for is an error", async () => {
    const { api } = setup();
    mock.inject({
      method: "GET",
      path: "/repos/acme/svc/actions/variables",
      status: 200,
      times: 1,
      body: { total_count: 1, variables: [{ name: "A" }] },
    });
    expect(await failure(api.variables.list(REPO))).toBeInstanceOf(GitlabError);
  });

  test("the token is in no error", async () => {
    const { api } = setup({ denied: ["/actions/secrets"] });
    const e = await failure(api.secrets.put(REPO, "S", CANARY));
    expect(e.kind).toBe("forbidden");
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain(CANARY);
  });
});
