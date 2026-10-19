import { describe, expect, test } from "bun:test";
import { type RoleRule, roleFromClaims, roleMap } from "./sso";

const RULES: RoleRule[] = [
  { claim: "groups", value: "everyone", role: "viewer" },
  { claim: "groups", value: "platform", role: "admin" },
  { claim: "department", value: "finance", role: "member" },
  { claim: "level", value: "1", role: "owner" },
  { claim: "active", value: "true", role: "owner" },
];

describe("the role a provider's rules give a sign-in", () => {
  test("a claim equal to the value, or a list holding it, gives the role", () => {
    expect(roleFromClaims(RULES, { department: "finance" })).toBe("member");
    expect(roleFromClaims(RULES, { groups: ["x", "everyone"] })).toBe("viewer");
    expect(roleFromClaims(RULES, { level: "1" })).toBe("owner");
  });

  test("the highest role of all the rules that match wins, whatever their order", () => {
    const claims = { groups: ["everyone", "platform"], department: "finance" };
    expect(roleFromClaims(RULES, claims)).toBe("admin");
    expect(roleFromClaims([...RULES].reverse(), claims)).toBe("admin");
  });

  test("no matching rule gives nothing, and so does no rules at all", () => {
    expect(roleFromClaims(RULES, { groups: ["other"], department: "sales" })).toBeUndefined();
    expect(roleFromClaims(RULES, {})).toBeUndefined();
    expect(roleFromClaims([], { groups: ["platform"] })).toBeUndefined();
  });

  test("only an exact string matches: no part of a value, no pattern, no other type", () => {
    for (const claims of [
      { groups: "platform-admins" }, // longer
      { groups: "plat" }, // part of it
      { groups: ["PLATFORM"] }, // another case
      { groups: [" platform"] },
      { groups: "platform,everyone" }, // a joined list
      { groups: ["plat", "form"] },
      { groups: { platform: true } }, // an object
      { groups: [["platform"]] }, // a nested list
      { groups: 1 },
      { groups: true },
      { groups: null },
      { level: 1 }, // a number is not the string a rule names
      { active: true },
      { level: [1] },
    ]) {
      expect([claims, roleFromClaims(RULES, claims)]).toEqual([claims, undefined]);
    }
  });

  test("a claim that names a role grants nothing unless a rule says so", () => {
    for (const claims of [
      { role: "owner" },
      { roles: ["owner", "admin"] },
      { org_role: "owner" },
      { groups: ["owner"] },
      { admin: true },
    ]) {
      expect([claims, roleFromClaims(RULES, claims)]).toEqual([claims, undefined]);
    }
  });

  test("a name every object has is no claim, and grants nothing", () => {
    for (const claim of ["constructor", "toString", "__proto__"]) {
      expect(roleFromClaims([{ claim, value: "x", role: "owner" }], {})).toBeUndefined();
    }
  });
});

describe("the rules a provider may be given", () => {
  test("a claim and value named twice is refused, whatever the roles: one line says what it gives", () => {
    const rule = { claim: "groups", value: "ops", role: "member" } as const;
    expect(roleMap.safeParse([rule, { ...rule, claim: "team" }]).success).toBe(true);
    expect(roleMap.safeParse([rule, { ...rule, value: "dev" }]).success).toBe(true);
    expect(roleMap.safeParse([rule, rule]).success).toBe(false);
    expect(roleMap.safeParse([rule, { ...rule, role: "owner" }]).success).toBe(false);
  });
});
