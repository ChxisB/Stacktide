import { describe, expect, test } from "bun:test";
import { type Manifest, manifestSchema } from "./manifest";
import { checkPipeline, parsePipeline } from "./pipeline";

const manifest = (names: string[]): Manifest =>
  manifestSchema.parse({
    name: "t",
    version: "1.0.0",
    description: "t",
    params: {
      type: "object",
      properties: Object.fromEntries(
        names.map((n) => [n, { type: "string", default: "x", pattern: "^x$" }]),
      ),
    },
  });

describe("parsePipeline", () => {
  test("reads a mapping into plain values", () => {
    expect(parsePipeline("a: 1\nb:\n  - x\n  - true\nc: {d: null}\n")).toEqual({
      a: 1,
      b: ["x", true],
      c: { d: null },
    });
  });

  test("expands anchors and merge keys, as GitLab does", () => {
    expect(parsePipeline("base: &b {x: 1}\njob:\n  <<: *b\n  y: 2\n")).toEqual({
      base: { x: 1 },
      job: { x: 1, y: 2 },
    });
  });

  test.each([
    ["a duplicate key", "a: 1\na: 2\n", "Map keys must be unique"],
    ["two documents", "a: 1\n---\nb: 2\n", "multiple documents"],
    ["a tag (GitLab's !reference would be lost)", "a: !reference [x, y]\n", "Unresolved tag"],
    ["an unclosed list", "stages: [unclosed\n", "Flow sequence"],
    ["a list", "- just\n- a list\n", "not a mapping"],
    ["nothing", "", "not a mapping"],
    ["a scalar", "text\n", "not a mapping"],
    ["an unquoted placeholder", "a: {{ params.x }}\n", "is a placeholder not quoted"],
    ["an alias that holds itself", "a: &x [*x]\n", "aliases"],
    ["a value that is not JSON", "a: .inf\n", "not JSON"],
  ])("refuses %s", (_, text, why) => {
    expect(() => parsePipeline(text)).toThrow(why);
  });
});

describe("checkPipeline", () => {
  test("a sound pipeline has no problems", () => {
    expect(
      checkPipeline(
        manifest(["a", "b"]),
        'x: "{{ params.a }}"\ny: ["{{params.b}} and {{ params.a }}"]\n',
      ),
    ).toEqual([]);
  });

  test("a parameter that is used and not declared, and one declared and never used", () => {
    expect(
      checkPipeline(manifest(["a", "unused"]), 'x: "{{ params.a }}{{ params.nope }}"\n'),
    ).toEqual([
      "parameter nope is used but not declared in the manifest",
      "parameter unused is declared but never used",
    ]);
  });

  test("inherited names are not declared", () => {
    expect(checkPipeline(manifest([]), 'x: "{{ params.toString }}"\n')).toEqual([
      "parameter toString is used but not declared in the manifest",
    ]);
  });

  test.each([
    ["a nested name", 'x: "{{ params.a.b }}"'],
    ["a missing name", 'x: "{{ params. }}"'],
    ["one brace", 'x: "{{ params.a }"'],
    ["an expression", 'x: "{{ params.a | upper }}"'],
  ])("a placeholder that is %s is refused where it is", (_, text) => {
    expect(checkPipeline(manifest(["a"]), `${text}\n`)).toContain(
      "x: a placeholder is written {{ params.name }}",
    );
  });

  test("a placeholder in a key, and its place in a list", () => {
    expect(
      checkPipeline(
        manifest(["a"]),
        'job:\n  script:\n    - "{{ params.a }}"\n    - "{{ params.b.c }}"\n"{{ params.a }}": 1\n',
      ),
    ).toEqual([
      "job.script[1]: a placeholder is written {{ params.name }}",
      "{{ params.a }}: a placeholder cannot be in a key",
    ]);
  });

  test("text that only looks like a template is left alone", () => {
    expect(
      checkPipeline(
        manifest(["a"]),
        'x: "{{ params.a }}"\ny: "docker ps --format {{.Names}}"\nz: "{{ other }}"\n',
      ),
    ).toEqual([]);
  });

  test("a pipeline that cannot be read is one problem", () => {
    expect(checkPipeline(manifest([]), "a: 1\na: 2\n")).toEqual([
      "Map keys must be unique at line 2, column 1",
    ]);
  });
});
