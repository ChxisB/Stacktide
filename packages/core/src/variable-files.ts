import { KEY_PATTERN } from "./variables";

export interface ParsedEntry {
  key: string;
  value: string;
}

/** Why a line or entry was left out. Never carries text from the file, only where it was. */
export interface ParseIssue {
  reason: "syntax" | "bad_key" | "bad_value" | "unclosed_quote" | "duplicate";
  /** 1-based, for a `.env`, where the entry starts; for a `duplicate`, the entry that was overridden. Absent for JSON. */
  line?: number;
  /** Only a key that is valid (so it cannot hold anything but letters, digits and `_`). */
  key?: string;
}

export interface Parsed {
  entries: ParsedEntry[];
  issues: ParseIssue[];
}

const ASSIGN = /^\s*(?:export\s+)?([^=\s]+)\s*=\s*/;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

/** Where the quote `q` closes in `s` (a double quote skips `\"`), or -1. */
function closing(s: string, q: string): number {
  for (let i = 0; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") i++;
    else if (s[i] === q) return i;
  }
  return -1;
}

const expandEscapes = (s: string) => s.replace(/\\(.)/gs, (all, c: string) => ESCAPES[c] ?? all);

/**
 * Reads a `.env` file. Understood: blank lines, `#` comments (a whole line, or after whitespace
 * following an unquoted value), `export KEY=value`, spaces around `=`, `'single'` and `` `back` ``
 * quotes (literal), `"double"` quotes (`\n \r \t \" \\` are escapes, other backslashes stay), quoted
 * values over several lines, CRLF and a leading BOM (`\s` and `trim` already skip it). Nothing is expanded: `${X}` stays as written.
 * A line that is not understood is reported and skipped; a repeated key keeps the last value. Pure.
 */
export function parseDotenv(text: string): Parsed {
  const lines = text.split(/\r\n|\n|\r/);
  const found = new Map<string, { value: string; line: number }>();
  const issues: ParseIssue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const start = i;
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const m = ASSIGN.exec(raw);
    const key = m?.[1] ?? "";
    if (!m) {
      issues.push({ reason: "syntax", line: i + 1 });
      continue;
    }
    if (!KEY_PATTERN.test(key)) {
      issues.push({ reason: "bad_key", line: i + 1 });
      continue;
    }
    const rest = raw.slice(m[0].length);
    const quote = rest[0] ?? "";
    let value: string;
    if (quote === '"' || quote === "'" || quote === "`") {
      let body = "";
      let cur = rest.slice(1);
      let at = i;
      let end = closing(cur, quote);
      while (end < 0 && at + 1 < lines.length) {
        body += `${cur}\n`;
        cur = lines[++at] ?? "";
        end = closing(cur, quote);
      }
      if (end < 0) {
        issues.push({ reason: "unclosed_quote", line: i + 1 });
        continue;
      }
      body += cur.slice(0, end);
      const after = cur.slice(end + 1);
      i = at;
      if (!/^\s*(?:#.*)?$/.test(after)) {
        issues.push({ reason: "syntax", line: start + 1 });
        continue;
      }
      value = quote === '"' ? expandEscapes(body) : body;
    } else {
      value = rest.replace(/(?:^|\s)#.*$/, "").trim();
    }
    const earlier = found.get(key);
    if (earlier) issues.push({ reason: "duplicate", line: earlier.line, key });
    found.set(key, { value, line: start + 1 });
  }
  return { entries: [...found].map(([key, { value }]) => ({ key, value })), issues };
}

/**
 * Reads JSON: an object `{"KEY": "value"}` or a list `[{"key": "KEY", "value": "value"}]` (so
 * GitLab's own export reads too). Strings, numbers and booleans are taken as text; anything else
 * is reported. A malformed document is one `syntax` issue and no text of it. Pure.
 */
export function parseJsonVariables(text: string): Parsed {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { entries: [], issues: [{ reason: "syntax" }] };
  }
  const pairs: [unknown, unknown][] = [];
  const issues: ParseIssue[] = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object" && "key" in item && "value" in item) {
        pairs.push([item.key, item.value]);
      } else issues.push({ reason: "syntax" });
    }
  } else if (data && typeof data === "object") pairs.push(...Object.entries(data));
  else return { entries: [], issues: [{ reason: "syntax" }] };

  const found = new Map<string, string>();
  for (const [key, value] of pairs) {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      issues.push({ reason: "bad_key" });
    } else if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (found.has(key)) issues.push({ reason: "duplicate", key });
      found.set(key, String(value));
    } else issues.push({ reason: "bad_value", key });
  }
  return { entries: [...found].map(([key, value]) => ({ key, value })), issues };
}
