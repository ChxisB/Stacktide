import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadTemplates, type Template } from "./loader";
import { includeFile, includePath } from "./render";

/**
 * Writes the include file of each template under `dir`, laid out as the templates project must hold
 * them (PIPE-9), and returns the paths. Names and versions are the manifest's (`[a-z0-9-]` and digits),
 * so a path cannot leave `dir`. The platform never writes the templates project: a person commits
 * these files there.
 */
export async function writeIncludeFiles(dir: string, templates: readonly Template[]) {
  const paths: string[] = [];
  for (const template of templates) {
    const path = includePath(template.manifest);
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), includeFile(template));
    paths.push(path);
  }
  return paths;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: bun run templates:include <directory>");
    process.exit(2);
  }
  for (const path of await writeIncludeFiles(dir, await loadTemplates())) console.log(path);
}
