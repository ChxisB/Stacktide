import { describe, expect, test } from "bun:test";
import { judge } from "./policy";
import { SECRET_FINDINGS_RULE, SECRET_GATES, secretGateVerdict } from "./secret-gate";

describe("the secret gate (SCAN-6)", () => {
  test("is off, warn or deny, and the rule is named as the policy's rules are", () => {
    expect([...SECRET_GATES]).toEqual(["off", "warn", "deny"]);
    expect(SECRET_FINDINGS_RULE).toBe("secret-findings-open");
  });

  // setting x open findings on the default branch -> what the verdict says
  test.each([
    ["off", 0, "pass", [], []],
    ["off", 1, "pass", [], []],
    ["off", 500, "pass", [], []],
    ["warn", 0, "pass", [], []],
    ["warn", 1, "warn", [], [SECRET_FINDINGS_RULE]],
    ["warn", 500, "warn", [], [SECRET_FINDINGS_RULE]],
    ["deny", 0, "pass", [], []],
    ["deny", 1, "deny", [SECRET_FINDINGS_RULE], []],
    ["deny", 500, "deny", [SECRET_FINDINGS_RULE], []],
  ] as const)("%s with %d open: %s", (gate, open, verdict, denied, warned) => {
    expect(judge(secretGateVerdict(gate, open))).toEqual({
      verdict,
      denied: [...denied],
      warned: [...warned],
    });
  });

  test("it is a verdict that was reached: the scan is not an evaluator that can fail", () => {
    expect(secretGateVerdict("deny", 0).evaluated).toBe(true);
  });
});
