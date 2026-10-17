import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { release, SUMS, sha256, TARGETS, type Target } from "./release";

const INSTALL = join(import.meta.dir, "install.sh");
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "orch-release-test-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

let n = 0;
const fresh = async (name: string) => {
  const dir = join(root, `${name}${++n}`);
  await mkdir(dir, { recursive: true });
  return dir;
};

/** Stands in for the compiler: the file says which target it is for. */
const fake = async (target: Target, out: string) => {
  await writeFile(out, `#!/bin/sh\necho ${target.bun}\n`);
};

describe("release", () => {
  test("builds the four platforms and lists each with the hash `shasum` agrees with", async () => {
    const dir = await fresh("out");
    await release(dir, [...TARGETS].reverse(), fake);
    expect((await readdir(dir)).sort()).toEqual(
      [
        "SHA256SUMS",
        "orch-darwin-arm64",
        "orch-darwin-x64",
        "orch-linux-arm64",
        "orch-linux-x64",
      ].sort(),
    );
    const sums = await readFile(join(dir, SUMS), "utf8");
    expect(sums.split("\n").slice(0, -1)).toEqual(
      await Promise.all(
        ["orch-darwin-arm64", "orch-darwin-x64", "orch-linux-arm64", "orch-linux-x64"].map(
          async (name) => `${await sha256(join(dir, name))}  ${name}`,
        ),
      ),
    );
    // an independent implementation reads the list the same way
    const check = await Bun.$`shasum -a 256 -c ${SUMS}`.cwd(dir).quiet().nothrow();
    expect(check.exitCode).toBe(0);
  });

  test("a target that fails to build leaves no list, and the error names it", async () => {
    const dir = await fresh("broken");
    const failing: typeof fake = async (target, out) => {
      if (target.name === "orch-linux-x64") throw new Error(`building ${target.name} failed`);
      await fake(target, out);
    };
    await expect(release(dir, TARGETS, failing)).rejects.toThrow("building orch-linux-x64 failed");
    expect(await readdir(dir)).not.toContain(SUMS);
  });

  test("a compiler that fails stops the release with its message and no list", async () => {
    const dir = await fresh("nocompile");
    await expect(release(dir, [{ bun: "bun-no-such-target", name: "orch-x" }])).rejects.toThrow(
      /^building orch-x failed:/,
    );
    expect(await readdir(dir)).not.toContain(SUMS);
  });

  test("an earlier release's list does not outlive a failed build, and other files stay", async () => {
    const dir = await fresh("again");
    await release(dir, TARGETS, fake);
    await writeFile(join(dir, "notes.txt"), "mine");
    const failing: typeof fake = async () => {
      throw new Error("no compiler");
    };
    await expect(release(dir, TARGETS, failing)).rejects.toThrow("no compiler");
    expect((await readdir(dir)).sort()).toEqual(["notes.txt"]);
    expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("mine");
  });

  const host = TARGETS.find((t) => t.name === `orch-${process.platform}-${process.arch}`);
  test.skipIf(!host)(
    "the compiler builds a binary that runs (this machine's own target)",
    async () => {
      if (!host) return;
      // a relative directory, as `bun apps/cli/release.ts dist/out` gives, taken from where the shell is
      const dir = join(root, "real");
      const before = process.cwd();
      process.chdir(root);
      try {
        await release("real", [host]);
      } finally {
        process.chdir(before);
      }
      const run = await Bun.$`${join(dir, host.name)} --version`.quiet().nothrow();
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString()).toMatch(/^\d+\.\d+\.\d+\n$/);
      expect(await readFile(join(dir, SUMS), "utf8")).toBe(
        `${await sha256(join(dir, host.name))}  ${host.name}\n`,
      );
    },
    120_000,
  );
});

