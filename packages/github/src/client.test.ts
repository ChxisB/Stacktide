import { afterEach, describe, expect, test } from "bun:test";
import { GitlabError, type GitlabErrorKind } from "@orch/gitlab";
import { apiRootOf, createGithubClient } from "./client";
import { createMockGithub, type MockGithub } from "./mock/server";

const TOKEN = "ghp_not-a-real-token-1234";
let mock: MockGithub | undefined;
afterEach(() => mock?.stop());

function setup(
  o: {
    mockOpts?: Parameters<typeof createMockGithub>[0];
    now?: () => number;
    retries?: number;
  } = {},
) {
  mock = createMockGithub(o.mockOpts);
  const slept: number[] = [];
  const client = createGithubClient({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    token: TOKEN,
    maxRetries: o.retries ?? 3,
    sleep: async (ms) => void slept.push(ms),
    now: o.now,
  });
  return { mock, client, slept };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof GitlabError) return e;
    throw e;
  }
  throw new Error("expected a failure");
};

describe("what is sent", () => {
  test("every request carries the token, the API version, an accept type and a user agent", async () => {
    const { mock, client } = setup();
    expect(await client.request("GET", "/user")).toMatchObject({ login: "mock-user" });
    const [seen] = mock.requests;
    expect(seen?.authorized).toBe(true);
    expect(seen?.headers).toMatchObject({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "orch-control-plane",
    });
  });

  test("a body goes as JSON; a query leaves undefined values out", async () => {
    const { mock, client } = setup();
    mock.inject({ method: "POST", path: "/x", status: 201, times: 1, body: {} });
    await client.request("POST", "/x", { body: { a: 1 }, query: { q: "v", skipped: undefined } });
    const [seen] = mock.requests;
    expect(seen?.body).toEqual({ a: 1 });
    expect(seen?.headers["content-type"]).toBe("application/json");
    expect([...(seen?.query.keys() ?? [])]).toEqual(["q"]);
  });

  test("a response with no body gives undefined (a 204)", async () => {
    const { mock, client } = setup();
    mock.inject({ method: "POST", path: "/dispatches", status: 204, times: 1 });
    expect(await client.request("POST", "/dispatches")).toBeUndefined();
  });
});

