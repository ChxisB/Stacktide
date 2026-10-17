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
