import { describe, expect, test } from "bun:test";
import { EVALUATOR_FAILED, judge, POLICY_RULE } from "./policy";

describe("the verdict of a policy report", () => {
  test("nothing denied or warned passes", () => {
    expect(judge({ evaluated: true, denied: [], warned: [] })).toEqual({
      verdict: "pass",
      denied: [],
      warned: [],
    });
  });

  test("a warning alone warns", () => {
    expect(judge({ evaluated: true, denied: [], warned: ["data.main.warn_tags"] })).toEqual({
      verdict: "warn",
      denied: [],
      warned: ["data.main.warn_tags"],
    });
  });

  test("a denial denies, whatever else was warned, and a rule is named once", () => {
    expect(
      judge({
        evaluated: true,
        denied: ["data.main.deny_public", "data.main.deny_public"],
        warned: ["data.main.warn_tags"],
      }),
    ).toEqual({
      verdict: "deny",
      denied: ["data.main.deny_public"],
      warned: ["data.main.warn_tags"],
    });
  });

  test("an evaluation that did not happen denies, and names the failure, not what it might have found", () => {
    // even when the report claims nothing was denied or warned
    expect(judge({ evaluated: false, denied: [], warned: [] })).toEqual({
      verdict: "deny",
      denied: [EVALUATOR_FAILED],
      warned: [],
    });
    expect(judge({ evaluated: false, denied: ["x"], warned: ["y"] }).warned).toEqual([]);
  });

  test("a rule is named in a closed alphabet, and the failure is one that can be named", () => {
    expect(POLICY_RULE.test(EVALUATOR_FAILED)).toBe(true);
    expect(POLICY_RULE.test("data.main.deny_public_bucket")).toBe(true);
    for (const bad of ["", "a b", "a\nb", "a`b", "a'b", "x".repeat(201)]) {
      expect(POLICY_RULE.test(bad)).toBe(false);
    }
  });
});