describe("a failure", () => {
  const cases: [number, GitlabErrorKind][] = [
    [400, "invalid"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "invalid"],
    [500, "server"],
    [503, "server"],
    [418, "unexpected"],
  ];
  for (const [status, kind] of cases) {
    test(`${status} is ${kind}, with GitHub's own words and no token`, async () => {
      const { mock, client } = setup({ retries: 0 });
      mock.inject({
        method: "POST",
        path: "/boom",
        status,
        times: 1,
        body: { message: `said no ${TOKEN}` },
      });
      const e = await failure(client.request("POST", "/boom", { query: { secret: "q" } }));
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
      expect(e.message).toContain(`POST /boom failed (${status}): said no [REDACTED]`);
      expect(e.message).not.toContain(TOKEN);
      expect(e.message).not.toContain("secret=q"); // no query string
    });
  }

  test("a value the caller marks secret is scrubbed from GitHub's words", async () => {
    const { mock, client } = setup({ retries: 0 });
    mock.inject({
      method: "PUT",
      path: "/vars",
      status: 422,
      times: 1,
      body: { message: "bad value hunter2-value" },
    });
    const e = await failure(
      client.request("PUT", "/vars", { body: { v: "hunter2-value" }, redact: ["hunter2-value"] }),
    );
    expect(e.message).toContain("bad value [REDACTED]");
    expect(e.message).not.toContain("hunter2-value");
  });

  test("the token is hidden even where it came from the caller's own path", async () => {
    const { mock, client } = setup({ retries: 0 });
    mock.inject({ method: "GET", path: `/x/${TOKEN}`, status: 404, times: 1 });
    const e = await failure(client.request("GET", `/x/${TOKEN}`));
    expect(e.message).toContain("GET /x/[REDACTED] failed (404)");
    expect(e.message).not.toContain(TOKEN);
  });

  test("an HTML error page is not echoed", async () => {
    const { mock, client } = setup({ retries: 0 });
    mock.inject({ method: "GET", path: "/page", status: 502, times: 1, body: "<html>hi</html>" });
    const e = await failure(client.request("GET", "/page"));
    expect(e.message).toBe("GitHub GET /page failed (502)");
  });

  test("a renamed repository is a 301 that names where, and is not followed", async () => {
    const { mock, client } = setup({ retries: 0 });
    mock.inject({
      method: "GET",
      path: "/repos/a/old",
      status: 301,
      times: 1,
      headers: { location: `${mock.url}/api/v3/repositories/9?token=nope` },
    });
    const e = await failure(client.request("GET", "/repos/a/old"));
    expect(e.kind).toBe("unexpected");
    expect(e.message).toContain("redirected to ");
    expect(e.message).toContain("/api/v3/repositories/9");
    expect(e.message).not.toContain("token=nope");
    expect(mock.requests.filter((r) => r.path === "/repositories/9")).toHaveLength(0);
  });

  test("a 2xx that is not JSON is unexpected", async () => {
    const { mock, client } = setup({ retries: 0 });
    mock.inject({ method: "GET", path: "/odd", status: 200, times: 1, body: "not json" });
    const e = await failure(client.request("GET", "/odd"));
    expect(e).toMatchObject({ kind: "unexpected", status: 200 });
    expect(e.message).toContain("non-JSON");
  });

  test("a GitHub nobody answers for is a network failure, and a stalled one a timeout", async () => {
    const dead = createGithubClient({
      baseUrl: "http://127.0.0.1:1",
      allowInsecureHttp: true,
      token: TOKEN,
      maxRetries: 0,
    });
    const e = await failure(dead.request("GET", "/user"));
    expect(e.kind).toBe("network");
    expect(e.message).not.toContain(TOKEN);
    const stalled = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise(() => {}),
    });
    try {
      const slow = createGithubClient({
        baseUrl: `http://127.0.0.1:${stalled.port}`,
        allowInsecureHttp: true,
        token: TOKEN,
        timeoutMs: 50,
        maxRetries: 0,
      });
      expect((await failure(slow.request("GET", "/user"))).kind).toBe("timeout");
    } finally {
      stalled.stop(true);
    }
  });
});

