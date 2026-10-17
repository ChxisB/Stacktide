/** Test helpers: RSA keys and RS256 JWTs signed locally, standing in for GitLab's job tokens. */
import type { Jwk } from "@orch/gitlab";

export const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function makeKey(kid: string, modulusLength = 2048) {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const { n, e } = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as {
    n: string;
    e: string;
  };
  return { kid, privateKey: pair.privateKey, jwk: { kty: "RSA", kid, n, e } as Jwk };
}
export type Signer = Awaited<ReturnType<typeof makeKey>>;

export async function sign(
  signer: Signer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
) {
  const head = b64({ alg: "RS256", typ: "JWT", kid: signer.kid, ...header });
  const body = b64(claims);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signer.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${Buffer.from(sig).toString("base64url")}`;
}
