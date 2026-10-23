import type { Logger } from "@orch/core";
import { GitlabError, type GitlabErrorKind, kindOfStatus, parseBaseUrl } from "@orch/gitlab";

// shortcut: failures are `GitlabError` (its kinds are the forge's: ADR-0019 keeps one error type until a caller moves,
// FRG-15), and the few helpers below (`redactor`, `readCapped`, `reasonOf`) are copies of `@orch/gitlab`'s client.
// Upgrade: lift both into one shared HTTP core when a third forge or a fix needed in both arrives.

/** The API version every request asks for; GitHub keeps an old one working, so a change here is a decision. */
export const API_VERSION = "2022-11-28";
const DOTCOM_API = "https://api.github.com";
/** What GitHub's secondary limits ask for when they say nothing else ("at least one minute"). */
export const DEFAULT_LIMIT_WAIT_MS = 60_000;

export interface ClientOptions {
  /**
   * The web address of the GitHub: `https://github.com` (the default, API at `api.github.com`) or a GitHub
   * Enterprise Server (`https://ghe.example.com`, API under `/api/v3`).
   * shortcut: GitHub Enterprise Cloud with data residency (`api.<name>.ghe.com`) is not covered; give its API host
   * as `baseUrl` and the path is wrong, so it is refused by the first call. Upgrade when a customer has one.
   */
  baseUrl?: string;
  /** A personal access token (classic or fine-grained) or an installation token. */
  token: string;
  logger?: Logger;
  /** Per attempt, covers reading the body. */
  timeoutMs?: number;
  /** Extra attempts after the first. */
  maxRetries?: number;
  retryBaseMs?: number;
  /** A wait longer than this (`retry-after` included) fails instead of blocking the caller. */
  maxRetryDelayMs?: number;
  /** Tokens would cross the network in cleartext: opt in per client. */
  allowInsecureHttp?: boolean;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** A media type other than GitHub's JSON, e.g. `application/vnd.github.raw+json` for a file's own bytes. */
  accept?: string;
  /**
   * Values in the body that are secrets: scrubbed from any error text, in case GitHub echoes them.
   * Values shorter than 4 characters are ignored (replacing them would mangle the message).
   */
  redact?: string[];
}

export interface GithubClient {
  request<T = unknown>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  /**
   * Yields every item of a list endpoint, following the `Link: rel="next"` header. A list that GitHub wraps
   * in an object (`{ total_count, workflow_runs: [...] }`) names the key as `items`.
   */
  paginate<T = unknown>(
    path: string,
    query?: Query,
    items?: string,
  ): AsyncGenerator<T, void, undefined>;
  /** A GET answered with a file, as text and not parsed; `maxBytes` as in `@orch/gitlab`'s `download`. */
  download(
    path: string,
    o: { maxBytes: number; accept?: string },
  ): Promise<{ text: string } | { tooLarge: true }>;
}