describe("retries", () => {
  test("a GET is retried after a 5xx and then succeeds", async () => {
    const { mock, client, slept } = setup();
    mock.inject({ method: "GET", path: "/user", status: 502, times: 2 });
    expect(await client.request("GET", "/user")).toMatchObject({ login: "mock-user" });
    expect(mock.requests.filter((r) => r.path === "/user")).toHaveLength(3);
    expect(slept).toHaveLength(2);
  });

  test("a POST is not retried after a 5xx: the outcome is unknown", async () => {
    const { mock, client, slept } = setup();
    mock.inject({ method: "POST", path: "/dispatch", status: 502, times: 5 });
    expect((await failure(client.request("POST", "/dispatch"))).kind).toBe("server");
    expect(mock.requests).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  test("retries run out: the last failure is thrown", async () => {
    const { mock, client } = setup({ retries: 2 });
    mock.inject({ method: "GET", path: "/user", status: 503, times: 9 });
    expect((await failure(client.request("GET", "/user"))).status).toBe(503);
    expect(mock.requests).toHaveLength(3);
  });
});

describe("rate limits", () => {
  test("a 403 with retry-after waits that long, then succeeds (any method)", async () => {
    const { mock, client, slept } = setup();
    mock.inject({
      method: "POST",
      path: "/x",
      status: 403,
      times: 1,
      headers: { "retry-after": "7" },
      body: { message: "You have exceeded a secondary rate limit" },
    });
    mock.inject({ method: "POST", path: "/x", status: 201, times: 1, body: { ok: true } });
    expect(await client.request("POST", "/x")).toEqual({ ok: true });
    expect(slept).toEqual([7000]);
    expect(mock.requests).toHaveLength(2);
  });

  test("a spent allowance waits until x-ratelimit-reset", async () => {
    const now = 1_700_000_000_000;
    const { mock, client, slept } = setup({ now: () => now });
    mock.inject({
      method: "GET",
      path: "/user",
      status: 403,
      times: 1,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(now / 1000 + 12),
      },
    });
    await client.request("GET", "/user");
    expect(slept).toEqual([12_000]);
  });

  test("a reset already past waits no time", async () => {
    const now = 1_700_000_000_000;
    const { mock, client, slept } = setup({ now: () => now });
    mock.inject({
      method: "GET",
      path: "/user",
      status: 429,
      times: 1,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 - 5) },
    });
    await client.request("GET", "/user");
    expect(slept).toEqual([0]);
  });

  test("a 429 with an HTTP-date retry-after waits until then", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const { mock, client, slept } = setup({ now: () => now });
    mock.inject({
      method: "GET",
      path: "/user",
      status: 429,
      times: 1,
      headers: { "retry-after": "Thu, 01 Jan 2026 00:00:09 GMT" },
    });
    await client.request("GET", "/user");
    expect(slept).toEqual([9000]);
  });

  test("a limit that says nothing is taken as a minute, which is more than the caller will wait", async () => {
    const { mock, client, slept } = setup();
    mock.inject({ method: "GET", path: "/user", status: 429, times: 1 });
    const e = await failure(client.request("GET", "/user"));
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(60_000);
    expect(slept).toEqual([]);
    expect(mock.requests).toHaveLength(1);
  });

  test("a wait beyond maxRetryDelayMs fails with how long to wait", async () => {
    const { mock, client } = setup();
    mock.inject({
      method: "GET",
      path: "/user",
      status: 403,
      times: 1,
      headers: { "retry-after": "120" },
    });
    const e = await failure(client.request("GET", "/user"));
    expect(e).toMatchObject({ kind: "rate_limited", status: 403, retryAfterMs: 120_000 });
  });

  test("a plain 403 (no retry-after, allowance left) is a permission, never waited for", async () => {
    const { mock, client, slept } = setup();
    mock.inject({
      method: "GET",
      path: "/user",
      status: 403,
      times: 1,
      headers: { "x-ratelimit-remaining": "4999" },
      body: { message: "Resource not accessible by personal access token" },
    });
    const e = await failure(client.request("GET", "/user"));
    expect(e.kind).toBe("forbidden");
    expect(slept).toEqual([]);
  });

  test("limited every time: retries run out", async () => {
    const { mock, client, slept } = setup({ retries: 2 });
    mock.inject({
      method: "GET",
      path: "/user",
      status: 429,
      times: 9,
      headers: { "retry-after": "1" },
    });
    expect((await failure(client.request("GET", "/user"))).kind).toBe("rate_limited");
    expect(slept).toEqual([1000, 1000]);
  });
});

describe("pagination", () => {
  test("a list over three pages is walked by the Link header", async () => {
    const { mock, client } = setup({ mockOpts: { maxPerPage: 2 } });
    for (let i = 1; i <= 5; i++) mock.addRepo("acme", `r${i}`);
    const names: string[] = [];
    for await (const r of client.paginate<{ name: string }>("/user/repos")) names.push(r.name);
    expect(names).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    const pages = mock.requests.filter((r) => r.path === "/user/repos");
    expect(pages.map((r) => r.query.get("page"))).toEqual([null, "2", "3"]);
    // the first ask is for 100; the mock's cap shows in the links it gives back, which are followed as they are
    expect(pages.map((r) => r.query.get("per_page"))).toEqual(["100", "2", "2"]);
    expect(pages.every((r) => r.authorized)).toBe(true);
  });

  test("asks for 100 a page unless told otherwise", async () => {
    const { mock, client } = setup();
    for await (const _ of client.paginate("/user/repos"));
    expect(mock.requests[0]?.query.get("per_page")).toBe("100");
  });

  test("a list wrapped in an object is read from the named key", async () => {
    const { mock, client } = setup({ mockOpts: { maxPerPage: 1 } });
    mock.addRepo("acme", "a");
    mock.addRepo("acme", "b");
    const names: string[] = [];
    for await (const r of client.paginate<{ name: string }>(
      "/installation/repositories",
      {},
      "repositories",
    )) {
      names.push(r.name);
    }
    expect(names).toEqual(["a", "b"]);
  });

  test("an answer that is not a list is refused", async () => {
    const { client } = setup();
    const walk = async () => {
      for await (const _ of client.paginate("/user"));
    };
    const e = await failure(walk());
    expect(e.kind).toBe("unexpected");
    expect(e.message).toContain("did not return a list");
  });

  test("a link that does not advance stops the walk", async () => {
    const { mock, client } = setup();
    const self = `${mock.url}/api/v3/loop?per_page=100`;
    mock.inject({
      method: "GET",
      path: "/loop",
      status: 200,
      times: 5,
      body: [],
      headers: { link: `<${self}>; rel="next"` },
    });
    const walk = async () => {
      for await (const _ of client.paginate("/loop"));
    };
    expect((await failure(walk())).message).toContain("pagination did not advance");
    expect(mock.requests).toHaveLength(1);
  });

  test("a link to another path of the host, outside the API, stops the walk", async () => {
    const { mock, client } = setup();
    mock.inject({
      method: "GET",
      path: "/leave",
      status: 200,
      times: 1,
      body: [],
      headers: { link: `<${mock.url}/elsewhere?page=2>; rel="next"` },
    });
    const walk = async () => {
      for await (const _ of client.paginate("/leave"));
    };
    expect((await failure(walk())).message).toContain("left the API");
  });

  test("a link to another host is read as a path of the configured one: the token never leaves", async () => {
    const { mock, client } = setup();
    mock.inject({
      method: "GET",
      path: "/other",
      status: 200,
      times: 1,
      body: [1],
      headers: { link: `<https://evil.example/api/v3/stolen?page=2>; rel="next"` },
    });
    mock.inject({ method: "GET", path: "/stolen", status: 200, times: 1, body: [] });
    const got: unknown[] = [];
    for await (const x of client.paginate("/other")) got.push(x);
    expect(mock.requests.map((r) => r.path)).toEqual(["/other", "/stolen"]);
    expect(got).toEqual([1]);
  });
});

