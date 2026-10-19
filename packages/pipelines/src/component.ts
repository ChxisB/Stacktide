import { APP_NAME } from "@orch/core";
import { parseAllDocuments } from "yaml";
import type { Template } from "./loader";
import type { Manifest } from "./manifest";
import { includeFile } from "./render";

/**
 * Where a template's component lives in a catalog project (CMP-1): GitLab reads `templates/<name>.yml`
 * (or `templates/<name>/template.yml`). The component's version is the project's tag, not a path, so a
 * project holds one version of each template.
 */
export const componentPath = (m: Pick<Manifest, "name">) => `templates/${m.name}.yml`;

/**
 * The file for `componentPath`: the include file (PIPE-9) as it is, a `spec: inputs:` header, `---` and
 * the jobs with `$[[ inputs.x ]]`, under a header of its own. GitLab reads a component the same way.
 */
export function componentFile(template: Template): string {
  const { name, version } = template.manifest;
  const text = includeFile(template);
  return `# ${name}@${version} from ${APP_NAME}'s catalog: published as a component, edits here are overwritten by the next publish.\n${text.slice(text.indexOf("\n") + 1)}`;
}

const MAX_COMPONENTS = 100;
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const NOT_A_COMPONENT =
  "not a component (use templates/<name>.yml or templates/<name>/template.yml)";

/** The problems that stop a project from being published to the CI/CD Catalog, found offline; none when it can be. */
export function validateCatalogLayout(
  files: Readonly<Record<string, string>>,
  description: string | undefined,
): string[] {
  const problems: string[] = [];
  if (!description?.trim()) problems.push("description: the project needs one");
  const readme = files["README.md"];
  if (readme === undefined) problems.push("README.md: missing");
  else if (!readme.trim()) problems.push("README.md: empty");

  const found = new Map<string, string[]>();
  for (const path of Object.keys(files).sort()) {
    if (!path.startsWith("templates/")) continue;
    const m =
      /^templates\/([^/]+)\.yml$/.exec(path) ?? /^templates\/([^/]+)\/template\.yml$/.exec(path);
    if (!m) {
      problems.push(`${path}: ${NOT_A_COMPONENT}`);
      continue;
    }
    if (!NAME.test(m[1] ?? "")) {
      problems.push(`${path}: the component name must be lowercase letters, digits, - or _`);
      continue;
    }
    found.set(m[1] as string, [...(found.get(m[1] as string) ?? []), path]);
    problems.push(...checkComponent(path, files[path] ?? ""));
  }
  for (const [name, paths] of found)
    if (paths.length > 1) problems.push(`templates/${name}: is both ${paths.join(" and ")}`);
  if (found.size === 0) problems.push("templates/: needs at least one component");
  if (found.size > MAX_COMPONENTS)
    problems.push(`templates/: ${found.size} components, GitLab allows at most ${MAX_COMPONENTS}`);
  return problems;
}

/** What a component declares: the inputs a pipeline may pass. */
export interface ComponentInput {
  name: string;
  /** GitLab's input type (`string` when the file does not say). */
  type: string;
  /** No default: a pipeline has to pass it. */
  required: boolean;
}

/** A component is two YAML documents: `spec: inputs:`, then the jobs. Returns its inputs, or what is wrong with the file. */
export function readComponent(text: string): { inputs: ComponentInput[] } | { problem: string } {
  const docs = parseAllDocuments(text, { version: "1.1" });
  if (docs.some((d) => d.errors.length > 0)) return { problem: "is not valid YAML" };
  if (docs.length > 2)
    return { problem: "has more than two YAML documents: a spec, then the jobs" };
  let spec: unknown;
  let jobs: unknown;
  try {
    [spec, jobs] = docs.map((d) => d.toJS() as unknown);
  } catch {
    return { problem: "is not valid YAML" }; // an alias to nothing, or too many aliases
  }
  const isMap = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (docs.length < 2 || !isMap(spec) || !isMap(spec.spec) || !("inputs" in spec.spec))
    return { problem: "needs a spec: inputs: header, then ---, then the jobs" };
  if (!isMap(jobs) || Object.keys(jobs).length === 0)
    return { problem: "has no jobs after the ---" };
  const declared = spec.spec.inputs ?? {};
  if (!isMap(declared)) return { problem: "spec: inputs: must be a map of input names" };
  return {
    inputs: Object.entries(declared).map(([name, v]) => {
      const input = isMap(v) ? v : {};
      return {
        name,
        type: typeof input.type === "string" ? input.type : "string",
        required: !("default" in input),
      };
    }),
  };
}

const checkComponent = (path: string, text: string): string[] => {
  const read = readComponent(text);
  return "problem" in read ? [`${path}: ${read.problem}`] : [];
};
