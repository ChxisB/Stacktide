import { describe, expect, test } from "bun:test";
import { createGitlab, GitlabError } from "./index";
import { createMockGitlab } from "./mock/server";

function setup(opts: Parameters<typeof createMockGitlab>[0] = {}) {
  const mock = createMockGitlab(opts);
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  return { mock, api };
}

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("mock server", () => {
  test("rejects a wrong token with 401, accepts either auth style", async () => {
    const { mock } = setup();
    const bad = createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: "wrong-token-123" },
      maxRetries: 0,
    });
    await expect(bad.projects.get(1).catch((e) => e.kind)).resolves.toBe("unauthorized");
    const oauth = createGitlab({ baseUrl: mock.url, auth: { type: "oauth", token: mock.token } });
    mock.addProject({ path: "g/p" });
    expect((await oauth.projects.get("g/p")).path).toBe("g/p");
    mock.stop();
  });

  test("lists projects in id order across pages (keyset-style Link headers)", async () => {
    const { mock, api } = setup({ maxPerPage: 2 });
    const ids = [1, 2, 3, 4, 5].map((i) => mock.addProject({ path: `g/p${i}` }).id);
    const listed = await collect(api.projects.list());
    expect(listed.map((p) => p.id)).toEqual(ids);
    expect(mock.requests.filter((r) => r.path === "/api/v4/projects")).toHaveLength(3);
    mock.stop();
  });

  test("filters by archived and search; an empty repository has no default branch", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/live" });
    mock.addProject({ path: "g/old", archived: true });
    mock.addProject({ path: "g/empty", defaultBranch: null });
    expect((await collect(api.projects.list({ archived: true }))).map((p) => p.path)).toEqual([
      "g/old",
    ]);
    expect((await collect(api.projects.list({ search: "liv" }))).map((p) => p.path)).toEqual([
      "g/live",
    ]);
    expect((await api.projects.get("g/empty")).defaultBranch).toBeNull();
    mock.stop();
  });
});

describe("the default-branch guard", () => {
  test("refuses before sending any commit request", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    const err = await api.repository
      .commitFiles("g/p", { branch: "main", message: "m" }, [
        { action: "create", path: "x", content: "1" },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(GitlabError);
    expect(err.kind).toBe("invalid");
    expect(mock.requests.some((r) => r.method === "POST")).toBe(false);
    mock.stop();
  });
});

describe("the default-branch guard, spelling", () => {
  test("also catches a refs/heads/ prefixed default branch", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    const err = await api.repository
      .commitFiles("g/p", { branch: "refs/heads/main", message: "m" }, [
        { action: "create", path: "x", content: "1" },
      ])
      .catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(mock.requests.some((r) => r.method === "POST")).toBe(false);
    mock.stop();
  });
});

describe("response validation", () => {
  test("a payload of the wrong shape names the fields, never the values", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({ id: "SECRET-VALUE-77", name: 5, path_with_namespace: "g/p", web_url: "u" }),
    });
    const api = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-0123456789" },
      maxRetries: 0,
    });
    const err = await api.projects.get(1).catch((e) => e);
    expect(err).toBeInstanceOf(GitlabError);
    expect(err.kind).toBe("unexpected");
    expect(err.message).toContain("id");
    expect(err.message).toContain("name");
    expect(err.message).not.toContain("SECRET-VALUE-77");
    server.stop(true);
  });

  test("encodes a full project path as one path segment", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "group/sub/repo" });
    await api.projects.get("group/sub/repo");
    expect(mock.requests.at(-1)?.path).toBe("/api/v4/projects/group%2Fsub%2Frepo");
    mock.stop();
  });
});
