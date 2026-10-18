import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createApiToken, createSession, upsertUser } from "@orch/db";
import { createTestDb } from "@orch/db/testing";
import { hashToken, newApiToken, randomToken } from "./tokens";

const script = fileURLToPath(new URL("./index.ts", import.meta.url));
const t = await createTestDb();
afterAll(() => t.drop());

function start(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, script], {
    // `cwd` outside the repo keeps a developer's `.env` out of the child (Bun auto-loads it).
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  // The stream is read once, into `text`; the helpers below look at that buffer.
  let text = "";
  const decoder = new TextDecoder();
  const drained = (async () => {
    for await (const chunk of proc.stdout) text += decoder.decode(chunk, { stream: true });
  })();
  const err = new Response(proc.stderr).text();
  return {
    proc,
    err,
    /** Everything the child printed, once it has exited. */
    output: async () => {
      await drained;
      return text;
    },
    /** The request line is logged after the response is sent: wait for it before signalling. */
    logged: async (needle: string) => {
      for (let i = 0; i < 500 && !text.includes(needle); i++) await Bun.sleep(10);
    },
    /** The child prints one JSON line per event; wait for "listening" and return its port. */
    port: async () => {
      for (let i = 0; i < 1000; i++) {
        const line = text.split("\n").find((l) => l.includes('"listening"'));
        if (line) return JSON.parse(line).port as number;
        if (proc.exitCode !== null) break;
        await Bun.sleep(10);
      }
      throw new Error(`server did not start listening: ${text} ${await err}`);
    },
  };
}