/** The root of the REST API for a web address: `github.com` is served from `api.github.com`, any other host under `/api/v3`. */
export function apiRootOf(baseUrl = "https://github.com", allowInsecureHttp = false): string {
  const base = parseBaseUrl(baseUrl, allowInsecureHttp, "GitHub");
  if (base.hostname === "github.com" || base.hostname === "api.github.com") return DOTCOM_API;
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}/api/v3`;
}

const REDACTED = "[REDACTED]";
const DETAIL_MAX = 200;
// Replaying these cannot apply the change twice (as in the GitLab client).
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const NEXT_LINK = /<([^>]+)>\s*;\s*rel="?next"?/i;
const count = (v: string | null) =>
  v !== null && /^\d{1,15}$/.test(v.trim()) ? Number(v) : undefined;

/**
 * Whether a refusal means "slow down". GitHub sends 429, or 403 with `retry-after` (secondary limits) or with the
 * hourly allowance used up (`x-ratelimit-remaining: 0`); a plain 403 is a permission.
 */
function isLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  return (
    status === 403 &&
    (headers.has("retry-after") || headers.get("x-ratelimit-remaining")?.trim() === "0")
  );
}

/**
 * How long GitHub asks to wait: `retry-after` (seconds, or an HTTP date), else until `x-ratelimit-reset` (epoch
 * seconds) when the allowance is used up, else the minute its documentation names.
 */
function limitWaitMs(headers: Headers, now: number): number {
  const v = headers.get("retry-after")?.trim();
  if (v) {
    const secs = Number(v);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const at = Date.parse(v);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = count(headers.get("x-ratelimit-reset"));
  if (reset !== undefined && headers.get("x-ratelimit-remaining")?.trim() === "0") {
    return Math.max(0, reset * 1000 - now);
  }
  return DEFAULT_LIMIT_WAIT_MS;
}

/** GitHub's own short reason (`message`); anything else, HTML pages included, is dropped. */
function reasonOf(text: string): string | undefined {
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    return typeof m === "string" ? m : undefined;
  } catch {}
  return undefined;
}

/** Hides every secret (and its JSON-escaped spelling) in one pass, longest first. */
function redactor(secrets: string[]): (s: string) => string {
  const spellings = secrets.flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]);
  const list = [...new Set(spellings)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (list.length === 0) return (s) => s;
  const re = new RegExp(list.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (s) => s.replace(re, REDACTED);
}

/** Where a redirect points (origin and path only). GitHub answers 301 for a repository that was renamed or moved. */
function redirectHint(location: string | null, from: string): string | undefined {
  if (!location) return undefined;
  try {
    const to = new URL(location, from);
    return `redirected to ${to.origin}${to.pathname}`;
  } catch {
    return undefined;
  }
}

/** The body as text, read no further than `max` bytes; undefined when it is longer. */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const declared = count(res.headers.get("content-length"));
  if (declared !== undefined && declared > max) {
    await res.body?.cancel();
    return undefined;
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function createGithubClient(opts: ClientOptions): GithubClient {
  const {
    token,
    logger,
    timeoutMs = 15_000,
    maxRetries = 3,
    retryBaseMs = 500,
    maxRetryDelayMs = 30_000,
    sleep = Bun.sleep,
    now = Date.now,
  } = opts;
  // Redaction is a substring replace: a very short token would mangle messages and hide little.
  if (token.length < 8) throw new TypeError("GitHub token is missing or too short");

  const apiRoot = apiRootOf(opts.baseUrl, opts.allowInsecureHttp);
  const apiOrigin = new URL(apiRoot).origin;
  const apiPath = new URL(apiRoot).pathname.replace(/\/+$/, "");

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": API_VERSION,
    "user-agent": "orch-control-plane", // GitHub refuses a request with none
    authorization: `Bearer ${token}`,
  };

  function urlFor(path: string, query?: Query): string {
    // Plain concatenation: `new URL("//host", base)` would change the host.
    if (!path.startsWith("/") || /[?#\\]|(^|\/)(\.|%2e){1,2}(\/|$)/i.test(path)) {
      throw new TypeError(
        "GitHub path must start with / and carry no query, fragment or dot segments",
      );
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const q = qs.toString();
    return `${apiRoot}${path}${q ? `?${q}` : ""}`;
  }

  const scrub = redactor([token]);
  // The path as the caller wrote it: messages and logs do not repeat the API root (`/api/v3` on an Enterprise Server).
  const whereOf = (url: string) => new URL(url).pathname.slice(apiPath.length);

  function failure(
    kind: GitlabErrorKind,
    method: string,
    where: string,
    what: string,
    status?: number,
    wait?: number,
  ) {
    return new GitlabError(kind, scrub(`GitHub ${method} ${where} ${what}`), status, wait);
  }

  async function send(
    method: string,
    url: string,
    o: { body?: unknown; redact?: string[]; maxBytes?: number; accept?: string } = {},
  ) {
    // Only GitHub's own words are scrubbed (before truncation, so a cut value cannot slip through).
    const hide = redactor([token, ...(o.redact ?? []).filter((v) => v.length >= 4)]);
    const where = whereOf(url); // no query string: filters can be private
    const sent = {
      ...headers,
      ...(o.accept ? { accept: o.accept } : {}),
      ...(o.body === undefined ? {} : { "content-type": "application/json" }),
    };
    for (let attempt = 0; ; attempt++) {
      let err: GitlabError;
      try {
        const res = await fetch(url, {
          method,
          headers: sent,
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
          redirect: "manual", // the authorization header would follow a redirect to another host
          signal: AbortSignal.timeout(timeoutMs),
        });
        // only an answer that is the file is capped: a failure's body is read as ever
        const text =
          res.ok && o.maxBytes !== undefined ? await readCapped(res, o.maxBytes) : await res.text();
        if (res.ok) {
          return {
            status: res.status,
            headers: res.headers,
            text: text ?? "",
            tooLarge: text === undefined,
          };
        }
        const said =
          res.status >= 300 && res.status < 400
            ? redirectHint(res.headers.get("location"), url)
            : reasonOf(text ?? "");
        const reason = said === undefined ? undefined : hide(said).slice(0, DETAIL_MAX);
        const limited = isLimited(res.status, res.headers);
        err = failure(
          limited ? "rate_limited" : kindOfStatus(res.status),
          method,
          where,
          `failed (${res.status})${reason ? `: ${reason}` : ""}`,
          res.status,
          limited ? limitWaitMs(res.headers, now()) : undefined,
        );
      } catch (e) {
        const timedOut = e instanceof Error && e.name === "TimeoutError";
        const detail =
          !timedOut && e instanceof Error ? `: ${hide(e.message).slice(0, DETAIL_MAX)}` : "";
        err = failure(
          timedOut ? "timeout" : "network",
          method,
          where,
          timedOut ? `timed out after ${timeoutMs}ms` : `request failed${detail}`,
        );
      }

      // A refused-for-limit request did nothing, so any method may retry it.
      const retryable =
        err.kind === "rate_limited" ||
        (IDEMPOTENT.has(method) && ["server", "timeout", "network"].includes(err.kind));
      if (!retryable || attempt >= maxRetries) throw err;
      const wait =
        err.retryAfterMs ?? Math.round(retryBaseMs * 2 ** attempt * (0.5 + Math.random() / 2));
      if (wait > maxRetryDelayMs) throw err;
      logger?.warn("github request retry", {
        method,
        path: where,
        status: err.status,
        kind: err.kind,
        attempt: attempt + 1,
        wait_ms: wait,
      });
      await sleep(wait);
    }
  }

  const parse = (method: string, url: string, r: { status: number; text: string }): unknown => {
    if (!r.text) return undefined;
    try {
      return JSON.parse(r.text);
    } catch {
      throw failure("unexpected", method, whereOf(url), "returned a non-JSON response", r.status);
    }
  };

  return {
    async request<T>(method: string, path: string, o: RequestOptions = {}) {
      const m = method.toUpperCase();
      const url = urlFor(path, o.query);
      return parse(m, url, await send(m, url, o)) as T;
    },

    async download(path: string, o: { maxBytes: number; accept?: string }) {
      const r = await send("GET", urlFor(path), o);
      return r.tooLarge ? { tooLarge: true as const } : { text: r.text };
    },

    async *paginate<T>(path: string, query: Query = {}, items?: string) {
      let url = urlFor(path, { ...query, per_page: query.per_page ?? 100 });
      const seen = new Set<string>();
      while (true) {
        const here = whereOf(url);
        if (seen.has(url)) throw failure("unexpected", "GET", here, "pagination did not advance");
        seen.add(url);
        const res = await send("GET", url);
        const body = parse("GET", url, res);
        const page = items === undefined ? body : (body as Record<string, unknown> | null)?.[items];
        if (!Array.isArray(page)) {
          throw failure("unexpected", "GET", here, "did not return a list");
        }
        yield* page as T[];
        const next = NEXT_LINK.exec(res.headers.get("link") ?? "")?.[1];
        if (!next) return;
        // Keep path and query from GitHub, but always talk to the configured host.
        const n = new URL(next, apiRoot);
        if (!n.pathname.startsWith(`${apiPath}/`)) {
          throw failure("unexpected", "GET", here, "pagination link left the API");
        }
        url = `${apiOrigin}${n.pathname}${n.search}`;
      }
    },
  };
}
