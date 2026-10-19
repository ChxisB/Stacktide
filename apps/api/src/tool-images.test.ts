import { describe, expect, test } from "bun:test";
import { platformOf, toolImageEnv, toolImages } from "./tool-images";

describe("tool images", () => {
  test("each tool's repository comes from its own setting, and an unset one is left out", () => {
    // toEqual ignores a key holding undefined, so look at the keys
    expect(Object.keys(toolImages({}))).toEqual([]);
    expect(Object.keys(toolImages({ ORCH_TOFU_IMAGE: "registry.example.com/t" }))).toEqual([
      "tofu",
    ]);
    expect(
      toolImages({
        ORCH_TERRAFORM_IMAGE: "registry.example.com/tf-orch",
        ORCH_TOFU_IMAGE: "registry.example.com/tofu-orch",
        ORCH_TERRAGRUNT_IMAGE: "registry.example.com/tg",
      }),
    ).toEqual({
      terraform: "registry.example.com/tf-orch",
      tofu: "registry.example.com/tofu-orch",
      terragrunt: "registry.example.com/tg",
    });
    expect(toolImages({ ORCH_TOFU_IMAGE: "registry.example.com/tofu-orch" })).toEqual({
      tofu: "registry.example.com/tofu-orch",
    });
  });

  test("a setting is a non-empty string or nothing", () => {
    expect(Object.keys(toolImageEnv).sort()).toEqual([
      "ORCH_TERRAFORM_IMAGE",
      "ORCH_TERRAGRUNT_IMAGE",
      "ORCH_TOFU_IMAGE",
    ]);
    for (const schema of Object.values(toolImageEnv)) {
      expect(schema.safeParse("").success).toBe(false);
      expect(schema.safeParse(undefined).success).toBe(true);
      expect(schema.safeParse("registry.example.com/x").success).toBe(true);
    }
  });
});

describe("platformOf", () => {
  test("is the address without trailing slashes and the audience, and only when both are set", () => {
    expect(platformOf("https://orch.example.com//", "orch.example.com")).toEqual({
      apiUrl: "https://orch.example.com",
      audience: "orch.example.com",
    });
    expect(platformOf("https://orch.example.com", undefined)).toBeUndefined();
    expect(platformOf(undefined, "orch.example.com")).toBeUndefined();
  });
});
