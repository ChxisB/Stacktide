import { dotenvLine } from "@orch/core";
import { CliError } from "./cli";

export const FORMATS = ["dotenv", "json", "shell"] as const;
export type Format = (typeof FORMATS)[number];

export interface Pair {
  key: string;
  value: string;
}

/** The API's own rule for a variable name (`KEY_PATTERN` in core): what a shell may be handed unquoted. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

/** `export KEY='value'` for `eval`/`source`: single quotes keep everything literal, so only `'` is rewritten. */
const shellLine = ({ key, value }: Pair) => `export ${key}='${value.replaceAll("'", `'\\''`)}'`;

/**
 * The text of `pairs` in `format`, sorted by key so the same set always prints the same. NUL cannot
 * be held by a shell or an environment, so it is refused (naming the key) rather than silently cut.
 * Keys are checked against the API's own pattern (letters, digits, `_`), so they need no quoting.
 */
export function formatVariables(pairs: Pair[], format: Format): string {
  // `eval "$(orch export)"` runs this text: a name from a misbehaving server must not become a command
  if (pairs.some((p) => !KEY.test(p.key))) {
    throw new CliError("the API returned a name that is not a valid variable name");
  }
  const sorted = [...pairs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (format === "json") {
    // not an object literal: a key called `__proto__` must stay a key
    return JSON.stringify(
      Object.fromEntries(sorted.map(({ key, value }) => [key, value])),
      null,
      2,
    );
  }
  const bad = sorted.find((p) => p.value.includes("\0"));
  if (bad) throw new CliError(`${bad.key} holds a NUL character, which ${format} cannot carry`);
  return sorted.map(format === "dotenv" ? dotenvLine : shellLine).join("\n");
}
