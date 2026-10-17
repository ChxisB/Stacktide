// Over-redacts on purpose (`monkey` matches `key`): a hidden field costs less than a leaked secret.
const SENSITIVE =
  /pass|pwd|token|secret|auth|cookie|value|key|credential|bearer|jwt|session|dsn|connection|signature|private/i;
const REDACTED = "[REDACTED]";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

// Secrets inside free text: URL userinfo, bearer tokens, sensitive query parameters.
const SCRUBBERS: [RegExp, string][] = [
  [/(\/\/)[^\s/@]+@/g, `$1${REDACTED}@`],
  [/\bBearer\s+[\w.~+/-]+=*/gi, `Bearer ${REDACTED}`],
  // Bounded {0,64} runs: unbounded ones backtrack quadratically on `?tokentokentoken...`.
  [/([?&;][\w.-]{0,64}(?:token|key|secret|pass|sig|auth)[\w.-]{0,64}=)[^&\s#]+/gi, `$1${REDACTED}`],
  // Tokens by shape (GitLab, GitHub, Slack, Stripe-style), AWS access key ids, JWTs.
  [
    /\b(?:gl(?:pat|ptt|dt|rt|cbt|oas|soat|ffct|imt|agent|ft|wt)|gh[pousr]|github_pat|xox[abprs]|sk|rk)[-_][\w-]{10,}/g,
    REDACTED,
  ],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, REDACTED],
  // Drizzle's "Failed query: ...\nparams: a,b,c" carries the bound values of the failed statement.
  [/(\bparams:[ \t]*)[^\n]*/gi, `$1${REDACTED}`],
  // `password=hunter2`, `"token": "x"`, `API_KEY: x`: the key names a secret, the value goes.
  [
    /(["']?[\w.-]{0,32}(?:token|secret|pass(?:word|wd|phrase)?|pwd|api[_-]?key|private[_-]?key|authorization|credential)[\w.-]{0,32}["']?\s{0,3}[:=]\s{0,3})("(?:[^"\\]|\\.){0,2048}"|'(?:[^'\\]|\\.){0,2048}'|[^\s,;&}"']{1,2048})/gi,
    `$1${REDACTED}`,
  ],
];

export type Level = keyof typeof LEVELS;

export interface Logger {
  debug(msg: string, fields?: object): void;
  info(msg: string, fields?: object): void;
  warn(msg: string, fields?: object): void;
  error(msg: string, fields?: object): void;
  child(bindings: object): Logger;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  level?: Level;
  bindings?: object;
}

/** Hides secrets in free text (error messages, URLs). Over-redacts rather than miss one. */
export const scrubText = (s: string) => SCRUBBERS.reduce((acc, [re, to]) => acc.replace(re, to), s);

/** Objects whose own enumerable props are not their useful content. */
function plain(o: object): object {
  if (o instanceof Error) {
    const { code } = o as { code?: unknown };
    return { name: o.name, message: o.message, stack: o.stack, code, cause: o.cause };
  }
  if (o instanceof Headers) return Object.fromEntries(o.entries());
  if (o instanceof Map) return Object.fromEntries(o);
  if (o instanceof Set) return [...o];
  return o;
}

function walk(input: unknown, path: Set<object>): unknown {
  if (typeof input === "string") return scrubText(input);
  if (typeof input === "bigint") return input.toString();
  if (typeof input !== "object" || input === null) return input;
  if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) return "[Binary]";
  if (input instanceof Date) return input.toJSON();
  if (input instanceof URL) return scrubText(input.href);
  if (path.has(input)) return "[Circular]";

  const value = plain(input);
  path.add(input);
  const out = Array.isArray(value)
    ? value.map((v) => walk(v, path))
    : Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? REDACTED : walk(v, path)]),
      );
  path.delete(input);
  return out;
}

/** Returns a JSON-safe copy with sensitive keys masked at any depth and secrets scrubbed from strings. */
export const redact = (input: unknown): unknown => walk(input, new Set());

export function createLogger(opts: LoggerOptions = {}): Logger {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  // Env-supplied levels can be anything; unknown must not silently enable debug.
  const min = LEVELS[opts.level ?? "info"] ?? LEVELS.info;
  const bindings = opts.bindings ?? {};

  const emit = (level: Level, msg: string, fields?: object) => {
    if (LEVELS[level] < min) return;
    let body: object;
    try {
      body = redact({ ...bindings, ...fields }) as object;
    } catch {
      body = { logError: "fields could not be serialised" };
    }
    // Built-in fields win over caller fields of the same name.
    write(JSON.stringify({ ...body, time: new Date().toISOString(), level, msg: scrubText(msg) }));
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (more) => createLogger({ ...opts, bindings: { ...bindings, ...more } }),
  };
}