const platform = { darwin: "darwin", linux: "linux" }[process.platform as string] ?? "other";
const processor = process.arch === "arm64" ? "arm64" : "x64";
const NAME = `orch-${platform}-${processor}`;
const GOOD = `#!/bin/sh\necho orch-fake\n`;
const hex = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** A release served over http from memory; `requests` is every path asked for. */
function serve(files: Record<string, string | undefined>, redirects: Record<string, string> = {}) {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const to = redirects[path.replace(/^\/rel\//, "")];
      if (to) return new Response(null, { status: 302, headers: { location: to } });
      const body = files[path.replace(/^\/rel\//, "")];
      return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/rel`, requests, stop: () => server.stop(true) };
}

async function install(
  release: Record<string, string | undefined>,
  over: {
    env?: Record<string, string | undefined>;
    path?: string;
    dir?: string;
    redirects?: Record<string, string>;
  } = {},
) {
  const server = serve(release, over.redirects);
  const dir = over.dir ?? `${await fresh("bin")}/bin`;
  const scratch = await fresh("tmp");
  try {
    const env: Record<string, string | undefined> = {
      PATH: over.path ?? process.env.PATH ?? "",
      HOME: await fresh("home"),
      TMPDIR: scratch,
      ORCH_RELEASE_URL: server.url,
      ORCH_ALLOW_HTTP: "1",
      ORCH_INSTALL_DIR: dir,
      ...over.env,
    };
    const proc = Bun.spawn(["sh", INSTALL], {
      // undefined takes the variable away
      env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<
        string,
        string
      >,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err, dir, requests: server.requests, leftovers: await readdir(scratch) };
  } finally {
    server.stop();
  }
}
const installed = (dir: string) => readdir(dir).catch(() => [] as string[]);

describe("install.sh", () => {
  test("installs a binary that matches SHA256SUMS, executable, and leaves nothing behind", async () => {
    const res = await install({ [NAME]: GOOD, SHA256SUMS: `${hex(GOOD)}  ${NAME}\n` });
    expect(res.err).toBe(`note: ${res.dir} is not on your PATH\n`);
    expect(res.code).toBe(0);
    expect(res.out).toBe(`installed orch to ${res.dir}/orch\n`);
    expect(await installed(res.dir)).toEqual(["orch"]);
    expect(await readFile(join(res.dir, "orch"), "utf8")).toBe(GOOD);
    expect((await stat(join(res.dir, "orch"))).mode & 0o111).not.toBe(0);
    expect(res.leftovers).toEqual([]);
    expect((await Bun.$`${join(res.dir, "orch")}`.quiet().text()).trim()).toBe("orch-fake");
  });

  test("refuses a tampered binary: exit 1, nothing installed, an earlier install untouched", async () => {
    const dir = `${await fresh("bin")}/bin`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "orch"), "the one already there");
    await chmod(join(dir, "orch"), 0o755);

    const res = await install(
      { [NAME]: `${GOOD}# swapped\n`, SHA256SUMS: `${hex(GOOD)}  ${NAME}\n` },
      { dir },
    );
    expect(res.code).toBe(1);
    expect(res.err).toContain(`install: checksum mismatch for ${NAME}`);
    expect(res.out).toBe("");
    expect(await installed(dir)).toEqual(["orch"]);
    expect(await readFile(join(dir, "orch"), "utf8")).toBe("the one already there");
    expect(res.leftovers).toEqual([]);
  });

  test("a fresh machine with a tampered binary gets no directory contents at all", async () => {
    const res = await install({ [NAME]: "tampered", SHA256SUMS: `${hex(GOOD)}  ${NAME}\n` });
    expect(res.code).toBe(1);
    expect(await installed(res.dir)).toEqual([]);
  });

  test("replaces an earlier install with the new, checked one", async () => {
    const dir = `${await fresh("bin")}/bin`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "orch"), "old");
    const res = await install({ [NAME]: GOOD, SHA256SUMS: `${hex(GOOD)}  ${NAME}\n` }, { dir });
    expect(res.code).toBe(0);
    expect(await readFile(join(dir, "orch"), "utf8")).toBe(GOOD);
  });

  test.each([
    ["no entry for this platform", () => `${hex(GOOD)}  orch-plan9-x64\n`, "has no entry for"],
    [
      "an entry that only starts with the name",
      () => `${hex(GOOD)}  ${NAME}.sig\n`,
      "has no entry for",
    ],
    ["a hash that is not a hash", () => `${"z".repeat(64)}  ${NAME}\n`, "malformed"],
    ["a hash of the wrong length", () => `${hex(GOOD).slice(1)}  ${NAME}\n`, "malformed"],
    [
      "two entries for the file, even if one is right",
      () => `${hex(GOOD)}  ${NAME}\n${hex(GOOD)}  ${NAME}\n`,
      "malformed or repeated",
    ],
    ["an empty list", () => "", "has no entry for"],
  ])("a list with %s is refused and installs nothing", async (_what, sums, message) => {
    const res = await install({ [NAME]: GOOD, SHA256SUMS: sums() });
    expect(res.code).toBe(1);
    expect(res.err).toContain(message);
    expect(await installed(res.dir)).toEqual([]);
    expect(res.leftovers).toEqual([]);
  });

  test("a missing list or binary is a download error and installs nothing", async () => {
    const noList = await install({ [NAME]: GOOD });
    expect(noList.code).toBe(1);
    expect(noList.err).toContain("could not download");
    const noBinary = await install({ SHA256SUMS: `${hex(GOOD)}  ${NAME}\n` });
    expect(noBinary.code).toBe(1);
    expect(noBinary.err).toContain(`could not download`);
    expect(await installed(noBinary.dir)).toEqual([]);
  });

  test("insists on https unless told it is a test, and on being told where the release is", async () => {
    const files = { [NAME]: GOOD, SHA256SUMS: `${hex(GOOD)}  ${NAME}\n` };
    const plain = await install(files, { env: { ORCH_ALLOW_HTTP: undefined } });
    expect(plain.code).toBe(1);
    expect(plain.err).toBe("install: ORCH_RELEASE_URL must be an https URL\n");
    expect(plain.requests).toEqual([]);

    const ftp = await install(files, { env: { ORCH_RELEASE_URL: "ftp://example.com/rel" } });
    expect(ftp.err).toBe("install: ORCH_RELEASE_URL must be an https URL\n");

    const unset = await install(files, { env: { ORCH_RELEASE_URL: "" } });
    expect(unset.code).toBe(1);
    expect(unset.err).toBe("install: set ORCH_RELEASE_URL to the release's download URL\n");
  });

  test("does not follow a redirect to plain http, even when http is allowed", async () => {
    const res = await install(
      { [NAME]: GOOD, SHA256SUMS: `${hex(GOOD)}  ${NAME}\n`, elsewhere: GOOD },
      { redirects: { [NAME]: "/rel/elsewhere" } },
    );
    expect(res.code).toBe(1);
    expect(res.err).toContain("could not download");
    expect(await installed(res.dir)).toEqual([]);
  });

  test.each(["sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])])(
    "a signal during the download leaves nothing behind (%s)",
    async (shell) => {
      let asked!: () => void;
      const sawRequest = new Promise<void>((resolve) => {
        asked = resolve;
      });
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch() {
          asked();
          await Bun.sleep(500);
          return new Response("slow");
        },
      });
      const scratch = await fresh("tmp");
      const dir = `${await fresh("bin")}/bin`;
      const proc = Bun.spawn([shell, INSTALL], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: scratch,
          TMPDIR: scratch,
          ORCH_RELEASE_URL: `http://127.0.0.1:${server.port}/rel`,
          ORCH_ALLOW_HTTP: "1",
          ORCH_INSTALL_DIR: dir,
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await sawRequest;
        proc.kill("SIGTERM");
        expect(await proc.exited).not.toBe(0);
        expect(await readdir(scratch)).toEqual([]);
        expect(await installed(dir)).toEqual([]);
      } finally {
        server.stop(true);
      }
    },
  );

  test("another system or processor is refused, by name", async () => {
    const bin = await fresh("fakebin");
    const uname = async (system: string, machine: string) => {
      await writeFile(
        join(bin, "uname"),
        `#!/bin/sh\ncase "$1" in -s) echo ${system};; -m) echo ${machine};; esac\n`,
      );
      await chmod(join(bin, "uname"), 0o755);
      return install(
        { [NAME]: GOOD, SHA256SUMS: `${hex(GOOD)}  ${NAME}\n` },
        { path: `${bin}:${process.env.PATH}` },
      );
    };
    const system = await uname("FreeBSD", "x86_64");
    expect([system.code, system.err]).toEqual([1, "install: unsupported system: FreeBSD\n"]);
    const cpu = await uname("Linux", "riscv64");
    expect([cpu.code, cpu.err]).toEqual([1, "install: unsupported processor: riscv64\n"]);
    // the names `uname` gives for the supported ones
    for (const [machine, arch] of [
      ["aarch64", "arm64"],
      ["amd64", "x64"],
    ] as const) {
      const name = `orch-linux-${arch}`;
      await uname("Linux", machine);
      const res = await install(
        { [name]: GOOD, SHA256SUMS: `${hex(GOOD)}  ${name}\n` },
        { path: `${bin}:${process.env.PATH}` },
      );
      expect(res.code).toBe(0);
    }
  });

  test("stays quiet about the PATH when the directory is on it", async () => {
    const dir = `${await fresh("bin")}/bin`;
    const res = await install(
      { [NAME]: GOOD, SHA256SUMS: `${hex(GOOD)}  ${NAME}\n` },
      { dir, path: `${dir}:${process.env.PATH}` },
    );
    expect([res.code, res.err]).toEqual([0, ""]);
  });
});
