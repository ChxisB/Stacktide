import {
  DomainError,
  type ImportEntry,
  KEY_PATTERN,
  type ParseIssue,
  parseDotenv,
  parseJsonVariables,
} from "@orch/core";
import type { Gitlab } from "@orch/gitlab";

/** More than this in one import is refused: each entry is a transaction step and a row in the answer. */
export const MAX_IMPORT_ENTRIES = 1000;

/** What was left out and why: a line or a key, never a value. */
export interface Skipped {
  reason: ParseIssue["reason"] | "hidden" | "other_scope";
  key?: string;
  line?: number;
}

/** The flags GitLab keeps on a variable: noted in the report, not carried over. */
export interface GitlabFlags {
  masked: boolean;
  protected: boolean;
}

export interface Gathered {
  entries: ImportEntry[];
  skipped: Skipped[];
  flags: Map<string, GitlabFlags>;
}

const tooMany = () =>
  new DomainError(
    "too_many_entries",
    422,
    `An import takes at most ${MAX_IMPORT_ENTRIES} variables and as many problems: split it`,
  );

/** Entries the variables accept (value and description); the others are skipped by key. */
function usable(entries: ImportEntry[], accept: (entry: ImportEntry) => boolean) {
  const skipped: Skipped[] = [];
  const kept = entries.filter((e) => {
    const fine = accept(e);
    if (!fine) skipped.push({ reason: "bad_value", key: e.key });
    return fine;
  });
  return { kept, skipped };
}

/** A `.env` or JSON text, every entry of it given `kind`. */
export function fromFile(
  source: "dotenv" | "json",
  content: string,
  kind: ImportEntry["kind"],
  accept: (entry: ImportEntry) => boolean,
): Gathered {
  const parsed = source === "dotenv" ? parseDotenv(content) : parseJsonVariables(content);
  // A file of nothing but junk lines would otherwise be answered with a line per junk line.
  if (Math.max(parsed.entries.length, parsed.issues.length) > MAX_IMPORT_ENTRIES) throw tooMany();
  const { kept, skipped } = usable(
    parsed.entries.map((e) => ({ ...e, kind })),
    accept,
  );
  return { entries: kept, skipped: [...parsed.issues, ...skipped], flags: new Map() };
}

/**
 * The variables of a GitLab project that apply to `scope` (`*`, or an environment's name), as
 * `secret` (a `file` stays a `file`): GitLab shows them to maintainers only and this platform shows
 * `plain` values to every reader, so nothing is made `plain` on a guess. Other scopes, hidden
 * variables (their value cannot be read) and anything this platform cannot hold are skipped.
 */
export async function fromGitlab(
  api: Gitlab,
  gitlabProjectId: number,
  scope: string,
  accept: (entry: ImportEntry) => boolean,
): Promise<Gathered> {
  const skipped: Skipped[] = [];
  const flags = new Map<string, GitlabFlags>();
  const entries: ImportEntry[] = [];
  for await (const v of api.variables.list({ project: gitlabProjectId })) {
    if (v.scope !== scope) skipped.push({ reason: "other_scope", key: v.key });
    else if (v.hidden || v.value === null) skipped.push({ reason: "hidden", key: v.key });
    else if (!KEY_PATTERN.test(v.key)) skipped.push({ reason: "bad_key", key: v.key });
    else {
      flags.set(v.key, { masked: v.masked, protected: v.protected });
      entries.push({
        key: v.key,
        kind: v.type === "file" ? "file" : "secret",
        value: v.value,
        description: v.description ?? "",
      });
      // Counted when kept: variables of other scopes are not part of this import.
      if (entries.length > MAX_IMPORT_ENTRIES) throw tooMany();
    }
  }
  const { kept, skipped: unusable } = usable(entries, accept);
  return { entries: kept, skipped: [...skipped, ...unusable], flags };
}
