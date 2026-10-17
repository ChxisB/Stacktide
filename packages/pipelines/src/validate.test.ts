import { describe, expect, test } from "bun:test";
import type { Manifest } from "./manifest";
import { type Lint, validate } from "./validate";

const needs = (...requiresVariables: string[]) => ({ requiresVariables }) as Manifest;
const fine: Lint = async () => ({ valid: true, errors: [], warnings: [] });

describe("validate", () => {
  test("a valid pipeline whose variables are all set is ok", async () => {
    const r = await validate({
      manifest: needs("A", "B"),
      text: "x",
      lint: fine,
      variables: [{ environment: "prod", keys: ["A", "B", "C"] }],
    });
    expect(r).toEqual({
      ok: true,
      lint: { valid: true, errors: [], warnings: [] },
      missingVariables: [],
    });
  });

  test("lint errors fail it and come back as they are; the text is what was linted", async () => {
    const seen: string[] = [];
    const r = await validate({
      manifest: needs(),
      text: "the rendered text",
      lint: async (content) => {
        seen.push(content);
        return { valid: false, errors: ["jobs:test config should implement script"], warnings: [] };
      },
      variables: [],
    });
    expect(seen).toEqual(["the rendered text"]);
    expect(r.ok).toBe(false);
    expect(r.lint.errors).toEqual(["jobs:test config should implement script"]);
  });

  test("warnings are reported and do not fail it", async () => {
    const r = await validate({
      manifest: needs(),
      text: "x",
      lint: async () => ({ valid: true, errors: [], warnings: ["may run twice"] }),
      variables: [],
    });
    expect(r.ok).toBe(true);
    expect(r.lint.warnings).toEqual(["may run twice"]);
  });

  test("a variable missing from an environment fails it, naming the environment and only the missing ones, in the template's order", async () => {
    const r = await validate({
      manifest: needs("TOKEN", "REGION", "DB_URL"),
      text: "x",
      lint: fine,
      variables: [
        { environment: "dev", keys: ["DB_URL", "TOKEN", "REGION"] },
        { environment: "prod", keys: new Set(["REGION"]) },
        { environment: "stage", keys: [] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.missingVariables).toEqual([
      { environment: "prod", keys: ["TOKEN", "DB_URL"] },
      { environment: "stage", keys: ["TOKEN", "REGION", "DB_URL"] },
    ]);
  });

  test("a variable the template lists twice is reported once", async () => {
    const r = await validate({
      manifest: needs("A", "B", "A"),
      text: "x",
      lint: fine,
      variables: [{ environment: "prod", keys: [] }],
    });
    expect(r.missingVariables).toEqual([{ environment: "prod", keys: ["A", "B"] }]);
  });

  test("a project without environments is checked once, as environment null", async () => {
    const r = await validate({
      manifest: needs("TOKEN"),
      text: "x",
      lint: fine,
      variables: [{ environment: null, keys: [] }],
    });
    expect(r.missingVariables).toEqual([{ environment: null, keys: ["TOKEN"] }]);
  });

  test("both problems are reported together; a case differing is a different variable", async () => {
    const r = await validate({
      manifest: needs("Token"),
      text: "x",
      lint: async () => ({ valid: false, errors: ["bad"], warnings: [] }),
      variables: [{ environment: "prod", keys: ["TOKEN"] }],
    });
    expect(r.ok).toBe(false);
    expect(r.lint.errors).toEqual(["bad"]);
    expect(r.missingVariables).toEqual([{ environment: "prod", keys: ["Token"] }]);
  });

  test("nothing is asked of the linter beyond the text, and its extra fields are not passed on", async () => {
    const r = await validate({
      manifest: needs(),
      text: "x",
      lint: async () => ({ valid: true, errors: [], warnings: [], mergedYaml: "SECRET-ish" }),
      variables: [],
    });
    expect(JSON.stringify(r)).not.toContain("mergedYaml");
    expect(JSON.stringify(r)).not.toContain("SECRET-ish");
  });
});
