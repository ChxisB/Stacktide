import { afterEach, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { createGitlabClient, GitlabError, type GitlabErrorKind } from "./index";

const TOKEN = "glpat-SECRET-CANARY-1234567890";

type Handler = (req: Request, n: number) => Response | Promise<Response>;
const servers: ReturnType<typeof Bun.serve>[] = [];

function fake(handler: Handler) {
  let count = 0;
  // Bun invalidates the Request once the handler returns, so keep a snapshot.
  const seen: { url: string; method: string; headers: Headers; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      seen.push({
        url: req.url,
        method: req.method,
        headers: new Headers(req.headers),
        body: await req.clone().text(),
      });
      return handler(req, ++count);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen, server };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function setup(handler: Handler, over: Partial<Parameters<typeof createGitlabClient>[0]> = {}) {
  const srv = fake(handler);
  const sleeps: number[] = [];
  const lines: string[] = [];
  const client = createGitlabClient({
    baseUrl: srv.url,
    auth: { type: "private-token", token: TOKEN },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    logger: createLogger({ write: (l) => lines.push(l), level: "debug" }),
    ...over,
  });
  return { ...srv, client, sleeps, lines };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

async function caught(p: Promise<unknown>): Promise<GitlabError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GitlabError);
    return e as GitlabError;
  }
  throw new Error("expected the call to fail");
}

describe("requests", () => {
  test("a personal/project/group token goes in PRIVATE-TOKEN, OAuth in a bearer header", async () => {
    const pat = setup(() => json({}));
    await pat.client.request("GET", "/user");
    expect(pat.seen[0]?.headers.get("private-token")).toBe(TOKEN);
    expect(pat.seen[0]?.headers.get("authorization")).toBeNull();

    const oauth = setup(() => json({}), { auth: { type: "oauth", token: TOKEN } });
    await oauth.client.request("GET", "/user");
    expect(oauth.seen[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(oauth.seen[0]?.headers.get("private-token")).toBeNull();
  });

  test("builds /api/v4 URLs with encoded query, skipping undefined values", async () => {
    const { client, seen } = setup(() => json([]));
    await client.request("GET", "/projects", { query: { search: "a b&c", page: 2, x: undefined } });
    const url = new URL(seen[0]?.url ?? "");
    expect(url.pathname).toBe("/api/v4/projects");
    expect(url.searchParams.get("search")).toBe("a b&c");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("x")).toBe(false);
  });

  test("keeps a relative-URL-root prefix and tolerates a trailing slash", async () => {
    const srv = fake(() => json({}));
    const client = createGitlabClient({
      baseUrl: `${srv.url}/gitlab/`,
      auth: { type: "private-token", token: TOKEN },
    });
    await client.request("GET", "/user");
    expect(new URL(srv.seen[0]?.url ?? "").pathname).toBe("/gitlab/api/v4/user");
  });

  test("sends a JSON body with a content type; 204 resolves to undefined", async () => {
    const { client, seen } = setup(() => new Response(null, { status: 204 }));
    const out = await client.request("POST", "/projects/1/variables", { body: { key: "A" } });
    expect(out).toBeUndefined();
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ key: "A" });
  });

  test("a path cannot redirect the request to another host", async () => {
    const { client, seen } = setup(() => json({}));
    await client.request("GET", "//evil.example/x");
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/api/v4//evil.example/x");
    await expect(client.request("GET", "no-slash")).rejects.toThrow(TypeError);
  });

  test("paths with a query, fragment, backslash or dot segments are refused", async () => {
    const { client, seen } = setup(() => json({}));
    for (const bad of ["/p?x=1", "/p#f", "/a/../b", "/a/%2e%2E/b", "/a/./b", "/a\\b", "/.."]) {
      await expect(client.request("GET", bad)).rejects.toThrow(TypeError);
    }
    await client.request("GET", "/projects/group%2Fsub%2Frepo/variables"); // encoded ids stay valid
    expect(seen).toHaveLength(1);
  });

  test("a 200 that is not JSON is an unexpected error without the body", async () => {
    const { client } = setup(() => new Response("<html>login page</html>"));
    const err = await caught(client.request("GET", "/user"));
    expect(err.kind).toBe("unexpected");
    expect(err.message).not.toContain("login page");
  });
});