describe("download", () => {
  test("gives the text of a file, or says it is too large", async () => {
    const { mock, client } = setup();
    mock.addRepo("acme", "a");
    const small = await client.download("/repos/acme/a", { maxBytes: 10_000 });
    expect("text" in small && small.text).toContain('"full_name":"acme/a"');
    expect(await client.download("/repos/acme/a", { maxBytes: 5 })).toEqual({ tooLarge: true });
  });

  test("a failure is read in full and mapped as ever", async () => {
    const { client } = setup({ retries: 0 });
    const e = await failure(client.download("/repos/acme/none", { maxBytes: 5 }));
    expect(e.kind).toBe("not_found");
  });
});

describe("addresses", () => {
  test("github.com and api.github.com are served from api.github.com; any other host under /api/v3", () => {
    expect(apiRootOf()).toBe("https://api.github.com");
    expect(apiRootOf("https://github.com/")).toBe("https://api.github.com");
    expect(apiRootOf("https://api.github.com")).toBe("https://api.github.com");
    expect(apiRootOf("https://ghe.example.com")).toBe("https://ghe.example.com/api/v3");
    expect(apiRootOf("https://ghe.example.com:8443/sub/")).toBe(
      "https://ghe.example.com:8443/sub/api/v3",
    );
  });

  test("the same checks as GitLab's address, naming GitHub", () => {
    expect(() => apiRootOf("http://ghe.example.com")).toThrow(/GitHub baseUrl/);
    expect(() => apiRootOf("not a url")).toThrow(/GitHub baseUrl is not a valid URL/);
    expect(() => apiRootOf("https://user:pw@ghe.example.com")).toThrow(/GitHub baseUrl/);
    expect(apiRootOf("http://127.0.0.1:9", true)).toBe("http://127.0.0.1:9/api/v3");
  });

  test("a short token is refused at construction, and is never in the error", () => {
    expect(() => createGithubClient({ token: "short" })).toThrow(
      "GitHub token is missing or too short",
    );
  });

  test("a path must start with / and carry no query, fragment or dot segments", async () => {
    const { client } = setup();
    for (const bad of ["user", "/a?b=1", "/a#f", "/a/../b", "/a/%2e%2e/b", "/a\\b"]) {
      await expect(client.request("GET", bad)).rejects.toThrow(TypeError);
    }
  });

  test("a path that starts with // stays on the configured host", async () => {
    const { mock, client } = setup({ retries: 0 });
    const e = await failure(client.request("GET", "//evil.example/x"));
    expect(e.kind).toBe("not_found");
    expect(mock.requests).toHaveLength(1);
  });
});
