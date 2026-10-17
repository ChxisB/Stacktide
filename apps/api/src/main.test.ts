import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTestDb } from "@orch/db/testing";

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

  test("refuses to start in production while only the dev principal exists", async () => {
    const child = start({ DATABASE_URL: t.url, NODE_ENV: "production" });
    expect(await child.proc.exited).not.toBe(0);
    const out = await child.output();
    expect(out).toContain("refusing to start outside development");
    expect(out).not.toContain('"listening"');
  });

  test("refuses any environment that is not explicitly development or test", async () => {
    for (const NODE_ENV of ["Production", "staging", "prod"]) {
      const child = start({ DATABASE_URL: t.url, NODE_ENV });
      expect(await child.proc.exited).not.toBe(0);
      expect(await child.output()).not.toContain('"listening"');
    }
  });

  test("refuses to expose the dev principal on a non-loopback address", async () => {
    const child = start({ DATABASE_URL: t.url, HOST: "0.0.0.0" });
    expect(await child.proc.exited).not.toBe(0);
    const out = await child.output();
    expect(out).toContain("loopback");
    expect(out).not.toContain('"listening"');
  });

  test("a missing DATABASE_URL exits non-zero naming the key", async () => {
    const child = start({});
    expect(await child.proc.exited).not.toBe(0);
    expect(await child.err).toContain("DATABASE_URL (missing)");
  });
});
