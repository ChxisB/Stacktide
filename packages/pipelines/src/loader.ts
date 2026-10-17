import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Manifest, manifestSchema } from "./manifest";
import { checkPipeline } from "./pipeline";

export const TEMPLATES_DIR = join(import.meta.dir, "..", "templates");

export interface Template {
  manifest: Manifest;
  /** `pipeline.yml` as written; `render` parses it. */
  pipeline: string;
}

/** Every problem found in the templates, one line each, so a bad catalog is fixed in one pass. */
export class TemplateError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid templates:\n${problems.join("\n")}`);
  }
}

/** Subdirectories, but not hidden ones (`.git`, editor leftovers). */
const dirs = async (path: string) =>
  (await readdir(path, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);

export const byVersion = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return (
    (x?.[0] ?? 0) - (y?.[0] ?? 0) || (x?.[1] ?? 0) - (y?.[1] ?? 0) || (x?.[2] ?? 0) - (y?.[2] ?? 0)
  );
};

/**
 * Loads `<root>/<name>/<version>/{manifest.json,pipeline.yml}` and checks each: the manifest against
 * its schema and against the directory it lives in, the pipeline for existing and being sound (`checkPipeline`).
 * Sorted by name, then version. Throws a `TemplateError` listing every template that is wrong.
 */
export async function loadTemplates(root = TEMPLATES_DIR): Promise<Template[]> {
  const problems: string[] = [];
  const found: Template[] = [];
  for (const name of (await dirs(root)).sort()) {
    for (const version of (await dirs(join(root, name))).sort(byVersion)) {
      const at = `${name}/${version}`;
      const dir = join(root, name, version);
      const fail = (why: string) => problems.push(`${at}: ${why}`);
      const manifestFile = Bun.file(join(dir, "manifest.json"));
      const pipelineFile = Bun.file(join(dir, "pipeline.yml"));
      if (!(await manifestFile.exists())) fail("manifest.json is missing");
      if (!(await pipelineFile.exists())) fail("pipeline.yml is missing");
      if (!(await manifestFile.exists()) || !(await pipelineFile.exists())) continue;

      const raw = await manifestFile.text();
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        fail("manifest.json is not JSON");
        continue;
      }
      const parsed = manifestSchema.safeParse(json);
      if (!parsed.success) {
        for (const i of parsed.error.issues)
          fail(`manifest.json ${i.path.join(".") || "(root)"}: ${i.message}`);
        continue;
      }
      const manifest = parsed.data;
      if (manifest.name !== name)
        fail(`manifest name "${manifest.name}" does not match its directory`);
      if (manifest.version !== version)
        fail(`manifest version "${manifest.version}" does not match its directory`);

      const pipeline = await pipelineFile.text();
      for (const why of checkPipeline(manifest, pipeline)) fail(`pipeline.yml: ${why}`);
      found.push({ manifest, pipeline });
    }
  }
  if (problems.length > 0) throw new TemplateError(problems);
  return found;
}
