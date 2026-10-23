// No imports: the web app loads this file on its own (`@orch/core/dotenv`), so it stays out of the
// rest of core's graph.

/** Values of this alphabet need no quotes in a `.env` file; the empty value is `KEY=`. */
const BARE = /^[A-Za-z0-9_@%+,./:-]*$/;

/**
 * One `KEY=value` line that `parseDotenv` (and the common dotenv readers) read back as `value`:
 * bare when that is safe, else single-quoted (literal), else double-quoted with `\\ \" \n \r` escaped.
 * `$` is never escaped: no escape for it exists in the dialect we read, so a reader that expands
 * `$VAR` in double quotes (docker compose) would; values with a `$` and no quote or newline are
 * single-quoted, which those readers keep literal. shortcut: written for dotenv-style readers (this CLI,
 * dotenv, compose); `docker run --env-file` and systemd keep quotes as part of the value, so for
 * them use `--format json` or `shell`.
 */
export function dotenvLine({ key, value }: { key: string; value: string }) {
  if (BARE.test(value)) return `${key}=${value}`;
  if (!/['\r\n]/.test(value)) return `${key}='${value}'`;
  const body = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
  return `${key}="${body}"`;
}
