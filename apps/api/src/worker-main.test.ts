import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTestDb } from "@orch/db/testing";

const script = fileURLToPath(new URL("./worker-main.ts", import.meta.url));
const t = await createTestDb();
afterAll(() => t.drop());

function start(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, script], {
    // `cwd` outside the repo keeps a developer's `.env` out of the child (Bun auto-loads it).
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    proc,
    out: new Response(proc.stdout).text(),
    err: new Response(proc.stderr).text(),
  };
}

describe("worker entrypoint", () => {
  test("starts, and exits 0 on SIGTERM without printing the connection string", async () => {
    const child = start({ DATABASE_URL: t.url });
    // The pipe is read once, after exit: give the process time to log "worker started" first.
    await Bun.sleep(500);
    child.proc.kill("SIGTERM");
    expect(await child.proc.exited).toBe(0);
    const out = await child.out;
    expect(out).toContain('"worker started"');
    expect(out).toContain('"shutting down"');
    expect(out).not.toContain(t.url);
  });

  test("serves the sync apply queue only with master keys, and never prints them", async () => {
    const keys = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
    const run = async (env: Record<string, string>) => {
      const child = start({ DATABASE_URL: t.url, ...env });
      await Bun.sleep(500);
      child.proc.kill("SIGTERM");
      await child.proc.exited;
      return await child.out;
    };
    const withKeys = await run({ ORCH_MASTER_KEYS: keys });
    expect(withKeys).toContain('"queues":["sync.apply"]');
    expect(withKeys).not.toContain(keys);
    const without = await run({});
    expect(without).toContain('"queues":[]');
    expect(without).toContain("ORCH_MASTER_KEYS is not set");
  });

  test("keys that do not parse stop the start", async () => {
    const child = start({ DATABASE_URL: t.url, ORCH_MASTER_KEYS: "not-a-key-list" });
    expect(await child.proc.exited).not.toBe(0);
    expect(await child.out).toContain("ORCH_MASTER_KEYS is invalid");
  });

  test("a missing DATABASE_URL exits non-zero naming the key", async () => {
    const child = start({});
    expect(await child.proc.exited).not.toBe(0);
    expect(await child.err).toContain("DATABASE_URL (missing)");
  });

  test("an out-of-range concurrency exits non-zero naming the key", async () => {
    const child = start({ DATABASE_URL: t.url, WORKER_CONCURRENCY: "0" });
    expect(await child.proc.exited).not.toBe(0);
    expect(await child.err).toContain("WORKER_CONCURRENCY");
  });
});
