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
