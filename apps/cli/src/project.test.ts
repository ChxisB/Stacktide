import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./cli";
import { findProjectFile, PROJECT_FILE } from "./project";

const dirs: string[] = [];
const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-project-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const put = (dir: string, content: unknown) =>
  writeFile(
    join(dir, PROJECT_FILE),
    typeof content === "string" ? content : JSON.stringify(content),
  );
const message = (e: unknown) => (e instanceof Error ? e.message : "");

describe(".orch.json discovery", () => {
  test("finds the file in the directory itself and in a parent", async () => {
    const root = await fresh();
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "a", "b"), { recursive: true });
    await put(root, { organization: "acme", project: "web", environment: "staging" });
    const want = {
      path: join(root, PROJECT_FILE),
      config: { organization: "acme", project: "web", environment: "staging" },
    };
    expect(await findProjectFile(root)).toEqual(want);
    expect(await findProjectFile(join(root, "a", "b"))).toEqual(want);
  });

  test("the nearest file wins", async () => {
    const root = await fresh();
    await mkdir(join(root, "sub"));
    await put(root, { project: "outer" });
    await put(join(root, "sub"), { project: "inner" });
    expect((await findProjectFile(join(root, "sub")))?.config).toEqual({ project: "inner" });
  });

  test("the search ends at the git repository's root: a file above it is not picked up", async () => {
    const outer = await fresh();
    await put(outer, { project: "outside" });
    const repo = join(outer, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, "src"));
    expect(await findProjectFile(join(repo, "src"))).toBeNull();
  });

  test("a file in the root of the repository is found, and nothing is null", async () => {
    const repo = await fresh();
    await mkdir(join(repo, ".git"));
    expect(await findProjectFile(repo)).toBeNull();
    await put(repo, {});
    expect((await findProjectFile(repo))?.config).toEqual({});
  });

  test("a file that is not JSON is refused", async () => {
    const root = await fresh();
    await put(root, "{ nope");
    expect(message(await findProjectFile(root).catch((e) => e))).toBe(
      `${join(root, PROJECT_FILE)} is not valid JSON`,
    );
  });

  test("it cannot name the API or carry a token: unknown keys are refused, by name only", async () => {
    const root = await fresh();
    for (const key of ["apiUrl", "token", "password", "secret"]) {
      await put(root, { project: "web", [key]: "https://evil.example/ghp_0123456789" });
      const error = await findProjectFile(root).catch((e) => e);
      expect(error).toBeInstanceOf(CliError);
      expect(message(error)).toBe(`${join(root, PROJECT_FILE)} is not valid: ${key}`);
      expect(message(error)).not.toContain("ghp_");
    }
  });

  test("every unknown key is named", async () => {
    const root = await fresh();
    await put(root, { project: "web", token: "x", apiUrl: "y" });
    expect(message(await findProjectFile(root).catch((e) => e))).toBe(
      `${join(root, PROJECT_FILE)} is not valid: token, apiUrl`,
    );
  });

  test("a directory called .orch.json is not the file: the search goes on", async () => {
    const root = await fresh();
    await mkdir(join(root, ".git"));
    await put(root, { project: "web" });
    await mkdir(join(root, "sub", PROJECT_FILE), { recursive: true });
    expect((await findProjectFile(join(root, "sub")))?.path).toBe(join(root, PROJECT_FILE));
  });

  test("fields must be short, non-empty strings", async () => {
    const root = await fresh();
    const refuse = async (c: unknown) => {
      await put(root, c);
      return message(await findProjectFile(root).catch((e) => e));
    };
    const path = join(root, PROJECT_FILE);
    for (const field of ["organization", "project", "environment"]) {
      expect(await refuse({ [field]: "" })).toBe(`${path} is not valid: ${field}`);
      expect(await refuse({ [field]: 5 })).toBe(`${path} is not valid: ${field}`);
      expect(await refuse({ [field]: "x".repeat(201) })).toBe(`${path} is not valid: ${field}`);
      expect(await refuse({ [field]: "x".repeat(200) })).toBe("");
    }
    expect(await refuse([])).toBe(`${path} is not valid: (file)`);
  });

  test("with no file and no repository on the way up to the filesystem root, the answer is null", async () => {
    expect(await findProjectFile(await fresh())).toBeNull();
  });
});
