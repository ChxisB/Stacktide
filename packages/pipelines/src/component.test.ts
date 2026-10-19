import { describe, expect, test } from "bun:test";
import { componentFile, componentPath, readComponent, validateCatalogLayout } from "./component";
import { loadTemplates } from "./loader";
import { includeFile } from "./render";

const body = (text: string) => text.slice(text.indexOf("\n") + 1);

describe("the component file", () => {
  test("lives at templates/<name>.yml, the layout GitLab's catalog reads", async () => {
    for (const t of await loadTemplates())
      expect(componentPath(t.manifest)).toBe(`templates/${t.manifest.name}.yml`);
  });

  test("is the include file under another header: same spec, same pipeline", async () => {
    for (const t of await loadTemplates()) {
      const text = componentFile(t);
      expect(text.startsWith(`# ${t.manifest.name}@${t.manifest.version}`)).toBe(true);
      expect(body(text)).toBe(body(includeFile(t)));
    }
  });
});

const component =
  "spec:\n  inputs:\n    x:\n      default: a\n---\nbuild:\n  script:\n    - echo $[[ inputs.x ]]\n";
const valid = {
  "README.md": "# Templates\n",
  "templates/build.yml": component,
  "templates/deploy/template.yml": component,
};
const problems = (
  files: Record<string, string>,
  description: string | undefined = "CI templates",
) => validateCatalogLayout(files, description);

describe("the catalog layout validator", () => {
  test("accepts a layout with both component forms, a README and a description", () => {
    expect(problems(valid)).toEqual([]);
  });

  test("accepts the generated component files of the shipped catalog", async () => {
    const files: Record<string, string> = { "README.md": "# Templates\n" };
    for (const t of await loadTemplates()) files[componentPath(t.manifest)] = componentFile(t);
    expect(problems(files)).toEqual([]);
  });

  test("rejects each missing piece, naming it", () => {
    const { "README.md": _, ...noReadme } = valid;
    expect(problems(noReadme)).toEqual(["README.md: missing"]);
    expect(problems({ ...valid, "README.md": "  \n" })).toEqual(["README.md: empty"]);
    expect(problems(valid, "   ")).toEqual(["description: the project needs one"]);
    expect(validateCatalogLayout(valid, undefined)).toEqual(["description: the project needs one"]);
    expect(problems({ "README.md": "x" })).toEqual(["templates/: needs at least one component"]);
  });

  test("rejects a component without a spec:inputs header or without jobs", () => {
    expect(problems({ ...valid, "templates/build.yml": "build:\n  script: [x]\n" })).toEqual([
      "templates/build.yml: needs a spec: inputs: header, then ---, then the jobs",
    ]);
    expect(problems({ ...valid, "templates/build.yml": "spec:\n  inputs: {}\n---\n" })).toEqual([
      "templates/build.yml: has no jobs after the ---",
    ]);
    expect(problems({ ...valid, "templates/build.yml": "spec: [\n---\nx: 1" })).toEqual([
      "templates/build.yml: is not valid YAML",
    ]);
  });

  test("rejects names and files GitLab would not read as a component", () => {
    expect(problems({ ...valid, "templates/Bad Name.yml": component })).toEqual([
      "templates/Bad Name.yml: the component name must be lowercase letters, digits, - or _",
    ]);
    expect(problems({ ...valid, "templates/build.yaml": component })).toEqual([
      "templates/build.yaml: not a component (use templates/<name>.yml or templates/<name>/template.yml)",
    ]);
    expect(problems({ ...valid, "templates/notes/readme.md": "x" })).toEqual([
      "templates/notes/readme.md: not a component (use templates/<name>.yml or templates/<name>/template.yml)",
    ]);
  });

  test("rejects the same name in both forms, and more than 100 components", () => {
    expect(problems({ ...valid, "templates/build/template.yml": component })).toEqual([
      "templates/build: is both templates/build.yml and templates/build/template.yml",
    ]);
    const many = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`templates/c${i}.yml`, component]),
    );
    expect(problems({ "README.md": "x", ...many })).toEqual([
      "templates/: 101 components, GitLab allows at most 100",
    ]);
  });
});

describe("reading a component", () => {
  test("lists the inputs it declares: a type (string when unsaid), and required when there is no default", () => {
    const text =
      "spec:\n  inputs:\n    a:\n    b:\n      default: 1\n      type: number\n    c:\n      type: boolean\n---\nbuild:\n  script: [x]\n";
    expect(readComponent(text)).toEqual({
      inputs: [
        { name: "a", type: "string", required: true },
        { name: "b", type: "number", required: false },
        { name: "c", type: "boolean", required: true },
      ],
    });
  });

  test("a component with no inputs, and one whose inputs are not a map", () => {
    expect(readComponent("spec:\n  inputs: {}\n---\nj:\n  script: [x]\n")).toEqual({ inputs: [] });
    expect(readComponent("spec:\n  inputs: [a]\n---\nj:\n  script: [x]\n")).toEqual({
      problem: "spec: inputs: must be a map of input names",
    });
  });

  test("says what is wrong rather than throwing, on any text", () => {
    expect(readComponent("")).toEqual({
      problem: "needs a spec: inputs: header, then ---, then the jobs",
    });
    expect(readComponent("a: [")).toEqual({ problem: "is not valid YAML" });
    expect(readComponent("spec:\n  inputs: {}\n---\n")).toEqual({
      problem: "has no jobs after the ---",
    });
    // an alias to nothing makes the yaml library throw when the document is read
    expect(readComponent("spec:\n  inputs: {}\n---\nj:\n  script: *missing\n")).toEqual({
      problem: "is not valid YAML",
    });
    // GitLab reads one spec and one body: a third document is refused when the component is included
    expect(
      readComponent("spec:\n  inputs: {}\n---\nj:\n  script: [x]\n---\nk:\n  script: [x]\n"),
    ).toEqual({ problem: "has more than two YAML documents: a spec, then the jobs" });
  });

  test("the generated component of each shipped template declares its parameters as inputs", async () => {
    for (const t of await loadTemplates()) {
      const read = readComponent(componentFile(t));
      if ("problem" in read) throw new Error(`${t.manifest.name}: ${read.problem}`);
      expect(read.inputs.map((i) => i.name).sort()).toEqual(
        Object.keys(t.manifest.params.properties).sort(),
      );
    }
  });
});
