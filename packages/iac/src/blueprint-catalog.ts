import {
  BLUEPRINT_CLOUDS,
  BLUEPRINT_KINDS,
  BLUEPRINT_PROFILES,
  BLUEPRINT_USES,
  type BlueprintCloud,
  type BlueprintKind,
  BlueprintSchema,
} from "@orch/core";
import { z } from "zod";
import { readModule } from "./blueprint-modules";
import { BLUEPRINT_MODULES } from "./blueprint-render";

export type BlueprintCatalog = {
  profiles: BlueprintProfileName[];
  kinds: {
    kind: BlueprintKind;
    uses: BlueprintKind[];
    clouds: { cloud: BlueprintCloud; version: string; idleCost: string }[];
  }[];
  /** The closed input schema as JSON Schema: one variant per kind, `additionalProperties: false`. */
  inputs: Record<string, unknown>;
};
type BlueprintProfileName = (typeof BLUEPRINT_PROFILES)[number];

/** The README's `- **Idle cost:** …` line: the one place the cost is written, so the catalog cannot drift from the module. */
export const idleCostOf = (readme: string): string | undefined =>
  /^- \*\*Idle cost:\*\* (.+)$/m.exec(readme)?.[1]?.trim();

let built: BlueprintCatalog | undefined;

/** What can be asked for, read from the schema and the shipped modules. Nothing in it is a module's Terraform. */
export function blueprintCatalog(): BlueprintCatalog {
  built ??= {
    profiles: [...BLUEPRINT_PROFILES],
    kinds: BLUEPRINT_KINDS.map((kind) => ({
      kind,
      uses: [...BLUEPRINT_USES[kind]],
      clouds: BLUEPRINT_CLOUDS.map((cloud) => {
        const readme = readModule(cloud, kind).find((f) => f.name === "README.md")?.content ?? "";
        const idleCost = idleCostOf(readme);
        const pin = BLUEPRINT_MODULES[`${cloud}/${kind}`];
        if (!idleCost || !pin) throw new Error(`${cloud}/${kind} has no idle cost or no pin`);
        return { cloud, version: pin.version, idleCost };
      }),
    })),
    inputs: z.toJSONSchema(BlueprintSchema, { io: "input", unrepresentable: "any" }),
  };
  return built;
}
