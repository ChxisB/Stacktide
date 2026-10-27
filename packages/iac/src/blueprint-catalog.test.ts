import { describe, expect, test } from "bun:test";
import { BLUEPRINT_CLOUDS, BLUEPRINT_KINDS, BLUEPRINT_PROFILES, BLUEPRINT_USES } from "@orch/core";
import { blueprintCatalog, idleCostOf } from "./blueprint-catalog";
import { readModule } from "./blueprint-modules";
import { BLUEPRINT_MODULES } from "./blueprint-render";

const readme = (cloud: string, kind: string) =>
  readModule(cloud, kind).find((f) => f.name === "README.md")?.content ?? "";

describe("the idle cost a README states", () => {
  test("is the sentence after the label, on its own line", () => {
    expect(idleCostOf("# x\n\n- **Idle cost:** none. It is free.\n- **Other:** y\n")).toBe(
      "none. It is free.",
    );
  });
  test("is nothing when the README says none", () => {
    expect(idleCostOf("# x\n\nIdle cost: none\n")).toBeUndefined();
    expect(idleCostOf("")).toBeUndefined();
  });
});

describe("the catalog of blueprints", () => {
  const catalog = blueprintCatalog();

  test("lists the four kinds in the order the schema has them, with what each may use", () => {
    expect(catalog.kinds.map((k) => k.kind)).toEqual([...BLUEPRINT_KINDS]);
    for (const k of catalog.kinds) expect(k.uses).toEqual([...BLUEPRINT_USES[k.kind]]);
    expect(catalog.profiles).toEqual([...BLUEPRINT_PROFILES]);
  });

  test("gives each kind both clouds, with the version vendored and the idle cost its README states", () => {
    for (const k of catalog.kinds) {
      expect(k.clouds.map((c) => c.cloud)).toEqual([...BLUEPRINT_CLOUDS]);
      for (const c of k.clouds) {
        const at = `${c.cloud}/${k.kind}`;
        expect([at, c.version]).toEqual([at, BLUEPRINT_MODULES[at]?.version ?? ""]);
        expect([at, c.idleCost]).toEqual([at, idleCostOf(readme(c.cloud, k.kind)) ?? ""]);
        expect([at, c.idleCost.length > 0]).toEqual([at, true]);
      }
    }
  });

  test("says what is billed while idle: a NAT gateway on AWS, nothing for a GCP network", () => {
    const cost = (kind: string, cloud: string) =>
      catalog.kinds.find((k) => k.kind === kind)?.clouds.find((c) => c.cloud === cloud)?.idleCost;
    expect(cost("network", "aws")).toContain("NAT gateway");
    expect(cost("network", "gcp")).toStartWith("none");
  });

  test("describes the inputs as one JSON schema with a variant for each kind", () => {
    const variants = (catalog.inputs as { oneOf: { properties: { kind: { const: string } } }[] })
      .oneOf;
    expect(variants.map((v) => v.properties.kind.const)).toEqual([...BLUEPRINT_KINDS]);
    // closed: a field the schema does not name is not an input
    for (const v of variants) expect(v).toMatchObject({ additionalProperties: false });
  });

  test("carries sentences and shapes only: none of a module's Terraform", () => {
    const text = JSON.stringify(catalog);
    for (const word of ['resource "', 'variable "', "provider ", "terraform {", "BLUEPRINTS_DIR"]) {
      expect([word, text.includes(word)]).toEqual([word, false]);
    }
  });

  test("is built once", () => {
    expect(blueprintCatalog()).toBe(catalog);
  });
});
