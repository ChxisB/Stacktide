import type { Jwk } from "@orch/gitlab";

/** Why an `id_token` was refused. For the log only: callers get one answer for every reason. */
export type IdTokenReason =
  | "malformed"
  | "algorithm"
  | "unknown_key"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "not_yet_valid"
  | "claims";

export class IdTokenError extends Error {
  override readonly name = "IdTokenError";
  constructor(readonly reason: IdTokenReason) {
    super(`id_token refused: ${reason}`); // never carries the token
  }
}

/** The claims of a GitLab job `id_token` that this API reads. Everything else is ignored. */
export type IdClaims = Record<string, unknown> & { sub: string; exp: number };

export interface VerifyOptions {
  /** The key with this `kid`, or nothing. Throws when the keys cannot be had (fail closed). */
  key: (kid: string) => Promise<Jwk | undefined>;
  issuer: string;
  audience: string;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Clock skew allowed on `exp` and `nbf`. Default 30 seconds. */
  leewaySeconds?: number;
}

const MAX_LENGTH = 8192;
const MIN_MODULUS_BYTES = 256; // RSA 2048
const SEGMENT = /^[A-Za-z0-9_-]+$/;

const decodeJson = (segment: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {}
  throw new IdTokenError("malformed");
};

/**
 * Verifies a GitLab job `id_token` (RS256 JWT): the signature against the key named by `kid`, then
 * `iss`, `aud`, `exp` and `nbf`. The algorithm is fixed to RS256 and only RSA keys are imported,
 * so a token cannot pick its own (`none`, or HS256 keyed with the public key). Returns the claims.
 */
export async function verifyIdToken(token: string, options: VerifyOptions): Promise<IdClaims> {
  const { key, issuer, audience, now = Date.now, leewaySeconds = 30 } = options;
  const parts = token.split(".");
  if (token.length > MAX_LENGTH || parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) {
    throw new IdTokenError("malformed");
  }
  const [head, body, sig] = parts as [string, string, string];
  const header = decodeJson(head);
  if (header.alg !== "RS256") throw new IdTokenError("algorithm");
  if (typeof header.kid !== "string" || !header.kid) throw new IdTokenError("unknown_key");
  const jwk = await key(header.kid);
  if (jwk?.kty !== "RSA" || Buffer.from(jwk.n, "base64url").length < MIN_MODULUS_BYTES) {
    throw new IdTokenError("unknown_key");
  }

  let ok: boolean;
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Buffer.from(sig, "base64url"),
      new TextEncoder().encode(`${head}.${body}`),
    );
  } catch {
    throw new IdTokenError("signature"); // a key that cannot be imported verifies nothing
  }
  if (!ok) throw new IdTokenError("signature");

  const claims = decodeJson(body);
  if (claims.iss !== issuer) throw new IdTokenError("issuer");
  const aud = claims.aud;
  if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) {
    throw new IdTokenError("audience");
  }
  const seconds = now() / 1000;
  const { exp, nbf, sub } = claims;
  // A token that does not expire is not one to trust.
  if (typeof exp !== "number" || !Number.isFinite(exp)) throw new IdTokenError("claims");
  if (exp + leewaySeconds <= seconds) throw new IdTokenError("expired");
  if (nbf !== undefined) {
    if (typeof nbf !== "number" || !Number.isFinite(nbf)) throw new IdTokenError("claims");
    if (nbf - leewaySeconds > seconds) throw new IdTokenError("not_yet_valid");
  }
  if (typeof sub !== "string" || !sub) throw new IdTokenError("claims");
  return { ...claims, sub, exp };
}

/**
 * The `iss` a token claims, **unverified**: only for choosing whose keys to check it with, from the
 * addresses connections registered. Never a URL to call, and never trusted until `verifyIdToken` has
 * checked the signature and that the signed `iss` is the same.
 */
export function peekIssuer(token: string): string | undefined {
  const body = token.split(".")[1];
  if (!body || token.split(".").length !== 3 || !SEGMENT.test(body)) return undefined;
  try {
    const iss = decodeJson(body).iss;
    return typeof iss === "string" && iss ? iss : undefined;
  } catch {
    return undefined;
  }
}

export interface KeyCacheOptions {
  /** Fetches the keys GitLab publishes. */
  fetch: () => Promise<readonly Jwk[]>;
  /** How long a fetched set is used. Default 10 minutes. */
  ttlMs?: number;
  /** The least time between two fetches, so unknown `kid`s cannot hammer GitLab. Default 1 minute. */
  minRefetchMs?: number;
  now?: () => number;
}

/**
 * The signing keys by `kid`, fetched on first use and kept for `ttlMs`. A `kid` that is not in
 * the set (GitLab rotated its keys) triggers one refetch, at most once per `minRefetchMs`. A
 * failed fetch throws, and so does every request for the next `minRefetchMs` (GitLab is not
 * asked again meanwhile); an expired set is never used in its place. Callers at the same moment
 * share one fetch.
 */
export function keyCache({
  fetch,
  ttlMs = 600_000,
  minRefetchMs = 60_000,
  now = Date.now,
}: KeyCacheOptions) {
  let keys = new Map<string, Jwk>();
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | undefined;
  let failure: { at: number; error: unknown } | undefined;

  const refresh = () => {
    if (failure && now() - failure.at < minRefetchMs) return Promise.reject(failure.error);
    inflight ??= (async () => {
      try {
        const list = await fetch();
        keys = new Map(list.map((k) => [k.kid, k]));
        fetchedAt = now();
      } catch (error) {
        failure = { at: now(), error };
        throw error;
      }
    })().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  return async (kid: string): Promise<Jwk | undefined> => {
    const age = now() - fetchedAt;
    if (age >= ttlMs) {
      await refresh();
    } else if (!keys.has(kid) && age >= minRefetchMs) {
      await refresh();
    }
    return keys.get(kid);
  };
}
