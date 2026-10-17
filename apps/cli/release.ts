import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** What `bun build --compile --target` calls a platform, and the name the binary is published under. */
export const TARGETS = [
  { bun: "bun-darwin-arm64", name: "orch-darwin-arm64" },
  { bun: "bun-darwin-x64", name: "orch-darwin-x64" },
  { bun: "bun-linux-arm64", name: "orch-linux-arm64" },
  { bun: "bun-linux-x64", name: "orch-linux-x64" },
] as const;

export type Target = { bun: string; name: string };
/** Builds `target` into the file `out`. */
export type Build = (target: Target, out: string) => Promise<void>;

const ENTRY = join(import.meta.dir, "src", "main.ts");
export const SUMS = "SHA256SUMS";

export const sha256 = async (path: string) =>
  new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");

const compile: Build = async (target, out) => {
  // bun leaves a copy of itself in the working directory, so not the repository's
  const scratch = await mkdtemp(join(tmpdir(), "orch-release-"));
  try {
    const built =
      await Bun.$`bun build --compile --target=${target.bun} ${ENTRY} --outfile ${resolve(out)}`
        .cwd(scratch)
        .quiet()
        .nothrow();
    if (built.exitCode !== 0) {
      throw new Error(`building ${target.name} failed:\n${built.stderr.toString().trim()}`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

/**
 * Builds every target into `dir` and writes `SHA256SUMS` beside them, in the `sha256sum` format
 * (`<hash>  <name>`), written last: a failed build leaves no list, so a half release is never one.
 * Files in `dir` that are not part of a release are left alone.
 */
export async function release(dir: string, targets: readonly Target[] = TARGETS, build = compile) {
  await mkdir(dir, { recursive: true });
  // only what a release is made of goes, so a mistyped `dir` loses nothing else, and an earlier list never outlives a failed build
  const sorted = [...targets].sort((a, b) => a.name.localeCompare(b.name));
  for (const name of [SUMS, ...sorted.map((t) => t.name)])
    await rm(join(dir, name), { force: true });
  const lines: string[] = [];
  for (const target of sorted) {
    const out = join(dir, target.name);
    await build(target, out);
    lines.push(`${await sha256(out)}  ${target.name}\n`);
  }
  await writeFile(join(dir, SUMS), lines.join(""));
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(process.cwd(), "dist", "release");
  await release(dir);
  console.log(`built ${TARGETS.length} binaries and ${SUMS} in ${dir}`);
}
