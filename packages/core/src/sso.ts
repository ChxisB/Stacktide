import { z } from "zod";
import { ORG_ROLES, type OrgRole } from "./authz";

/**
 * One line of an identity provider's role map (SSO-4): the sign-in gets `role` when its `id_token`'s top-level
 * `claim` equals `value`, or is a list holding it. Nothing else grants a role.
 */
export const roleRule = z.strictObject({
  claim: z.string().min(1).max(100),
  value: z.string().min(1).max(200),
  role: z.enum(ORG_ROLES),
});
export type RoleRule = z.infer<typeof roleRule>;

/** Rules a provider may have: every sign-in is checked against all of them. */
export const MAX_ROLE_RULES = 50;
export const roleMap = z
  .array(roleRule)
  .max(MAX_ROLE_RULES)
  .refine(
    (rules) => new Set(rules.map((r) => JSON.stringify([r.claim, r.value]))).size === rules.length,
    "a claim and value may appear in one rule only",
  );

/**
 * The role a sign-in gets: the highest of the rules that match its claims, or nothing (and then it is refused). A
 * claim matches only as an exact string, or a list holding that string; nothing is a pattern, a part of a value or
 * a nested name, and a claim that merely says "owner" grants nothing unless a rule maps it.
 */
export function roleFromClaims(
  rules: readonly RoleRule[],
  claims: Readonly<Record<string, unknown>>,
): OrgRole | undefined {
  let best = -1;
  for (const r of rules) {
    const held = claims[r.claim];
    if (Array.isArray(held) ? held.includes(r.value) : held === r.value) {
      best = Math.max(best, ORG_ROLES.indexOf(r.role));
    }
  }
  return ORG_ROLES[best];
}
