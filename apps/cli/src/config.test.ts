import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./cli";
import { configPath, loadConfig, saveConfig } from "./config";

const dirs: string[] = [];
const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-config-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const TOKEN = "orch-secret-token-0123456789";
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const message = (e: unknown) => (e instanceof Error ? e.message : "");

describe("where the config lives", () => {
  test("$ORCH_CONFIG, else $XDG_CONFIG_HOME, else ~/.config", () => {
    expect(configPath({ ORCH_CONFIG: "/x/c.json", XDG_CONFIG_HOME: "/y" }, "/home/u")).toBe(
      "/x/c.json",
    );
    expect(configPath({ XDG_CONFIG_HOME: "/y" }, "/home/u")).toBe("/y/orch/config.json");
    expect(configPath({}, "/home/u")).toBe("/home/u/.config/orch/config.json");
    expect(configPath({ XDG_CONFIG_HOME: "" }, "/home/u")).toBe("/home/u/.config/orch/config.json");
  });
});

describe("the config file", () => {
  test("a missing file is an empty config", async () => {
    expect(await loadConfig(join(await fresh(), "none.json"))).toEqual({});
  });

  test("saves with mode 0600 in a 0700 directory and reads back", async () => {
    const path = join(await fresh(), "nested", "orch", "config.json");
    await saveConfig(path, { apiUrl: "https://orch.example.com", token: TOKEN });
    expect(await mode(path)).toBe(0o600);
    expect(await mode(join(path, ".."))).toBe(0o700);
    expect(await loadConfig(path)).toEqual({ apiUrl: "https://orch.example.com", token: TOKEN });
  });

  test("saving over a file with wider permissions leaves 0600, and no temporary file", async () => {
    const dir = await fresh();
    const path = join(dir, "config.json");
    await writeFile(path, "{}", { mode: 0o644 });
    await chmod(path, 0o644);
    await saveConfig(path, { token: TOKEN });
    expect(await mode(path)).toBe(0o600);
    expect((await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir }))).sort()).toEqual([
      "config.json",
    ]);
  });

  test("a temporary file left by an earlier run, with wide permissions, does not make the saved file wide", async () => {
    const path = join(await fresh(), "config.json");
    const stale = `${path}.${process.pid}.tmp`;
    await writeFile(stale, "old");
    await chmod(stale, 0o666);
    await saveConfig(path, { token: TOKEN });
    expect(await mode(path)).toBe(0o600);
  });

  test("a temporary file of that name that is a link is not written through", async () => {
    const dir = await fresh();
    const path = join(dir, "config.json");
    const victim = join(dir, "victim");
    await writeFile(victim, "untouched");
    await symlink(victim, `${path}.${process.pid}.tmp`);
    await saveConfig(path, { token: TOKEN });
    expect(await readFile(victim, "utf8")).toBe("untouched");
    expect(await loadConfig(path)).toEqual({ token: TOKEN });
  });

  test("a failed save leaves no temporary file with the token in it", async () => {
    const dir = await fresh();
    const path = join(dir, "config.json");
    await mkdir(path); // a directory in the way: the rename fails
    await expect(saveConfig(path, { token: TOKEN })).rejects.toThrow();
    expect(
      (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir, onlyFiles: false }))).sort(),
    ).toEqual(["config.json"]);
  });

  test("a file that another user owns is refused, even at 0600", async () => {
    const path = join(await fresh(), "config.json");
    await writeFile(path, JSON.stringify({ token: TOKEN }), { mode: 0o600 });
    const me = process.getuid?.() ?? 0;
    expect(await loadConfig(path, me)).toEqual({ token: TOKEN });
    const error = await loadConfig(path, me + 1).catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(message(error)).toBe(`${path} belongs to another user`);
  });

  test("a file that group or others can read or write is refused, naming the fix and not the token", async () => {
    const path = join(await fresh(), "config.json");
    for (const wide of [0o640, 0o604, 0o660, 0o644, 0o666, 0o602]) {
      await writeFile(path, JSON.stringify({ token: TOKEN }));
      await chmod(path, wide);
      const error = await loadConfig(path).then(
        () => null,
        (e) => e,
      );
      expect(error).toBeInstanceOf(CliError);
      expect(message(error)).toContain(`chmod 600 ${path}`);
      expect(message(error)).not.toContain(TOKEN);
    }
  });

  test("0600 and stricter are accepted", async () => {
    const path = join(await fresh(), "config.json");
    for (const ok of [0o600, 0o400]) {
      await writeFile(path, JSON.stringify({ token: TOKEN }));
      await chmod(path, ok);
      expect(await loadConfig(path)).toEqual({ token: TOKEN });
    }
  });

  test("a file that is not JSON or not the right shape is refused without printing what is in it", async () => {
    const dir = await fresh();
    const path = join(dir, "config.json");
    const refuse = async (content: string) => {
      await writeFile(path, content, { mode: 0o600 });
      return message(await loadConfig(path).catch((e) => e));
    };
    expect(await refuse(`{"token": "${TOKEN}"`)).toBe(`${path} is not valid JSON`);
    expect(await refuse(`{"token": 5}`)).toBe(`${path} is not valid: token`);
    expect(await refuse(`{"token": ""}`)).toBe(`${path} is not valid: token`);
    expect(await refuse(`{"apiUrl": "not a url"}`)).toBe(`${path} is not valid: apiUrl`);
    expect(await refuse(`{"token": "${TOKEN}", "password": "${TOKEN}", "x": 1}`)).toBe(
      `${path} is not valid: password, x`,
    );
    expect(await refuse(`[]`)).toBe(`${path} is not valid: (file)`);
  });

  test("a path that cannot be read is an error, not an empty config", async () => {
    const dir = await fresh();
    await mkdir(join(dir, "d"));
    // a directory has no JSON in it; mode 0700 passes the permission check, so the read must fail
    expect(await loadConfig(join(dir, "d")).catch((e) => e)).toBeInstanceOf(CliError);
  });

  test("an error other than a missing file is an error, not an empty config", async () => {
    const dir = await fresh();
    await writeFile(join(dir, "file"), "x");
    // a path below a regular file: stat fails with ENOTDIR
    expect(message(await loadConfig(join(dir, "file", "config.json")).catch((e) => e))).toBe(
      `cannot read ${join(dir, "file", "config.json")}`,
    );
  });

  test("refuses to save a config that is not valid", async () => {
    const path = join(await fresh(), "config.json");
    await expect(saveConfig(path, { token: "" })).rejects.toThrow();
    await expect(saveConfig(path, { apiUrl: "nope" })).rejects.toThrow();
    expect(await readFile(path, "utf8").catch(() => null)).toBeNull();
  });
});
