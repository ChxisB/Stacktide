import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadTemplates, TemplateError } from "./loader";

const roots: string[] = [];
afterAll(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));

/** A templates directory holding the given files, by path under it. */
async function tree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "orch-templates-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const manifest = (name: string, version: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version, description: `${name} pipeline`, ...over });
const PIPELINE = "stages:\n  - test\ntest:\n  stage: test\n  script:\n    - bun test\n";
const template = (name: string, version: string, over: Record<string, unknown> = {}) => ({
  [`${name}/${version}/manifest.json`]: manifest(name, version, over),
  [`${name}/${version}/pipeline.yml`]: PIPELINE,
});
const problemsOf = async (files: Record<string, string>) => {
  const err = await loadTemplates(await tree(files)).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TemplateError);
  return (err as TemplateError).problems;
};

describe("loadTemplates", () => {
  test("loads every template, sorted by name and then by version as numbers", async () => {
    const root = await tree({
      ...template("node-app", "1.0.0"),
      ...template("bun-app", "1.10.0"),
      ...template("bun-app", "1.2.0"),
      ...template("bun-app", "0.9.9"),
      "README.md": "not a template",
      ".cache/1.0.0/notes.txt": "a version directory with no template in it",
    });
    const found = await loadTemplates(root);
    expect(found.map((t) => `${t.manifest.name}@${t.manifest.version}`)).toEqual([
      "bun-app@0.9.9",
      "bun-app@1.2.0",
      "bun-app@1.10.0",
      "node-app@1.0.0",
    ]);
    expect(found[0]?.pipeline).toBe(PIPELINE);
  });

  test("an empty directory holds no templates", async () => {
    expect(await loadTemplates(await tree({}))).toEqual([]);
  });

  test("a directory that does not exist is an error, not an empty catalog", async () => {
    const root = await tree({});
    await expect(loadTemplates(join(root, "nope"))).rejects.toThrow();
  });

  test("a missing manifest and a missing pipeline are named", async () => {
    const problems = await problemsOf({
      "a/1.0.0/pipeline.yml": PIPELINE,
      "b/1.0.0/manifest.json": manifest("b", "1.0.0"),
    });
    expect(problems).toEqual([
      "a/1.0.0: manifest.json is missing",
      "b/1.0.0: pipeline.yml is missing",
    ]);
  });

  test("a manifest that is not JSON is named", async () => {
    expect(
      await problemsOf({ "a/1.0.0/manifest.json": "{ nope", "a/1.0.0/pipeline.yml": PIPELINE }),
    ).toEqual(["a/1.0.0: manifest.json is not JSON"]);
  });

  test("a malformed manifest says where", async () => {
    const problems = await problemsOf(
      template("a", "1.0.0", { params: { type: "object", properties: { x: { type: "array" } } } }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("a/1.0.0: manifest.json params.properties.x.type");
  });

  test("a manifest that is not the directory it lives in is refused", async () => {
    const problems = await problemsOf({
      "a/1.0.0/manifest.json": manifest("other", "2.0.0"),
      "a/1.0.0/pipeline.yml": PIPELINE,
    });
    expect(problems).toEqual([
      'a/1.0.0: manifest name "other" does not match its directory',
      'a/1.0.0: manifest version "2.0.0" does not match its directory',
    ]);
  });

  test("a pipeline that is not YAML, or not a mapping, is refused", async () => {
    const problems = await problemsOf({
      ...template("a", "1.0.0"),
      "a/1.0.0/pipeline.yml": "stages: [unclosed\n  - x: : :",
      ...template("b", "1.0.0"),
      "b/1.0.0/pipeline.yml": "- just\n- a list\n",
      ...template("c", "1.0.0"),
      "c/1.0.0/pipeline.yml": "",
    });
    expect(problems).toEqual([
      "a/1.0.0: pipeline.yml is not YAML",
      "b/1.0.0: pipeline.yml is not a mapping",
      "c/1.0.0: pipeline.yml is not a mapping",
    ]);
  });

  test("every bad template is reported in one pass, the good ones are not", async () => {
    const problems = await problemsOf({
      ...template("good", "1.0.0"),
      "bad-one/1.0.0/pipeline.yml": PIPELINE,
      ...template("bad-two", "1.0.0", { version: "x" }),
    });
    expect(problems.map((p) => p.split(":")[0])).toEqual(["bad-one/1.0.0", "bad-two/1.0.0"]);
  });
});