describe("api entrypoint", () => {
  test("serves requests, logs them, and exits 0 on SIGTERM", async () => {
    const child = start({ DATABASE_URL: t.url });
    const port = await child.port();
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(`${base}/health`)).status).toBe(200);
    const ready = await fetch(`${base}/ready`, { headers: { "x-request-id": "probe-1" } });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });

    await child.logged('"probe-1"');
    child.proc.kill("SIGTERM");
    expect(await child.proc.exited).toBe(0);
    const out = await child.output();
    expect(out).toContain('"shutting down"');
    expect(out).toMatch(/"request_id":"probe-1".*"path":"\/ready".*"msg":"request"/);
    expect(out).not.toContain(t.url);
  });

  test("/ready turns into a 503 problem when the database disappears, /health stays up", async () => {
    const own = await createTestDb();
    const child = start({ DATABASE_URL: own.url });
    const base = `http://127.0.0.1:${await child.port()}`;
    expect((await fetch(`${base}/ready`)).status).toBe(200);

    await own.drop();
    const res = await fetch(`${base}/ready`);
    const body = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(body).code).toBe("not_ready");
    expect(body).not.toContain(own.name);
    expect((await fetch(`${base}/health`)).status).toBe(200);

    child.proc.kill("SIGTERM");
    await child.proc.exited;
  });

  test("callers are checked by default: no session, no access; the probes stay open", async () => {
    // Production is fine here: nothing runs as the dev principal.
    const child = start({ DATABASE_URL: t.url, NODE_ENV: "production" });
    const base = `http://127.0.0.1:${await child.port()}`;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const res = await fetch(`${base}/organizations`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("unauthenticated");
    expect(
      (await fetch(`${base}/organizations`, { headers: { cookie: "orch_session=x" } })).status,
    ).toBe(401);
    child.proc.kill("SIGTERM");
    await child.proc.exited;
  });

  test("an API token is a caller too, limited to its scopes", async () => {
    const user = await upsertUser(t.db, { gitlabId: 434343, username: "tk", name: "TK" });
    const fresh = newApiToken();
    await createApiToken(t.db, {
      userId: user.id,
      name: "t",
      prefix: fresh.prefix,
      tokenHash: fresh.tokenHash,
      scopes: ["organization.read"],
      ttlMs: 60_000,
    });
    const child = start({ DATABASE_URL: t.url, NODE_ENV: "production" });
    const base = `http://127.0.0.1:${await child.port()}`;
    const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
    expect((await fetch(`${base}/organizations`, as(fresh.token))).status).toBe(200);
    expect((await fetch(`${base}/organizations`, as(newApiToken().token))).status).toBe(401);
    // Listing tokens is for people: a token, whatever its scopes, is refused.
    expect((await fetch(`${base}/tokens`, as(fresh.token))).status).toBe(403);
    child.proc.kill("SIGTERM");
    await child.proc.exited;
  });

  test("ORCH_PLATFORM_ADMIN_GITLAB_IDS decides who may create an organization", async () => {
    const user = await upsertUser(t.db, { gitlabId: 424242, username: "pa", name: "PA" });
    const token = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(token), ttlMs: 60_000 });
    const create = async (extra: Record<string, string>) => {
      const child = start({ DATABASE_URL: t.url, NODE_ENV: "production", ...extra });
      const res = await fetch(`http://127.0.0.1:${await child.port()}/organizations`, {
        method: "POST",
        headers: { cookie: `orch_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ slug: `pa-${crypto.randomUUID().slice(0, 8)}`, name: "PA" }),
      });
      child.proc.kill("SIGTERM");
      await child.proc.exited;
      return res.status;
    };
    expect(await create({})).toBe(403);
    expect(await create({ ORCH_PLATFORM_ADMIN_GITLAB_IDS: "1, 424242" })).toBe(201);
  });

  test("ORCH_DEV_AUTH=1 turns authentication off, and says so", async () => {
    const child = start({ DATABASE_URL: t.url, ORCH_DEV_AUTH: "1" });
    const base = `http://127.0.0.1:${await child.port()}`;
    expect((await fetch(`${base}/organizations`)).status).toBe(200);
    child.proc.kill("SIGTERM");
    await child.proc.exited;
    expect(await child.output()).toContain("authentication is off");
  });

  test("refuses to start in production with authentication off", async () => {
    const child = start({ DATABASE_URL: t.url, NODE_ENV: "production", ORCH_DEV_AUTH: "1" });
    expect(await child.proc.exited).not.toBe(0);
    const out = await child.output();
    expect(out).toContain("refusing to start outside development");
    expect(out).not.toContain('"listening"');
  });

  test("refuses any environment that is not explicitly development or test", async () => {
    for (const NODE_ENV of ["Production", "staging", "prod"]) {
      const child = start({ DATABASE_URL: t.url, NODE_ENV, ORCH_DEV_AUTH: "1" });
      expect(await child.proc.exited).not.toBe(0);
      expect(await child.output()).not.toContain('"listening"');
    }
  });

  test("refuses to turn authentication off on a non-loopback address", async () => {
    const child = start({ DATABASE_URL: t.url, HOST: "0.0.0.0", ORCH_DEV_AUTH: "1" });
    expect(await child.proc.exited).not.toBe(0);
    const out = await child.output();
    expect(out).toContain("loopback");
    expect(out).not.toContain('"listening"');
  });

  test("a non-loopback address is fine while callers are checked", async () => {
    const child = start({ DATABASE_URL: t.url, HOST: "0.0.0.0" });
    const port = await child.port();
    expect((await fetch(`http://127.0.0.1:${port}/organizations`)).status).toBe(401);
    child.proc.kill("SIGTERM");
    await child.proc.exited;
  });

  test("refuses to start with master keys that do not parse, without echoing them", async () => {
    const bad = "k1:not-a-key-0123456789";
    const child = start({ DATABASE_URL: t.url, ORCH_MASTER_KEYS: bad });
    expect(await child.proc.exited).not.toBe(0);
    const out = await child.output();
    expect(out).toContain("ORCH_MASTER_KEYS is invalid");
    expect(out + (await child.err)).not.toContain(bad);
  });

  test("the headers are on every answer, and a browser origin is refused unless it is listed", async () => {
    const app = "https://app.example.com";
    const child = start({ DATABASE_URL: t.url, ORCH_CORS_ORIGINS: app });
    const base = `http://127.0.0.1:${await child.port()}`;
    const res = await fetch(`${base}/organizations`, { headers: { origin: app } });
    expect(res.status).toBe(401);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBe(app);
    const foreign = await fetch(`${base}/organizations`, {
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    child.proc.kill("SIGTERM");
    await child.proc.exited;
  });

  test("HSTS is sent when the sign-in is https, and only then", async () => {
    const gitlab = {
      GITLAB_URL: "https://gitlab.example.com",
      GITLAB_OAUTH_CLIENT_ID: "client-id",
      GITLAB_OAUTH_CLIENT_SECRET: "client-secret",
      GITLAB_MEMBERSHIP_TOKEN: "membership-token",
    };
    const hsts = async (redirect: string) => {
      const child = start({
        DATABASE_URL: t.url,
        ...gitlab,
        GITLAB_OAUTH_REDIRECT_URI: redirect,
      });
      const res = await fetch(`http://127.0.0.1:${await child.port()}/health`);
      child.proc.kill("SIGTERM");
      await child.proc.exited;
      return res.headers.get("strict-transport-security");
    };
    expect(await hsts("https://orch.example.com/auth/callback")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(await hsts("http://localhost:3000/auth/callback")).toBeNull();
  });

  test("a body over the cap is refused, declared or not, and one under it goes on", async () => {
    const child = start({ DATABASE_URL: t.url, ORCH_MAX_BODY_BYTES: String(1024 * 1024) });
    const base = `http://127.0.0.1:${await child.port()}`;
    const post = (body: string | ReadableStream, headers: Record<string, string> = {}) =>
      fetch(`${base}/organizations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    const big = "x".repeat(1024 * 1024 + 1);
    // the server's own limit is the same number and answers first, in plain text
    expect((await post(big)).status).toBe(413);
    // no content-length: a stream is stopped by the server itself
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const chunked = await post(stream);
    expect(chunked.status).toBe(413);
    // small enough: the route answers (401: nobody is signed in), not the cap
    expect((await post("{}")).status).toBe(401);
    child.proc.kill("SIGTERM");
    await child.proc.exited;
  });

  test("clients are told apart by the connection, not by what they claim in X-Forwarded-For", async () => {
    const child = start({ DATABASE_URL: t.url, ORCH_RATE_LIMIT_SCALE: "0.1" });
    const base = `http://127.0.0.1:${await child.port()}`;
    const login = (n: number) =>
      fetch(`${base}/auth/login`, {
        redirect: "manual",
        headers: { "x-forwarded-for": `1.1.1.${n}` },
      });
    const seen: number[] = [];
    for (let i = 1; i <= 5; i++) seen.push((await login(i)).status);
    // 3 allowed in 5 minutes at a tenth of 30; the claimed addresses all differ
    expect(seen.filter((s) => s === 429)).toHaveLength(2);
    expect(seen.slice(0, 3).every((s) => s !== 429)).toBe(true);
    const refused = await login(9);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    child.proc.kill("SIGTERM");
    await child.proc.exited;
  });

  test("refuses to start with settings of the edge that make no sense", async () => {
    const settings: Record<string, string>[] = [
      { ORCH_CORS_ORIGINS: "*" },
      { ORCH_CORS_ORIGINS: "https://app.example.com/" },
      { ORCH_MAX_BODY_BYTES: "10" },
      { ORCH_TRUSTED_PROXY_HOPS: "9" },
      { ORCH_RATE_LIMIT_SCALE: "0" },
    ];
    for (const bad of settings) {
      const child = start({ DATABASE_URL: t.url, ...bad });
      expect([bad, (await child.proc.exited) !== 0]).toEqual([bad, true]);
      expect(await child.output()).not.toContain('"listening"');
    }
  });

  test("a missing DATABASE_URL exits non-zero naming the key", async () => {
    const child = start({});
    expect(await child.proc.exited).not.toBe(0);
    expect(await child.err).toContain("DATABASE_URL (missing)");
  });
});
