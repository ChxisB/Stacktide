import type { z } from "zod";

/**
 * Carries key names and a value-free reason ("missing" or the zod issue code) only.
 * Never the values, never the zod issues (which can echo input).
 */
export class ConfigError extends Error {
  constructor(readonly problems: Record<string, string>) {
    super(
      `Invalid environment configuration: ${Object.entries(problems)
        .map(([key, reason]) => `${key} (${reason})`)
        .join(", ")}`,
    );
    this.name = "ConfigError";
  }

  get keys(): string[] {
    return Object.keys(this.problems);
  }
}

export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const problems: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "(root)");
    problems[key] ??= env[key] === undefined ? "missing" : issue.code;
  }
  throw new ConfigError(problems);
}
