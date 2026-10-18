import { byKeyThenScope } from "./ref";
import { ALL_SCOPES, type ItemInput, type ItemRef } from "./types";

/**
 * The built-in guardrails (POL-4): rules about what may be synced where, each with an id that a
 * violation names and a switch. They are pure: a rule looks at names, scopes and flags, never a value.
 */
export const GUARDRAILS = {
  "production-secret-protected":
    "a secret that reaches production is only synced to a target that protects its variables",
  "production-variable-protected":
    "a variable that reaches production is only synced to a target that protects its variables",
} as const;
export type GuardrailRule = keyof typeof GUARDRAILS;
export const isGuardrailRule = (name: string): name is GuardrailRule =>
  Object.hasOwn(GUARDRAILS, name);

export interface GuardrailConfig {
  /** Rules switched off: they find nothing. */
  readonly off: readonly GuardrailRule[];
  /** Scope names that mean production. A scope pattern that matches one of them reaches production. */
  readonly production: readonly string[];
}
export const DEFAULT_GUARDRAILS: GuardrailConfig = { off: [], production: ["production", "prod"] };

/** What a rule found: which, and where (a key's scope; a name and a scope, never a value). */
export interface Violation extends Partial<Pick<ItemRef, "key">> {
  rule: GuardrailRule;
  scope: string;
}

// GitLab's environment scope is a pattern in which `*` matches anything. Matched by hand, not with a
// regular expression: a scope is data a writer sets, and a pattern of many stars can make a regex backtrack for ever.
function matches(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (pattern[p] === "*") {
      star = p++;
      resume = n;
    } else if (p < pattern.length && pattern[p] === name[n]) {
      p++;
      n++;
    } else if (star >= 0) {
      p = star + 1;
      n = ++resume;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * Whether items in this scope are given to production jobs. A scope is a pattern (`prod*` reaches
 * `production`); a bare `*` is every environment, not production in particular, and is left to the
 * rules about every environment (there are none yet).
 */
export const reachesProduction = (scope: string, production = DEFAULT_GUARDRAILS.production) =>
  scope !== ALL_SCOPES && production.some((name) => matches(scope, name));

/**
 * What a plan for this target breaks: a secret or a variable in a production scope, on a target that
 * does not mark its variables protected, so that any job on any branch can read it. Ordered by key
 * and scope, so a plan names them the same way each time.
 */
export function checkItems(
  items: readonly Pick<ItemInput, "key" | "scope" | "secret">[],
  target: { protected: boolean },
  config: GuardrailConfig = DEFAULT_GUARDRAILS,
): Violation[] {
  if (target.protected) return [];
  const found: Violation[] = [];
  // a plan has many items and few scopes
  const reach = new Map<string, boolean>();
  for (const { key, scope, secret } of items) {
    let reaches = reach.get(scope);
    if (reaches === undefined) {
      reaches = reachesProduction(scope, config.production);
      reach.set(scope, reaches);
    }
    if (!reaches) continue;
    const rule = secret ? "production-secret-protected" : "production-variable-protected";
    if (!config.off.includes(rule)) found.push({ rule, key, scope });
  }
  return found.sort((a, b) =>
    byKeyThenScope({ key: a.key ?? "", scope: a.scope }, { key: b.key ?? "", scope: b.scope }),
  );
}

/**
 * The same rule for a scope alone, when no variable is at hand (a pipeline for an environment that
 * syncs to this scope): what is in it is not known, so the rule for variables stands for both.
 */
export function checkScope(
  scope: string,
  target: { protected: boolean },
  config: GuardrailConfig = DEFAULT_GUARDRAILS,
): Violation | undefined {
  const rule = "production-variable-protected";
  if (
    target.protected ||
    config.off.includes(rule) ||
    !reachesProduction(scope, config.production)
  ) {
    return undefined;
  }
  return { rule, scope };
}