describe("construction", () => {
  const make = (baseUrl: string, token = TOKEN, extra = {}) =>
    createGitlabClient({ baseUrl, auth: { type: "private-token", token }, ...extra });

  test("refuses cleartext http to a non-loopback host unless explicitly allowed", () => {
    expect(() => make("http://gitlab.example.com")).toThrow(/https/);
    expect(() =>
      make("http://gitlab.example.com", TOKEN, { allowInsecureHttp: true }),
    ).not.toThrow();
    expect(() => make("https://gitlab.example.com")).not.toThrow();
    expect(() => make("http://localhost:8080")).not.toThrow();
  });

  test("refuses invalid urls, urls with credentials and empty tokens, without echoing them", () => {
    expect(() => make("not a url")).toThrow(TypeError);
    expect(() => make("ftp://gitlab.example.com")).toThrow(TypeError);
    let message = "";
    try {
      make("https://bot:hunter2@gitlab.example.com");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("hunter2");
    expect(() => make("https://gitlab.example.com", "")).toThrow(TypeError);
    expect(() => make("https://gitlab.example.com", "short")).toThrow(TypeError);
  });
});

describe("pagination", () => {
  const link = (url: string, rel = "next") => `<${url}>; rel="${rel}"`;

  test("follows Link rel=next across pages, in order, and stops without one", async () => {
    const { client, seen, url } = setup((_req, n) => {
      if (n === 1) {
        return json([1, 2], {
          headers: {
            link: `${link(`${url}/api/v4/projects?page=2&per_page=100`)}, ${link(`${url}/x`, "last")}`,
          },
        });
      }
      if (n === 2) {
        return json([3], {
          headers: { link: link(`${url}/api/v4/projects?cursor=abc&per_page=100`) },
        });
      }
      return json([4, 5]);
    });
    const out: number[] = [];
    for await (const item of client.paginate<number>("/projects", { order_by: "id" }))
      out.push(item);
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toHaveLength(3);
    const first = new URL(seen[0]?.url ?? "");
    expect(first.searchParams.get("per_page")).toBe("100");
    expect(first.searchParams.get("order_by")).toBe("id");
    expect(new URL(seen[2]?.url ?? "").searchParams.get("cursor")).toBe("abc");
  });

  test("per_page defaults to 100 even when the caller passes it as undefined", async () => {
    const { client, seen } = setup(() => json([]));
    for await (const _ of client.paginate("/projects", { per_page: undefined }));
    for await (const _ of client.paginate("/projects", { per_page: 20 }));
    const per = seen.map((r) => new URL(r.url).searchParams.get("per_page"));
    expect(per).toEqual(["100", "20"]);
  });

  test("a next link outside the API path is an error, not followed", async () => {
    const { client, seen, url } = setup(() =>
      json([1], { headers: { link: link(`${url}/other-app/admin?page=2`) } }),
    );
    const run = async () => {
      for await (const _ of client.paginate("/projects"));
    };
    expect((await caught(run())).kind).toBe("unexpected");
    expect(seen).toHaveLength(1);
  });

  test("a next link on another host is fetched from the configured host instead", async () => {
    const elsewhere = fake(() => json([99]));
    const { client, seen, url } = setup((_req, n) =>
      n === 1
        ? json([1], { headers: { link: link(`${elsewhere.url}/api/v4/projects?page=2`) } })
        : json([2]),
    );
    const out: number[] = [];
    for await (const item of client.paginate<number>("/projects")) out.push(item);
    expect(out).toEqual([1, 2]);
    expect(elsewhere.seen).toHaveLength(0);
    expect(new URL(seen[1]?.url ?? "").origin).toBe(url);
  });

  test("a server that keeps returning the same next link ends in an error", async () => {
    const { client, url } = setup(() =>
      json([1], { headers: { link: link(`${url}/api/v4/projects?page=2`) } }),
    );
    const run = async () => {
      for await (const _ of client.paginate("/projects"));
    };
    expect((await caught(run())).kind).toBe("unexpected");
  });

  test("a page that is not an array is an unexpected error", async () => {
    const { client } = setup(() => json({ message: "nope" }));
    const run = async () => {
      for await (const _ of client.paginate("/projects"));
    };
    expect((await caught(run())).kind).toBe("unexpected");
  });

  test("a caller can stop early without fetching further pages", async () => {
    const { client, seen, url } = setup(() =>
      json([1, 2], { headers: { link: link(`${url}/api/v4/projects?page=2`) } }),
    );
    for await (const _ of client.paginate("/projects")) break;
    expect(seen).toHaveLength(1);
  });
});

describe("rate limits", () => {
  test("a 429 waits Retry-After seconds and retries, for any method", async () => {
    const { client, sleeps, seen } = setup((_req, n) =>
      n === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "2" } })
        : json({ ok: 1 }),
    );
    expect(await client.request("POST", "/projects/1/pipeline")).toEqual({ ok: 1 });
    expect(sleeps).toEqual([2000]);
    expect(seen).toHaveLength(2);
  });

  test("a Retry-After given as an HTTP date is understood", async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    const { client, sleeps } = setup((_req, n) =>
      n === 1 ? new Response("", { status: 429, headers: { "retry-after": at } }) : json({}),
    );
    await client.request("GET", "/user");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(2000);
    expect(sleeps[0]).toBeLessThanOrEqual(5000);
  });

  test("a wait longer than the cap fails at once as rate_limited, carrying the wait", async () => {
    const { client, sleeps, seen } = setup(
      () => new Response("", { status: 429, headers: { "retry-after": "600" } }),
      { maxRetryDelayMs: 30_000 },
    );
    const err = await caught(client.request("GET", "/user"));
    expect(err.kind).toBe("rate_limited");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(600_000);
    expect(sleeps).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  test("without Retry-After it backs off exponentially, then gives up after maxRetries", async () => {
    const { client, sleeps, seen } = setup(() => new Response("", { status: 429 }), {
      maxRetries: 3,
      retryBaseMs: 100,
    });
    const err = await caught(client.request("GET", "/user"));
    expect(err.kind).toBe("rate_limited");
    expect(seen).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
    sleeps.forEach((ms, i) => {
      const full = 100 * 2 ** i;
      expect(ms).toBeGreaterThanOrEqual(full / 2);
      expect(ms).toBeLessThanOrEqual(full);
    });
  });
});

