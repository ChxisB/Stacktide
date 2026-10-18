import { describe, expect, test } from "bun:test";
import { DEFAULT_GUARDRAILS } from "@orch/sync";
import { z } from "zod";
import { guardrailEnv, guardrailRefusal, guardrailsOf } from "./guardrails";

const env = z.object(guardrailEnv);
const problems = (input: Record<string, string>) => {
  const r = env.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`);
};

describe("the settings", () => {
  test("left out, every rule is on and production is production and prod", () => {
    expect(guardrailsOf({})).toEqual(DEFAULT_GUARDRAILS);
    expect(guardrailsOf({ ORCH_GUARDRAILS_OFF: " ", ORCH_PRODUCTION_SCOPES: ",," })).toEqual(
      DEFAULT_GUARDRAILS,
    );
  });
  test("rules are switched off by id and production scopes are named", () => {
    expect(
      guardrailsOf({
        ORCH_GUARDRAILS_OFF: "production-variable-protected, production-secret-protected",
        ORCH_PRODUCTION_SCOPES: "prod-eu,prod-us",
      }),
    ).toEqual({
      off: ["production-variable-protected", "production-secret-protected"],
      production: ["prod-eu", "prod-us"],
    });
  });
  test("a rule that does not exist, or a wildcard, is a boot error and not silently ignored", () => {
    expect(problems({ ORCH_GUARDRAILS_OFF: "production-secret-protected" })).toEqual([]);
    expect(problems({ ORCH_GUARDRAILS_OFF: "production-secret-protectd" })).toEqual([
      expect.stringContaining("ORCH_GUARDRAILS_OFF names a rule that does not exist"),
    ]);
    expect(problems({ ORCH_GUARDRAILS_OFF: "toString" })).toHaveLength(1);
    expect(problems({ ORCH_PRODUCTION_SCOPES: "production,prod-*" })).toEqual([
      expect.stringContaining("ORCH_PRODUCTION_SCOPES"),
    ]);
    expect(problems({ ORCH_PRODUCTION_SCOPES: "prod-eu, prod-us" })).toEqual([]);
  });
});

describe("the refusal", () => {
  test("is a 422 that names the rule, the key and scope and what to do, and no more than ten", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      rule: "production-secret-protected" as const,
      key: `K${String(i).padStart(2, "0")}`,
      scope: "production",
    }));
    const e = guardrailRefusal("The plan", many);
    expect(e).toMatchObject({ code: "guardrail_violation", status: 422 });
    expect(e.message).toContain('production-secret-protected: "K00" (production)');
    expect(e.message).toContain('"K09"');
    expect(e.message).not.toContain('"K10"');
    expect(e.message).toContain("and 3 more");
    expect(e.message).toContain("Set protected to true in the target's config");
  });
  test("names a scope when no key is known, and each rule once", () => {
    const e = guardrailRefusal("The pipeline", [
      { rule: "production-variable-protected", scope: "production" },
      { rule: "production-variable-protected", scope: "prod" },
    ]);
    expect(e.message).toContain('production-variable-protected: scope "production"');
    expect(e.message.match(/production-variable-protected means/g)).toHaveLength(1);
  });
});
