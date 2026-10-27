import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CLD-5/6/7/8: runs a deploy script (or a template's script block) the way a runner would: one `sh`, a PATH that
// holds only stubs and the few tools the script uses, a home and a temp directory of its own, a repository directory.

const made: string[] = [];
export const cleanUp = async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
};

/** A stub that logs its command line and fails when `STUB_FAIL` (comma separated) names `tool:first` or `tool:first second`. */
export const stub = (name: string, body = "") => `#!/bin/sh
echo "${name} $*" >> "$LOG"
case ",\${STUB_FAIL:-}," in *",${name}:$1,"*|*",${name}:$1 $2,"*) echo "stub ${name} failed" >&2; exit 1 ;; esac
${body}
`;

const REAL = ["mktemp", "rm", "grep", "sed", "cat"];

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  dir: string;
  /** every stub call, in order, as `tool args` */
  log: string[];
  /** what the stubs wrote to `out/`, by file name */
  out: Record<string, string>;
  /** file names left under the home, the repository and the temp directory */
  left: { home: string[]; repo: string[]; tmp: string[] };
}

const names = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true })).map(String).sort();

export async function runScript(
  script: string,
  options: {
    env: Record<string, string>;
    stubs: Record<string, string>;
    repo?: Record<string, string>;
  },
): Promise<Ran> {
  const dir = await mkdtemp(join(tmpdir(), "orch-deploy-script-"));
  made.push(dir);
  const [bin, home, repo, tmp, out] = ["bin", "home", "repo", "tmp", "out"].map((d) =>
    join(dir, d),
  ) as [string, string, string, string, string];
  for (const d of [bin, home, repo, tmp, out]) await mkdir(d);
  for (const tool of REAL) await symlink(Bun.which(tool) ?? `/usr/bin/${tool}`, join(bin, tool));
  for (const [name, text] of Object.entries(options.stubs)) {
    await writeFile(join(bin, name), text);
    await chmod(join(bin, name), 0o755);
  }
  for (const [name, text] of Object.entries(options.repo ?? { Dockerfile: "FROM scratch\n" }))
    await writeFile(join(repo, name), text);
  await writeFile(join(dir, "job.sh"), script);
  const log = join(dir, "log");
  const p = Bun.spawn(["/bin/sh", join(dir, "job.sh")], {
    cwd: repo,
    env: { PATH: bin, HOME: home, TMPDIR: tmp, LOG: log, OUT: out, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const lines = await readFile(log, "utf8").then(
    (t) => t.split("\n").filter(Boolean),
    () => [] as string[],
  );
  const outFiles: Record<string, string> = {};
  for (const f of await names(out)) outFiles[f] = await readFile(join(out, f), "utf8");
  return {
    code,
    stdout,
    stderr,
    dir,
    log: lines,
    out: outFiles,
    left: { home: await names(home), repo: await names(repo), tmp: await names(tmp) },
  };
}
