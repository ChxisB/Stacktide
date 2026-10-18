import { afterAll, beforeAll, expect, test } from "bun:test";
import { startWeb } from "./server";

const seen: {
  method: string;
  path: string;
  host: string | null;
  cookie: string | null;
  body: string;
}[] = [];
const stolen: string[] = [];
const forwarded: (string | null)[] = [];
const hung = { started: false, aborted: false };
let upstream: ReturnType<typeof Bun.serve>;
let elsewhere: ReturnType<typeof Bun.serve>;
let web: ReturnType<typeof startWeb>;
let origin: string;

beforeAll(() => {
  elsewhere = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      stolen.push(`${req.method} ${req.url} ${req.headers.get("cookie")}`);
      return new Response("not for you");
    },
  });
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      forwarded.push(req.headers.get("x-forwarded-for"));
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        host: req.headers.get("host"),
        cookie: req.headers.get("cookie"),
        body: await req.text(),
      });
      if (url.pathname === "/auth/login") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://gitlab.example.com/oauth",
            "set-cookie": "orch_login=1; Path=/auth",
          },
        });
      }
      if (url.pathname === "/hang") {
        hung.started = true;
        req.signal.addEventListener("abort", () => {
          hung.aborted = true;
        });
        return new Promise<Response>(() => {});
      }
      if (url.pathname === "/zipped") {
        return new Response(Bun.gzipSync("zipped body"), {
          headers: { "content-encoding": "gzip", "content-type": "text/plain" },
        });
      }
      return Response.json({ ok: true }, { status: url.pathname === "/missing" ? 404 : 200 });
    },
  });
  web = startWeb({ api: `http://127.0.0.1:${upstream.port}` });
  origin = `http://127.0.0.1:${web.port}`;
});
afterAll(async () => {
  await web.stop(true);
  await upstream.stop(true);
  await elsewhere.stop(true);
});

test("/ is the app: a page whose script and styles the server also serves", async () => {
  const res = await fetch(`${origin}/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('<div id="root">');
  // development mode (hot reload, a socket back to the server) is opt-in
  expect(html).not.toContain("/_bun/");
  const script = html.match(/<script[^>]*src="([^"]+)"/)?.[1];
  const style = html.match(/<link[^>]*href="([^"]+\.css)"/)?.[1];
  expect(script).toBeTruthy();
  expect(style).toBeTruthy();
  const js = await fetch(new URL(script ?? "", origin));
  expect(js.status).toBe(200);
  expect(await js.text()).toContain("Sign in with GitLab");
  expect((await fetch(new URL(style ?? "", origin))).status).toBe(200);
});

test("everything else goes to the API with its method, path, cookie and body", async () => {
  seen.length = 0;
  const res = await fetch(`${origin}/organizations/abc?limit=5`, {
    method: "POST",
    headers: { cookie: "orch_session=s3cret", "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme" }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(seen).toEqual([
    {
      method: "POST",
      path: "/organizations/abc?limit=5",
      host: `127.0.0.1:${upstream.port}`,
      cookie: "orch_session=s3cret",
      body: '{"name":"Acme"}',
    },
  ]);
});

test("the API is told who called: the caller's address is appended to what the caller claimed", async () => {
  forwarded.length = 0;
  await fetch(`${origin}/organizations`);
  await fetch(`${origin}/organizations`, { headers: { "x-forwarded-for": "6.6.6.6" } });
  // the test client is 127.0.0.1 (or ::1): only the last entry is the proxy's own word
  expect(forwarded[0]).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
  expect(forwarded[1]).toMatch(/^6\.6\.6\.6, (127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
});

test("a redirect and its cookie pass through for the browser to follow, and an error keeps its status", async () => {
  const login = await fetch(`${origin}/auth/login?return_to=/`, { redirect: "manual" });
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe("https://gitlab.example.com/oauth");
  expect(login.headers.get("set-cookie")).toContain("orch_login=1");
  expect((await fetch(`${origin}/missing`)).status).toBe(404);
});

test("an API that is down is a 502, not a hang or a crash", async () => {
  const lonely = startWeb({ api: "http://127.0.0.1:1" });
  try {
    const res = await fetch(`http://127.0.0.1:${lonely.port}/auth/me`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("The API cannot be reached.");
  } finally {
    await lonely.stop(true);
  }
});

test("a body the API compressed arrives readable", async () => {
  const res = await fetch(`${origin}/zipped`);
  expect(await res.text()).toBe("zipped body");
  expect(res.headers.get("content-encoding")).toBeNull();
});

test("a path cannot send the request, and the session cookie with it, to another host", async () => {
  seen.length = 0;
  stolen.length = 0;
  for (const path of [
    `//127.0.0.1:${elsewhere.port}/x`,
    `///127.0.0.1:${elsewhere.port}/x`,
    `/\\127.0.0.1:${elsewhere.port}/x`,
  ]) {
    // a raw request line: fetch() would normalise the path
    const closed = Promise.withResolvers<void>();
    await Bun.connect({
      hostname: "127.0.0.1",
      port: Number(web.port),
      socket: {
        data() {},
        close: () => closed.resolve(),
        open(s) {
          s.write(
            `GET ${path} HTTP/1.1\r\nHost: x\r\nCookie: orch_session=s3cret\r\nConnection: close\r\n\r\n`,
          );
        },
      },
    });
    await closed.promise;
  }
  expect(stolen).toEqual([]);
  expect(seen.length).toBeGreaterThan(0);
  for (const s of seen) expect(s.host).toBe(`127.0.0.1:${upstream.port}`);
});

test("a browser that gives up cancels the request to the API", async () => {
  const stop = new AbortController();
  const pending = fetch(`${origin}/hang`, { signal: stop.signal }).catch(() => "aborted");
  for (let i = 0; i < 100 && !hung.started; i++) await Bun.sleep(20);
  expect(hung.started).toBe(true);
  stop.abort();
  expect(await pending).toBe("aborted");
  for (let i = 0; i < 100 && !hung.aborted; i++) await Bun.sleep(20);
  expect(hung.aborted).toBe(true);
});

test("a WEB_PORT that is not a port stops the server from starting", async () => {
  for (const port of ["abc", "0", "70000", "1.5"]) {
    const child = Bun.spawn(["bun", "src/server.ts"], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, WEB_PORT: port },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect([port, await child.exited]).toEqual([port, 1]);
    expect(await new Response(child.stderr).text()).toContain("WEB_PORT must be a port number");
  }
});
