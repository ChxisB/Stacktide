import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "./testing";

const script = fileURLToPath(new URL("./migrate.ts", import.meta.url));

async function run(env: Record<string, string>) {
  const p = Bun.spawn([process.execPath, script], {
    env: { PATH: process.env.PATH ?? "", ...env },
    // Bun auto-loads `.env` from the cwd; a neutral cwd keeps a developer's file out of the test.
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code, out, err };
}

describe("db:migrate entrypoint", () => {
  let t: TestDb | undefined;
  afterAll(async () => {
    await t?.drop();
  });

  test("applies migrations to DATABASE_URL and exits 0", async () => {
    t = await createTestDb();
    const r = await run({ DATABASE_URL: t.url });
    expect(r.code).toBe(0);
    expect(r.out).toContain("migrations applied");
  });

  test("without DATABASE_URL it exits non-zero naming the key", async () => {
    const r = await run({});
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("DATABASE_URL (missing)");
  });
});
