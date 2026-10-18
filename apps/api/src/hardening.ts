import { z } from "zod";

const MIB = 1024 * 1024;

/**
 * The edge of the API (OPS-5). Nothing here is on by choice except the origin list: the headers, the body
 * cap and the rate limits apply to every instance.
 */
export interface Hardening {
  /** Origins (`https://app.example.com`, no path) whose pages may call the API with the session cookie. None by default: same origin only. */
  corsOrigins: readonly string[];
  /** The largest request body in bytes; a bigger one is refused with 413 before it is read. */
  maxBodyBytes: number;
  /** Send `Strict-Transport-Security`: the API is served over https. */
  hsts: boolean;
  /** Reverse proxies in front of the API that each append the client's address to `X-Forwarded-For`. 0: the peer is the client. */
  proxyHops: number;
  /** Multiplies every rate limit (see `rate-limit.ts`). */
  rateLimitScale: number;
}

export const HARDENING_DEFAULTS: Hardening = {
  corsOrigins: [],
  maxBodyBytes: 2 * MIB,
  hsts: false,
  proxyHops: 0,
  rateLimitScale: 1,
};

/** A body of 1 MiB is a legitimate request (a plan summary, a webhook): the cap may not go below it. */
const MIN_BODY_BYTES = MIB;

export function parseOrigins(list: string): string[] {
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const url = URL.canParse(raw) ? new URL(raw) : undefined;
      if (!url || !["http:", "https:"].includes(url.protocol) || url.origin !== raw) {
        throw new Error(
          `"${raw}" is not an origin (like https://app.example.com: no path, no slash)`,
        );
      }
      return raw;
    });
}

export const hardeningEnv = {
  /** Origins that may call the API from a browser, comma separated. Left out: none. */
  ORCH_CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v, ctx) => {
      try {
        return parseOrigins(v);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "invalid",
        });
        return z.NEVER;
      }
    }),
  ORCH_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(MIN_BODY_BYTES)
    .max(64 * MIB)
    .default(HARDENING_DEFAULTS.maxBodyBytes),
  ORCH_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  ORCH_RATE_LIMIT_SCALE: z.coerce.number().min(0.1).max(100).default(1),
};

export const hardeningOf = (
  c: {
    ORCH_CORS_ORIGINS: string[];
    ORCH_MAX_BODY_BYTES: number;
    ORCH_TRUSTED_PROXY_HOPS: number;
    ORCH_RATE_LIMIT_SCALE: number;
  },
  https: boolean,
): Hardening => ({
  corsOrigins: c.ORCH_CORS_ORIGINS,
  maxBodyBytes: c.ORCH_MAX_BODY_BYTES,
  hsts: https,
  proxyHops: c.ORCH_TRUSTED_PROXY_HOPS,
  rateLimitScale: c.ORCH_RATE_LIMIT_SCALE,
});

/** On every response. The API answers JSON only, so nothing may be loaded, framed or sniffed from it, and nothing cached. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-store",
};

const HSTS = "max-age=31536000; includeSubDomains";
const PREFLIGHT_METHODS = "GET, POST, PUT, PATCH, DELETE";
const PREFLIGHT_HEADERS = "content-type, authorization, x-request-id";

/** The headers every response carries, given the page that asked (`Origin`). */
export function edgeHeaders(h: Hardening, origin: string | null): Record<string, string> {
  const out: Record<string, string> = { ...SECURITY_HEADERS };
  if (h.hsts) out["strict-transport-security"] = HSTS;
  if (h.corsOrigins.length > 0) {
    out.vary = "Origin";
    if (origin !== null && h.corsOrigins.includes(origin)) {
      out["access-control-allow-origin"] = origin;
      out["access-control-allow-credentials"] = "true";
      out["access-control-expose-headers"] = "x-request-id, retry-after";
    }
  }
  return out;
}

/**
 * The answer to a CORS preflight from a listed origin. Any other preflight is not answered here: it gets
 * the 404 of an unknown route, with no `Access-Control-Allow-Origin`, and the browser refuses the call.
 */
export function preflightAnswer(h: Hardening, request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (
    request.method !== "OPTIONS" ||
    origin === null ||
    !h.corsOrigins.includes(origin) ||
    !request.headers.has("access-control-request-method")
  ) {
    return undefined;
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...edgeHeaders(h, origin),
      "access-control-allow-methods": PREFLIGHT_METHODS,
      "access-control-allow-headers": PREFLIGHT_HEADERS,
      "access-control-max-age": "600",
    },
  });
}

/** Whether the declared length of a body is over the cap. A body that does not declare one is the server's to stop (`maxRequestBodySize`). */
export function declaredTooLarge(h: Hardening, request: Request) {
  const length = request.headers.get("content-length");
  return length !== null && /^\d+$/.test(length) && Number(length) > h.maxBodyBytes;
}
