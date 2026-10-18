import { describe, expect, test } from "bun:test";
import {
  checkItems,
  checkScope,
  DEFAULT_GUARDRAILS,
  GUARDRAILS,
  type GuardrailConfig,
  isGuardrailRule,
  reachesProduction,
} from "./guardrails";
import type { ItemInput } from "./types";

const item = (key: string, scope: string, secret = false): ItemInput => ({
  key,
  scope,
  value: "hunter2-never-in-a-violation",
  secret,
  file: false,
});
const open = { protected: false };
const guarded = { protected: true };

describe("production-secret-protected", () => {
  const rule = "production-secret-protected";
  test("a secret in a production scope on an unprotected target breaks it", () => {
    expect(checkItems([item("DB_PASSWORD", "production", true)], open)).toEqual([
      { rule, key: "DB_PASSWORD", scope: "production" },
    ]);
  });
  test("passes on a protected target, in another scope, or when the item is no secret of its own", () => {
    expect(checkItems([item("DB_PASSWORD", "production", true)], guarded)).toEqual([]);
    expect(checkItems([item("DB_PASSWORD", "staging", true)], open)).toEqual([]);
    expect(checkItems([item("DB_PASSWORD", "*", true)], open)).toEqual([]);
    // a plain variable is the other rule's
    expect(checkItems([item("REGION", "production")], open).map((v) => v.rule)).not.toContain(rule);
  });
  test("switched off, it finds nothing and leaves the other rule alone", () => {
    const off: GuardrailConfig = { ...DEFAULT_GUARDRAILS, off: [rule] };
    const items = [item("DB_PASSWORD", "production", true), item("REGION", "production")];
    expect(checkItems(items, open, off).map((v) => v.rule)).toEqual([
      "production-variable-protected",
    ]);
  });
});

describe("production-variable-protected", () => {
  const rule = "production-variable-protected";
  test("a plain variable in a production scope on an unprotected target breaks it", () => {
    expect(checkItems([item("REGION", "production")], open)).toEqual([
      { rule, key: "REGION", scope: "production" },
    ]);
  });
  test("passes on a protected target and in scopes that are not production", () => {
    expect(checkItems([item("REGION", "production")], guarded)).toEqual([]);
    expect(checkItems([item("REGION", "staging")], open)).toEqual([]);
    expect(checkItems([item("REGION", "*")], open)).toEqual([]);
  });
  test("switched off, it finds nothing and leaves the other rule alone", () => {
    const off: GuardrailConfig = { ...DEFAULT_GUARDRAILS, off: [rule] };
    const items = [item("DB_PASSWORD", "production", true), item("REGION", "production")];
    expect(checkItems(items, open, off).map((v) => v.rule)).toEqual([
      "production-secret-protected",
    ]);
    expect(checkScope("production", open, off)).toBeUndefined();
  });
  test("a scope alone is judged by it", () => {
    expect(checkScope("production", open)).toEqual({ rule, scope: "production" });
    expect(checkScope("production", guarded)).toBeUndefined();
    expect(checkScope("staging", open)).toBeUndefined();
  });
});

describe("what is production", () => {
  test("the scope names, matched as GitLab patterns", () => {
    for (const scope of ["production", "prod", "prod*", "p*", "*duction", "pro*ion"]) {
      expect([scope, reachesProduction(scope)]).toEqual([scope, true]);
    }
    for (const scope of ["staging", "*", "production-eu", "preprod", "prod-*", "Production"]) {
      expect([scope, reachesProduction(scope)]).toEqual([scope, false]);
    }
  });
  test("is configurable, and a regexp metacharacter in a scope is just a character", () => {
    const eu = ["prod-eu", "prod-us"];
    expect(reachesProduction("prod-*", eu)).toBe(true);
    expect(reachesProduction("production", eu)).toBe(false);
    expect(reachesProduction("prod.eu", ["prod-eu"])).toBe(false);
    expect(reachesProduction("(prod|x", ["prod"])).toBe(false);
    expect(
      checkItems([item("K", "prod-eu", true)], open, { off: [], production: eu }),
    ).toHaveLength(1);
  });
  test("stars in the middle and at the ends, repeated, and a pattern that cannot match", () => {
    for (const scope of ["**", "p**n", "*r*o*d*u*c*t*i*o*n*", "prod*uction", "*production*"]) {
      expect([scope, reachesProduction(scope, ["production"])]).toEqual([scope, true]);
    }
    for (const scope of ["prod*x", "*x*production", "pro*ion*x", "produ*ctionn", "*o*o*o"]) {
      expect([scope, reachesProduction(scope, ["production"])]).toEqual([scope, false]);
    }
  });
  test("the text before a star is not matched again after it", () => {
    expect(reachesProduction("ab*ba", ["aba"])).toBe(false);
    expect(reachesProduction("ab*ba", ["abba"])).toBe(true);
    expect(reachesProduction("ab*ba", ["abxba"])).toBe(true);
  });
  test("a scope of many stars is answered at once, whatever the names are", () => {
    const began = performance.now();
    expect(reachesProduction(`${"*a".repeat(64)}*x`, ["a".repeat(100)])).toBe(false);
    expect(reachesProduction(`${"*a".repeat(64)}*`, ["a".repeat(100)])).toBe(true);
    expect(performance.now() - began).toBeLessThan(1000);
  });
  test("with no production scope at all nothing is production", () => {
    expect(checkItems([item("K", "production", true)], open, { off: [], production: [] })).toEqual(
      [],
    );
  });
});

describe("what a violation holds", () => {
  test("names the rule, key and scope, never a value, and lists them in key and scope order", () => {
    const found = checkItems(
      [item("B", "prod", true), item("A", "production", true), item("A", "prod", true)],
      open,
    );
    expect(found.map((v) => [v.key, v.scope])).toEqual([
      ["A", "prod"],
      ["A", "production"],
      ["B", "prod"],
    ]);
    expect(JSON.stringify(found)).not.toContain("hunter2");
  });
  test("every rule has a description and is known by name", () => {
    for (const [name, text] of Object.entries(GUARDRAILS)) {
      expect(isGuardrailRule(name)).toBe(true);
      expect(text.length).toBeGreaterThan(10);
    }
    for (const name of ["", "toString", "__proto__", "production-secret"]) {
      expect(isGuardrailRule(name)).toBe(false);
    }
  });
});
