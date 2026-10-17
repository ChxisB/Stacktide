import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { schedules } from "@orch/db";
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

  test("serves the sync apply and auto-sync queues only with master keys, and never prints them", async () => {
    const keys = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
    const run = async (env: Record<string, string>) => {
      const child = start({ DATABASE_URL: t.url, ...env });
      await Bun.sleep(500);
      child.proc.kill("SIGTERM");
      await child.proc.exited;
      return await child.out;
    };
    const withKeys = await run({ ORCH_MASTER_KEYS: keys });
    expect(withKeys).toContain(
      '"queues":["sync.apply","sync.auto","sync.drift.tick","sync.drift"]',
    );
    expect(withKeys).not.toContain(keys);
    const without = await run({});
    expect(without).toContain('"queues":[]');
    expect(without).toContain("ORCH_MASTER_KEYS is not set");
  });

  test("the drift schedule is stated with keys, off at 0, and a value in between is refused", async () => {
    const keys = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
    const run = async (extra: Record<string, string>) => {
      const child = start({ DATABASE_URL: t.url, ORCH_MASTER_KEYS: keys, ...extra });
      await Bun.sleep(500);
      child.proc.kill("SIGTERM");
      await child.proc.exited;
    };
    const drift = async () =>
      (await t.db.select().from(schedules)).find((s) => s.name === "sync.drift");
    await run({});
    expect(await drift()).toMatchObject({
      intervalSeconds: 900,
      queue: "sync.drift.tick",
      enabled: true,
    });
    await run({ DRIFT_CHECK_SECONDS: "120" });
    expect(await drift()).toMatchObject({ intervalSeconds: 120, enabled: true });
    await run({ DRIFT_CHECK_SECONDS: "0" });
    expect((await drift())?.enabled).toBe(false);

    const child = start({ DATABASE_URL: t.url, DRIFT_CHECK_SECONDS: "30" });
    expect(await child.proc.exited).not.toBe(0);
    expect(await child.err).toContain("DRIFT_CHECK_SECONDS");
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