describe("server errors", () => {
  test("a GET is retried on 5xx up to the limit, then fails as server", async () => {
    const { client, seen, sleeps } = setup(() => new Response("boom", { status: 502 }), {
      maxRetries: 2,
    });
    const err = await caught(client.request("GET", "/user"));
    expect(err.kind).toBe("server");
    expect(err.status).toBe(502);
    expect(seen).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  test("a 5xx that clears up resolves normally", async () => {
    const { client } = setup((_req, n) =>
      n === 1 ? new Response("", { status: 503 }) : json({ ok: true }),
    );
    expect(await client.request("PUT", "/projects/1/variables/A", { body: {} })).toEqual({
      ok: true,
    });
    const del = setup((_req, n) =>
      n === 1 ? new Response("", { status: 500 }) : new Response(null, { status: 204 }),
    );
    expect(await del.client.request("DELETE", "/projects/1/variables/A")).toBeUndefined();
  });

  test("a POST is not retried on 5xx, since it may already have been applied", async () => {
    const { client, seen, sleeps } = setup(() => new Response("", { status: 500 }));
    const err = await caught(
      client.request("POST", "/projects/1/variables", { body: { key: "A" } }),
    );
    expect(err.kind).toBe("server");
    expect(seen).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});

describe("timeouts and network", () => {
  test("a hanging server is a timeout error; GETs retry, POSTs do not", async () => {
    const hang = () => new Promise<Response>(() => {});
    const get = setup(hang, { timeoutMs: 40, maxRetries: 1 });
    const err = await caught(get.client.request("GET", "/user"));
    expect(err.kind).toBe("timeout");
    expect(get.seen).toHaveLength(2);

    const post = setup(hang, { timeoutMs: 40, maxRetries: 1 });
    expect((await caught(post.client.request("POST", "/user", { body: {} }))).kind).toBe("timeout");
    expect(post.seen).toHaveLength(1);
  });

  test("a body that stalls after the headers also times out", async () => {
    const { client } = setup(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("[1,"));
            },
          }),
        ),
      { timeoutMs: 40, maxRetries: 0 },
    );
    expect((await caught(client.request("GET", "/user"))).kind).toBe("timeout");
  });

  test("a refused connection is a network error", async () => {
    const srv = fake(() => json({}));
    srv.server.stop(true);
    const client = createGitlabClient({
      baseUrl: srv.url,
      auth: { type: "private-token", token: TOKEN },
      maxRetries: 0,
    });
    const err = await caught(client.request("GET", "/user"));
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("error mapping", () => {
  const cases: [number, GitlabErrorKind][] = [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [400, "invalid"],
    [422, "invalid"],
    [405, "unexpected"],
  ];
  for (const [status, kind] of cases) {
    test(`${status} is ${kind}, not retried`, async () => {
      const { client, seen } = setup(() => json({ message: "reason here" }, { status }));
      const err = await caught(client.request("GET", "/projects/1"));
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
      expect(err.message).toContain(`${status}`);
      expect(err.message).toContain("/api/v4/projects/1");
      expect(err.message).toContain("reason here");
      expect(seen).toHaveLength(1);
    });
  }

  test("takes GitLab's reason from message, error or a field-error object; ignores HTML", async () => {
    const reason = async (body: string) =>
      (await caught(setup(() => new Response(body, { status: 400 })).client.request("POST", "/x")))
        .message;
    expect(await reason(JSON.stringify({ error: "invalid_token" }))).toContain("invalid_token");
    expect(await reason(JSON.stringify({ message: { key: ["is invalid"] } }))).toContain(
      "is invalid",
    );
    expect(await reason("<html>secret page</html>")).not.toContain("secret page");
  });

  test("a long reason is truncated", async () => {
    const { client } = setup(() => json({ message: "x".repeat(5000) }, { status: 400 }));
    expect((await caught(client.request("GET", "/x"))).message.length).toBeLessThan(400);
  });

  test("a redirect is not followed; the error names where it pointed, without its query", async () => {
    const elsewhere = fake(() => json({}));
    const { client } = setup(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `${elsewhere.url}/moved?token=abc` },
        }),
    );
    const err = await caught(client.request("GET", "/user"));
    expect(err.kind).toBe("unexpected");
    expect(err.message).toContain(`redirected to ${elsewhere.url}/moved`);
    expect(err.message).not.toContain("abc");
    expect(elsewhere.seen).toHaveLength(0);
  });
});

