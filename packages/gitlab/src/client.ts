import type { Logger } from "@orch/core";
import { GitlabError, type GitlabErrorKind, kindOfStatus } from "./errors";

export interface GitlabAuth {
  /** `private-token`: personal, project and group access tokens. `oauth`: an OAuth access token. */
  type: "private-token" | "oauth";
  token: string;
}

export interface ClientOptions {
  /** Instance root, e.g. `https://gitlab.example.com` (a relative URL root path is kept). */
  baseUrl: string;
  auth: GitlabAuth;
  logger?: Logger;
  /** Per attempt, covers reading the body. */
  timeoutMs?: number;
  /** Extra attempts after the first. */
  maxRetries?: number;
  retryBaseMs?: number;
  /** A wait longer than this (Retry-After included) fails instead of blocking the caller. */
  maxRetryDelayMs?: number;
  /** Tokens would cross the network in cleartext: opt in per client. */
  allowInsecureHttp?: boolean;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

export interface GitlabClient {
  request<T = unknown>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  /** Yields every item of a list endpoint, following the `Link: rel="next"` header. */
  paginate<T = unknown>(path: string, query?: Query): AsyncGenerator<T, void, undefined>;
}

const REDACTED = "[REDACTED]";
const DETAIL_MAX = 200;
// Replaying these cannot apply the change twice. A replayed DELETE can still answer 404 for what
// the lost first attempt already removed: callers treat 404 on delete as "already gone".
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NEXT_LINK = /<([^>]+)>\s*;\s*rel="?next"?/i;

/** `Retry-After` is a delta in seconds on GitLab 429s; an HTTP date is accepted too. */
function retryAfterMs(headers: Headers): number | undefined {
  const v = headers.get("retry-after")?.trim();
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** GitLab's own short reason (`message` / `error`); anything else, HTML pages included, is dropped. */
function reasonOf(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const r = body.message ?? body.error;
    if (typeof r === "string") return r;
    if (r && typeof r === "object") return JSON.stringify(r);
  } catch {}
  return undefined;
}

/** Where a redirect points (origin and path only), so a wrong baseUrl is easy to spot. */
function redirectHint(location: string | null, from: string): string | undefined {
  if (!location) return undefined;
  try {
    const to = new URL(location, from);
    return `redirected to ${to.origin}${to.pathname}, check baseUrl`;
  } catch {
    return undefined;
  }
}

export function createGitlabClient(opts: ClientOptions): GitlabClient {
  const {
    auth,
    logger,
    timeoutMs = 15_000,
    maxRetries = 3,
    retryBaseMs = 500,
    maxRetryDelayMs = 30_000,
    sleep = Bun.sleep,
  } = opts;
  // Redaction is a substring replace: a very short token would mangle messages and hide little.
  if (auth.token.length < 8) throw new TypeError("GitLab token is missing or too short");

  // Never echo the input: it may carry credentials.
  let base: URL;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    throw new TypeError("GitLab baseUrl is not a valid URL");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    throw new TypeError("GitLab baseUrl must be an http(s) URL");
  }
  if (base.username || base.password) {
    throw new TypeError("GitLab baseUrl must not contain credentials");
  }
  if (base.protocol === "http:" && !opts.allowInsecureHttp && !LOOPBACK.has(base.hostname)) {
    throw new TypeError("GitLab baseUrl must use https (allowInsecureHttp overrides)");
  }
  const apiRoot = `${base.origin}${base.pathname.replace(/\/+$/, "")}/api/v4`;

  const scrub = (s: string) => s.replaceAll(auth.token, REDACTED);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "orch-control-plane",
    ...(auth.type === "oauth"
      ? { authorization: `Bearer ${auth.token}` }
      : { "private-token": auth.token }),
  };

  function urlFor(path: string, query?: Query): string {
    // Plain concatenation: `new URL("//host", base)` would change the host.
    if (!path.startsWith("/") || /[?#\\]|(^|\/)(\.|%2e){1,2}(\/|$)/i.test(path)) {
      throw new TypeError(
        "GitLab path must start with / and carry no query, fragment or dot segments",
      );
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const q = qs.toString();
    return `${apiRoot}${path}${q ? `?${q}` : ""}`;
  }

  function failure(
    kind: GitlabErrorKind,
    method: string,
    where: string,
    what: string,
    status?: number,
    wait?: number,
  ) {
    return new GitlabError(kind, scrub(`GitLab ${method} ${where} ${what}`), status, wait);
  }

  async function send(method: string, url: string, body?: unknown) {
    const where = new URL(url).pathname; // no query string: filters can be private
    for (let attempt = 0; ; attempt++) {
      let err: GitlabError;
      try {
        const res = await fetch(url, {
          method,
          headers:
            body === undefined ? headers : { ...headers, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual", // a custom auth header would follow a redirect to another host
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (res.ok) return { status: res.status, headers: res.headers, text };
        const reason =
          res.status >= 300 && res.status < 400
            ? redirectHint(res.headers.get("location"), url)
            : reasonOf(text)?.slice(0, DETAIL_MAX);
        err = failure(
          kindOfStatus(res.status),
          method,
          where,
          `failed (${res.status})${reason ? `: ${reason}` : ""}`,
          res.status,
          retryAfterMs(res.headers),
        );
      } catch (e) {
        const timedOut = e instanceof Error && e.name === "TimeoutError";
        const detail = !timedOut && e instanceof Error ? `: ${e.message.slice(0, DETAIL_MAX)}` : "";
        err = failure(
          timedOut ? "timeout" : "network",
          method,
          where,
          timedOut ? `timed out after ${timeoutMs}ms` : `request failed${detail}`,
        );
      }

      // A 429 was refused before it did anything, so any method may retry it.
      const retryable =
        err.kind === "rate_limited" ||
        (IDEMPOTENT.has(method) && ["server", "timeout", "network"].includes(err.kind));
      if (!retryable || attempt >= maxRetries) throw err;
      const wait =
        err.retryAfterMs ?? Math.round(retryBaseMs * 2 ** attempt * (0.5 + Math.random() / 2));
      if (wait > maxRetryDelayMs) throw err;
      logger?.warn("gitlab request retry", {
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
      throw failure(
        "unexpected",
        method,
        new URL(url).pathname,
        "returned a non-JSON response",
        r.status,
      );
    }
  };

  return {
    async request<T>(method: string, path: string, o: RequestOptions = {}) {
      const m = method.toUpperCase();
      const url = urlFor(path, o.query);
      return parse(m, url, await send(m, url, o.body)) as T;
    },

    async *paginate<T>(path: string, query: Query = {}) {
      let url = urlFor(path, { ...query, per_page: query.per_page ?? 100 });
      const seen = new Set<string>();
      while (true) {
        if (seen.has(url)) {
          throw failure("unexpected", "GET", new URL(url).pathname, "pagination did not advance");
        }
        seen.add(url);
        const res = await send("GET", url);
        const page = parse("GET", url, res);
        if (!Array.isArray(page)) {
          throw failure("unexpected", "GET", new URL(url).pathname, "did not return a list");
        }
        yield* page as T[];
        const next = NEXT_LINK.exec(res.headers.get("link") ?? "")?.[1];
        if (!next) return;
        // Keep path and query from GitLab, but always talk to the configured host.
        const n = new URL(next, apiRoot);
        if (!n.pathname.startsWith(`${new URL(apiRoot).pathname}/`)) {
          throw failure("unexpected", "GET", new URL(url).pathname, "pagination link left the API");
        }
        url = `${base.origin}${n.pathname}${n.search}`;
      }
    },
  };
}
