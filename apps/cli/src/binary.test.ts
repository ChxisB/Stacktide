import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const dir = await mkdtemp(join(tmpdir(), "orch-bin-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

test("the compiled binary runs: --version prints the package's version and exits 0", async () => {
  const out = join(dir, "orch");
  const build =
    await Bun.$`bun build --compile ${join(import.meta.dir, "main.ts")} --outfile ${out}`
      .cwd(dir) // bun leaves a copy of itself in the working directory, so not the repository's
      .quiet()
      .nothrow();
  expect(build.exitCode).toBe(0);

  const version = await Bun.$`${out} --version`.quiet().nothrow();
  expect(version.exitCode).toBe(0);
  expect(version.stdout.toString()).toBe(`${pkg.version}\n`);

  const json = await Bun.$`${out} --json --version`.quiet().nothrow();
  expect(json.stdout.toString()).toBe(`${JSON.stringify({ version: pkg.version })}\n`);

  const bad = await Bun.$`${out} nope`.quiet().nothrow();
  expect(bad.exitCode).toBe(2);
  expect(bad.stderr.toString()).toBe("error: unknown command 'nope'; run 'orch --help'\n");
}, 120_000);
