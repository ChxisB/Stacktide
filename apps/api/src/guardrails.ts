import { DomainError } from "@orch/core";
import {
  DEFAULT_GUARDRAILS,
  GUARDRAILS,
  type GuardrailConfig,
  isGuardrailRule,
  type Violation,
} from "@orch/sync";
import { z } from "zod";

// A scope name is a literal: the patterns are the scopes of the variables, not these.
const SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const names = (list: string | undefined) =>
  (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/**
 * Settings of the built-in guardrails (POL-4), for the API and the worker alike. A rule that does not
 * exist is a boot error, so a typo cannot leave a rule on that was meant to be off, or the reverse.
 * shortcut: instance-wide, one setting for every organization; upgrade to a per-organization
 * setting (a table, an admin route, an audit event) when two organizations need different ones.
 */
export const guardrailEnv = {
  /** Rule ids to switch off, comma separated. */
  ORCH_GUARDRAILS_OFF: z
    .string()
    .optional()
    .refine((v) => names(v).every(isGuardrailRule), {
      error: `names a rule that does not exist (${Object.keys(GUARDRAILS).join(", ")})`,
    }),
  /** Scope names that mean production, comma separated; `production,prod` when left out. */
  ORCH_PRODUCTION_SCOPES: z
    .string()
    .optional()
    .refine((v) => names(v).every((s) => SCOPE_NAME.test(s)), {
      error: "is a comma separated list of environment scope names, without wildcards",
    }),
};

export const guardrailsOf = (config: {
  ORCH_GUARDRAILS_OFF?: string | undefined;
  ORCH_PRODUCTION_SCOPES?: string | undefined;
}): GuardrailConfig => {
  const production = names(config.ORCH_PRODUCTION_SCOPES);
  return {
    off: names(config.ORCH_GUARDRAILS_OFF).filter(isGuardrailRule),
    production: production.length > 0 ? production : DEFAULT_GUARDRAILS.production,
  };
};

/** The plan names this many violations, then counts the rest. */
const MAX_NAMED = 10;

/** What to do about a refusal, for the plan's and the pipeline's alike. */
export const WAY_OUT =
  "Set protected to true in the target's config, or switch the rule off (ORCH_GUARDRAILS_OFF).";

/** A refusal that names every rule that fired and where (a key and scope, never a value) and how to get past it. */
export function guardrailRefusal(what: string, violations: readonly Violation[]) {
  const rules = [...new Set(violations.map((v) => v.rule))];
  const where = violations
    .slice(0, MAX_NAMED)
    .map(
      (v) =>
        `${v.rule}: ${v.key === undefined ? `scope ${JSON.stringify(v.scope)}` : `${JSON.stringify(v.key)} (${v.scope})`}`,
    );
  const more = violations.length - where.length;
  return new DomainError(
    "guardrail_violation",
    422,
    `${what} breaks ${rules.length === 1 ? "a guardrail" : "guardrails"}: ${where.join("; ")}${more > 0 ? `; and ${more} more` : ""}. ${rules.map((r) => `${r} means ${GUARDRAILS[r]}`).join("; ")}. ${WAY_OUT}`,
  );
}
