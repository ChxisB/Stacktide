import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { writeIncludeFiles } from "./include-files";
import { loadTemplates } from "./loader";
import { includeFile, includePath } from "./render";

const dirs: string[] = [];
const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), "orch-include-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

describe("the include files of the catalog", () => {
  test("one file per template version, at the path a thin file points to, with a spec and a pipeline", async () => {
    const templates = await loadTemplates();
    const dir = await fresh();
    const paths = await writeIncludeFiles(dir, templates);
    expect(paths).toEqual(templates.map((t) => includePath(t.manifest)));
    expect(paths.length).toBeGreaterThan(0);
    for (const t of templates) {
      const text = await readFile(join(dir, includePath(t.manifest)), "utf8");
      expect(text).toBe(includeFile(t));
      const docs = parseAllDocuments(text, { version: "1.1" });
      expect(docs).toHaveLength(2);
      expect(docs.flatMap((d) => d.errors)).toEqual([]);
    }
  });

  test("the command writes the same files, and refuses to run without a directory", async () => {
    const script = join(import.meta.dir, "include-files.ts");
    const dir = await fresh();
    const ok = Bun.spawn(["bun", script, dir], { stdout: "pipe", stderr: "pipe" });
    const lines = (await new Response(ok.stdout).text()).trim().split("\n");
    expect(await ok.exited).toBe(0);
    const expected = (await loadTemplates()).map((t) => includePath(t.manifest));
    expect(lines).toEqual(expected);
    for (const path of expected)
      expect((await Bun.file(join(dir, path)).text()).length).toBeGreaterThan(0);

    const bad = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
    expect(await bad.exited).toBe(2);
    expect(await new Response(bad.stderr).text()).toContain("usage:");
  });
});
