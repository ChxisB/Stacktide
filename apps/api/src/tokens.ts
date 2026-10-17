import { timingSafeEqual } from "node:crypto";

/** `bytes` of randomness as URL-safe text: session cookies, OAuth state and PKCE verifiers. */
export const randomToken = (bytes = 32) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

/** What is stored for a token: it has 256 bits of entropy, so a plain SHA-256 is enough. */
export const hashToken = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

/** Constant-time comparison of two strings (also when their lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const [x, y] = [hashToken(a), hashToken(b)];
  return timingSafeEqual(Buffer.from(x), Buffer.from(y));
}

const API_TOKEN = /^orch_[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{43}$/;

/** Does `value` have the shape of an API token? Anything else is not worth a database lookup. */
export const isApiToken = (value: string) => API_TOKEN.test(value);

/**
 * A new API token, `orch_<8 random chars>.<256 random bits>`: the plaintext (shown once), the
 * `prefix` lists show to recognise it, and the `tokenHash` that is stored.
 */
export function newApiToken() {
  const prefix = `orch_${randomToken(6)}`;
  const token = `${prefix}.${randomToken(32)}`;
  return { token, prefix, tokenHash: hashToken(token) };
}

const CI_TOKEN = /^orchci_[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{43}$/;

/** Does `value` have the shape of a CI token (see `newCiToken`)? It never matches an API token. */
export const isCiToken = (value: string) => CI_TOKEN.test(value);

/** A new CI token, `orchci_<8 random chars>.<256 random bits>`: the plaintext and the hash that is stored. */
export function newCiToken() {
  const token = `orchci_${randomToken(6)}.${randomToken(32)}`;
  return { token, tokenHash: hashToken(token) };
}
