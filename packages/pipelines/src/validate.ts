import type { Manifest } from "./manifest";

/** What GitLab's CI lint says of a pipeline (`api.ci.lint` of `@orch/gitlab` returns this and more). */
export interface LintVerdict {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
export type Lint = (content: string) => Promise<LintVerdict>;

export interface Validation {
  /** False for lint errors or a missing variable; warnings alone leave it true. */
  ok: boolean;
  lint: LintVerdict;
  /** Per environment, what the template requires and is not set there (environments missing nothing are left out). `null`: the project, for one that has no environments. */
  missingVariables: { environment: string | null; keys: string[] }[];
}

/**
 * Checks a rendered pipeline before it is proposed (PIPE-5): GitLab's lint on the text, and that
 * every variable the template requires is set in each environment it will run in. `variables` says
 * which names are set there (names only: this never sees a value).
 */
export async function validate(input: {
  manifest: Pick<Manifest, "requiresVariables">;
  text: string;
  lint: Lint;
  variables: { environment: string | null; keys: Iterable<string> }[];
}): Promise<Validation> {
  const { valid, errors, warnings } = await input.lint(input.text);
  const missingVariables = input.variables.flatMap(({ environment, keys }) => {
    const set = new Set(keys);
    const missing = [...new Set(input.manifest.requiresVariables)].filter((k) => !set.has(k));
    return missing.length > 0 ? [{ environment, keys: missing }] : [];
  });
  return {
    ok: valid && missingVariables.length === 0,
    lint: { valid, errors, warnings },
    missingVariables,
  };
}