describe("the token never leaks", () => {
  test("not into any error, its stack or log line, even when GitLab echoes it back", async () => {
    const echo = (status: number) => () =>
      json(
        { message: `bad credentials ${TOKEN}`, error: TOKEN },
        { status, headers: { "retry-after": "1" } },
      );
    const out: string[] = [];
    for (const status of [401, 403, 404, 429, 500, 503]) {
      const { client, lines } = setup(echo(status), { maxRetries: 1 });
      const err = await caught(client.request("GET", "/user"));
      out.push(err.message, String(err.stack), JSON.stringify(err), ...lines);
    }
    const net = setup(() => json({}), { maxRetries: 1 });
    net.server.stop(true);
    out.push((await caught(net.client.request("GET", "/user"))).message, ...net.lines);
    expect(out.join("\n")).not.toContain(TOKEN);
    expect(out.join("\n")).toContain("[REDACTED]");
  });

  test("values named in `redact` are scrubbed from errors, short ones are left alone", async () => {
    const SECRET = "hunter2-VALUE-canary";
    const { client, lines } = setup(() =>
      json({ message: `invalid ${SECRET}, also ab` }, { status: 400 }),
    );
    const err = await caught(
      client.request("POST", "/x", { body: { v: SECRET }, redact: [SECRET, "ab"] }),
    );
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain("invalid [REDACTED], also ab");
    expect(lines.join("\n")).not.toContain(SECRET);

    const net = setup(() => json({}), { maxRetries: 0 });
    net.server.stop(true);
    const down = await caught(net.client.request("POST", "/x", { redact: [SECRET] }));
    expect(down.kind).toBe("network");
  });

  test("a secret is hidden whole even when it spans the truncation point, is JSON-escaped, or overlaps the fixed text", async () => {
    const CERT = `-----BEGIN-----\n${"A".repeat(190)}\n-----END-----`;
    const cut = setup(() => json({ message: `${"x".repeat(150)}${CERT}` }, { status: 400 }));
    const e1 = await caught(cut.client.request("POST", "/x", { redact: [CERT] }));
    expect(e1.message).not.toContain("AAAA");

    // An object reason is re-serialised, so the newline arrives as the two characters \n.
    const escaped = setup(() => json({ message: { base: [CERT] } }, { status: 400 }));
    const e2 = await caught(escaped.client.request("POST", "/x", { redact: [CERT] }));
    expect(e2.message).not.toContain("AAAA");
    expect(e2.message).toContain("[REDACTED]");

    // Secrets that look like the fixed text or the marker do not mangle either.
    const odd = setup(() => json({ message: "POST failed DACT true" }, { status: 400 }));
    const e3 = await caught(odd.client.request("POST", "/x", { redact: ["POST", "DACT", "true"] }));
    expect(e3.message).toBe(
      "GitLab POST /api/v4/x failed (400): [REDACTED] failed [REDACTED] [REDACTED]",
    );
  });

  test("a retry is logged without the token or the query string", async () => {
    const { client, lines } = setup((_req, n) =>
      n === 1 ? new Response("", { status: 503 }) : json({}),
    );
    await client.request("GET", "/projects", { query: { search: "private-name" } });
    const retry = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "gitlab request retry");
    expect(retry).toMatchObject({ method: "GET", status: 503, attempt: 1 });
    expect(lines.join("\n")).not.toContain("private-name");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
