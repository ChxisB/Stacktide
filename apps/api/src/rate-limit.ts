import { isIP } from "node:net";
import { DomainError, type Logger } from "@orch/core";
import { Elysia } from "elysia";
import type { Principal } from "./principal";

/**
 * What a route may be asked, how often, by whom (OPS-5). A route says which class it is in its options
 * (`limit: "reveal"`), the way it says who may call it; `by: "ip"` classes count the client's address
 * (the caller has no identity yet), `by: "caller"` classes count the signed-in person or token.
 */
export const LIMITS = {
  /** Starting or finishing a sign-in, and trading a CLI code: the places to guess at. */
  login: { max: 30, windowMs: 5 * 60_000, by: "ip" },
  /** A CI job's token exchange: many jobs may share one runner address. */
  ci_exchange: { max: 600, windowMs: 60_000, by: "ip" },
  /** GitLab's webhook calls; the secret is checked after the count. */
  webhook: { max: 600, windowMs: 60_000, by: "ip" },
  token_create: { max: 10, windowMs: 10 * 60_000, by: "caller" },
  /** Reading a secret's value, or a whole environment's. */
  reveal: { max: 60, windowMs: 60_000, by: "caller" },
} as const satisfies Record<string, { max: number; windowMs: number; by: "ip" | "caller" }>;
export type LimitClass = keyof typeof LIMITS;

export interface RateLimiterOptions {
  /** Multiplies every `max` (at least 1 request is always allowed). */
  scale?: number;
  /** See `Hardening.proxyHops`. */
  proxyHops?: number;
  /** Most counters kept at once. */
  maxKeys?: number;
  now?: () => number;
  onLimited?: (cls: LimitClass) => void;
  /** Told once per cause when `X-Forwarded-For` cannot be used, which makes every client look like the proxy. Never carries an address. */
  warn?: (message: string) => void;
}

/** The address in an `X-Forwarded-For` entry: some proxies append a port (`1.2.3.4:5678`, `[2001:db8::1]:443`). */
function addressOf(entry: string) {
  const m =
    /^\[([^\]]+)\](?::\d{1,5})?$/.exec(entry) ?? /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(entry);
  const bare = m?.[1] ?? entry;
  return isIP(bare) ? bare : undefined;
}

/**
 * Counts requests per class and client in fixed windows, in this process.
 *
 * shortcut: the counters live in memory, so each replica counts alone and a restart forgets them; keep
 * them in Postgres when more than one API replica runs. An IPv6 client is counted per address, not per
 * /64. When `maxKeys` counters are live the oldest is dropped, which a flood from many addresses can use
 * to reset others' counts.
 */
export function createRateLimiter(options: RateLimiterOptions = {}) {
  const { scale = 1, proxyHops = 0, maxKeys = 10_000, now = Date.now, onLimited, warn } = options;
  const windows = new Map<string, { count: number; resetAt: number }>();
  let swept = 0;
  const warned = new Set<string>();
  const warnOnce = (cause: string, message: string) => {
    if (warned.has(cause)) return;
    warned.add(cause);
    warn?.(message);
  };

  /** The client's address: the peer, or the entry that the trusted proxy nearest to us appended. */
  const clientIp = (request: Request, peer: string | undefined) => {
    if (proxyHops > 0) {
      const chain = (request.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim());
      const entry = chain.length >= proxyHops ? chain[chain.length - proxyHops] : undefined;
      const address = entry === undefined ? undefined : addressOf(entry);
      if (address) return address;
      if (entry) {
        warnOnce(
          "unusable",
          "the X-Forwarded-For entry that ORCH_TRUSTED_PROXY_HOPS points at is not an address: clients are counted as the proxy",
        );
      }
    } else if (request.headers.has("x-forwarded-for")) {
      warnOnce(
        "ignored",
        "X-Forwarded-For is sent but ORCH_TRUSTED_PROXY_HOPS is 0: every client behind a proxy is counted as the proxy",
      );
    }
    return peer ?? "unknown";
  };

  /** Counts one request. Undefined when it may go on, else the seconds until the window ends. */
  const hit = (cls: LimitClass, who: string): number | undefined => {
    const { max, windowMs } = LIMITS[cls];
    const t = now();
    const key = `${cls}|${who}`;
    let w = windows.get(key);
    if (!w || w.resetAt <= t) {
      windows.delete(key);
      if (windows.size >= maxKeys) {
        if (t - swept >= 1000) {
          swept = t;
          for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
        }
        if (windows.size >= maxKeys) {
          for (const k of windows.keys()) {
            windows.delete(k);
            break;
          }
        }
      }
      w = { count: 0, resetAt: t + windowMs };
      windows.set(key, w);
    }
    w.count++;
    if (w.count <= Math.max(1, Math.floor(max * scale))) return undefined;
    onLimited?.(cls);
    return Math.max(1, Math.ceil((w.resetAt - t) / 1000));
  };

  return { clientIp, hit, size: () => windows.size };
}
export type RateLimiter = ReturnType<typeof createRateLimiter>;

interface Ctx {
  limits?: RateLimiter;
  request: Request;
  server?: { requestIP(request: Request): { address: string } | null } | null;
  principal?: Principal | undefined;
  set: { headers: Record<string, string | number | undefined> };
  log?: Logger;
}

/**
 * The `limit` route option. It needs the limiter that `createApp` decorates the app with, and fails the
 * request (500) rather than let it through if there is none.
 */
export const rateLimitPlugin = new Elysia({ name: "orch.rate-limit" })
  .macro({
    limit: (cls: LimitClass) => {
      if (!Object.hasOwn(LIMITS, cls)) throw new TypeError(`unknown rate limit class "${cls}"`);
      return {
        detail: { "x-rate-limit": cls } as object,
        // Not `beforeHandle`: that runs after validation. `principal` is derived before this.
        transform: (ctx: object) => {
          const { limits, request, server, principal, set, log } = ctx as Ctx;
          if (!limits) throw new TypeError("no rate limiter: createApp decorates the app with one");
          // The local-development stand-in is one trusted caller, not a client to count.
          if (principal?.kind === "dev") return;
          const ip = limits.clientIp(request, server?.requestIP(request)?.address);
          const who =
            LIMITS[cls].by === "caller" && principal
              ? `caller:${"userId" in principal && principal.userId ? principal.userId : principal.id}`
              : `ip:${ip}`;
          const wait = limits.hit(cls, who);
          if (wait === undefined) return;
          set.headers["retry-after"] = String(wait);
          log?.warn("rate limited", { limit: cls, by: LIMITS[cls].by });
          throw new DomainError("rate_limited", 429, "Too many requests, try again later");
        },
      };
    },
  })
  .as("scoped");
