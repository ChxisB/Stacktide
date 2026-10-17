import { describe, expect, test } from "bun:test";
import { manifestSchema, paramsSchema } from "./manifest";

const valid = {
  name: "bun-app",
  version: "1.0.0",
  description: "Install, check and build a Bun app",
  params: {
    type: "object",
    properties: {
      bunVersion: { type: "string", default: "1.4", pattern: "^\\d+\\.\\d+" },
      runner: { type: "string", enum: ["small", "large"], default: "small" },
      retries: { type: "integer", minimum: 0, maximum: 3, default: 0 },
      cache: { type: "boolean", default: true },
      image: { type: "string" },
    },
    required: ["image"],
  },
  detects: ["bun"],
  requiresVariables: ["NPM_TOKEN"],
};

/** A manifest whose only parameter is `x`, so a failure can only be about `x`. */
const only = (x: object, required: string[] = []) => ({
  params: { type: "object", properties: { x }, required },
});

const problems = (input: unknown) => {
  const r = manifestSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("manifest", () => {
  test("a complete manifest is accepted as written", () => {
    expect(manifestSchema.parse(valid) as unknown).toEqual(valid);
  });

  test("params, detects and requiresVariables are optional and default to empty", () => {
    const m = manifestSchema.parse({ name: "x", version: "0.1.0", description: "d" });
    expect(m.params).toEqual({ type: "object", properties: {}, required: [] });
    expect(m.detects).toEqual([]);
    expect(m.requiresVariables).toEqual([]);
  });

  test.each([
    ["a name that is not a slug", { name: "Bun App" }, "name"],
    ["a name that is empty", { name: "" }, "name"],
    ["a version that is not x.y.z", { version: "1.0" }, "version"],
    ["a version with a prefix", { version: "v1.0.0" }, "version"],
    ["no description", { description: undefined }, "description"],
    ["an empty description", { description: "" }, "description"],
    ["a key the manifest does not know", { extra: 1 }, ""],
    ["a parameter type that is not a scalar", only({ type: "array" }), "params.properties.x.type"],
    ["a parameter type that is an object", only({ type: "object" }), "params.properties.x.type"],
    ["a parameter without a type", only({}), "params.properties.x.type"],
    [
      "a parameter with a keyword the subset lacks",
      only({ type: "string", $ref: "#/x" }),
      "params.properties.x",
    ],
    [
      "a parameter name that is not an identifier",
      { params: { type: "object", properties: { "a b": { type: "string" } }, required: [] } },
      "params.properties.a b",
    ],
    [
      "a required parameter that is not declared",
      only({ type: "string" }, ["nope"]),
      "params.required",
    ],
    [
      "a default of the wrong type",
      only({ type: "integer", default: "one" }),
      "params.properties.x.default",
    ],
    [
      "a default outside the enum",
      only({ type: "string", enum: ["a"], default: "b" }),
      "params.properties.x.default",
    ],
    [
      "a default that breaks its pattern",
      only({ type: "string", pattern: "^a", default: "b" }),
      "params.properties.x.default",
    ],
    ["an empty enum", only({ type: "string", enum: [] }), "params.properties.x.enum"],
    [
      "a required parameter named like an inherited property",
      only({ type: "string" }, ["toString"]),
      "params.required",
    ],
    [
      "a required parameter with a default",
      only({ type: "string", default: "a" }, ["x"]),
      "params.required",
    ],
    [
      "a pattern that is not a regular expression",
      only({ type: "string", pattern: "(", default: "x" }),
      "params.properties.x.pattern",
    ],
    [
      "a pattern on a number",
      only({ type: "integer", pattern: "^a" }),
      "params.properties.x.pattern",
    ],
    [
      "a length on a number",
      only({ type: "integer", maxLength: 3 }),
      "params.properties.x.maxLength",
    ],
    ["a range on a string", only({ type: "string", minimum: 1 }), "params.properties.x.minimum"],
    [
      "a range that is empty",
      only({ type: "integer", minimum: 5, maximum: 1 }),
      "params.properties.x.minimum",
    ],
    [
      "a choice of the wrong type",
      only({ type: "string", enum: ["a", 1] }),
      "params.properties.x.enum",
    ],
    [
      "a choice that breaks the pattern",
      only({ type: "string", pattern: "^a", enum: ["ab", "b"] }),
      "params.properties.x.enum",
    ],
    ["a project type that does not exist", { detects: ["cobol"] }, "detects.0"],
    [
      "a variable key that is not a key",
      { requiresVariables: ["not a key"] },
      "requiresVariables.0",
    ],
  ])("rejects %s", (_name, patch, path) => {
    const found = problems({ ...valid, ...patch });
    expect(found).toHaveLength(1);
    expect(found[0]).toStartWith(`${path}:`);
  });

  test("says which parameter has a bad default", () => {
    expect(problems({ ...valid, ...only({ type: "integer", default: "one" }) })).toEqual([
      "params.properties.x.default: does not satisfy its own schema",
    ]);
  });

  test("a parameter with only a type is fine", () => {
    expect(problems({ ...valid, ...only({ type: "string" }) })).toEqual([]);
  });
});

describe("paramsSchema", () => {
  const schema = paramsSchema(manifestSchema.parse(valid));

  test("fills in defaults and keeps what was given", () => {
    expect(schema.parse({ image: "bun:1", retries: 2 })).toEqual({
      image: "bun:1",
      bunVersion: "1.4",
      runner: "small",
      retries: 2,
      cache: true,
    });
  });

  test.each([
    ["a missing required parameter", {}],
    ["a parameter the manifest does not declare", { image: "i", extra: "x" }],
    ["a value of the wrong type", { image: "i", retries: "2" }],
    ["a number that is not an integer", { image: "i", retries: 1.5 }],
    ["a value above the maximum", { image: "i", retries: 4 }],
    ["a value outside the enum", { image: "i", runner: "huge" }],
    ["a value that breaks the pattern", { image: "i", bunVersion: "latest" }],
    ["an object where a string belongs", { image: { $ref: "x" } }],
    ["a list where a string belongs", { image: ["a"] }],
  ])("rejects %s", (_name, input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });

  test("a string is at most 1000 characters unless the manifest says otherwise", () => {
    expect(schema.safeParse({ image: "a".repeat(1000) }).success).toBe(true);
    expect(schema.safeParse({ image: "a".repeat(1001) }).success).toBe(false);
    const withLimit = (maxLength: number) =>
      paramsSchema(manifestSchema.parse({ ...valid, ...only({ type: "string", maxLength }) }));
    expect(withLimit(3).safeParse({ x: "abc" }).success).toBe(true);
    expect(withLimit(3).safeParse({ x: "abcd" }).success).toBe(false);
    expect(withLimit(5000).safeParse({ x: "a".repeat(5000) }).success).toBe(true);
  });

  test("a manifest with no parameters accepts only an empty object", () => {
    const none = paramsSchema(
      manifestSchema.parse({ name: "x", version: "0.1.0", description: "d" }),
    );
    expect(none.parse({})).toEqual({});
    expect(none.safeParse({ a: 1 }).success).toBe(false);
  });
});
