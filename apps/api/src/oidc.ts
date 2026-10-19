import { type RoleRule, roleFromClaims } from "@orch/core";
import type { Jwk } from "@orch/gitlab";
import { z } from "zod";
import { type IdClaims, IdTokenError, verifyIdToken } from "./id-token";
import { checkTarget, SinkFailure } from "./notify";
import { safeEqual } from "./tokens";

/**
 * Why an identity provider could not be used. A fixed sentence: it reaches the log, never a response, and carries no
 * address, code or token. `unavailable` is the provider's side being down or silent; anything else is a refusal.
 */
export class OidcError extends Error {
  override readonly name = "OidcError";
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message);
  }
}

export interface OidcDeps {
  /** Test seams: the network, and the rule an address must pass (default: `publicTarget`). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  check?: (raw: string) => Promise<URL>;
  resolve?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
}

/**
 * The address of a provider's endpoint, checked like a notification sink's (ADR-0016, decision 12): https, no
 * credentials, a public host, and every address its name resolves to is public.
 *
 * shortcut: the name is checked, then the fetch resolves it again, so an answer that changes in between
 * (rebinding) gets through, and a name that does not resolve is a refusal rather than an outage; pin the
 * checked address when the control plane can reach anything worth protecting from a hostile provider.
 */
export const publicTarget =
  (resolve?: (host: string) => Promise<string[]>) =>
  async (raw: string): Promise<URL> => {
    try {
      return (await checkTarget("webhook", raw, resolve)).target;
    } catch (error) {
      if (error instanceof SinkFailure) throw new OidcError("provider address is not allowed");
      throw error;
    }
  };

const MAX_BODY = 256 * 1024;

/** One JSON request to a provider. No redirect is followed, the answer is capped, and nothing of it is kept in an error. */
async function request(
  d: OidcDeps,
  raw: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<unknown> {
  const target = await (d.check ?? publicTarget(d.resolve))(raw);
  let status: number;
  let text: string;
  try {
    const res = await (d.fetch ?? fetch)(target.href, {
      ...init,
      headers: { accept: "application/json", ...init.headers },
      // a redirect could lead somewhere the check did not look at
      redirect: "manual",
      signal: AbortSignal.timeout(d.timeoutMs ?? 10_000),
    });
    status = res.status;
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new OidcError("provider answered with too much");
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError("provider could not be reached", true);
  }
  if (status >= 500) throw new OidcError(`provider answered ${status}`, true);
  if (status < 200 || status > 299) throw new OidcError(`provider answered ${status}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new OidcError("provider answered with something that is not JSON");
  }
}

const discoveryDocument = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
});

/**
 * The provider's endpoints from its discovery document. The document must name the configured issuer exactly:
 * one that names another cannot vouch for this provider. Every endpoint must pass the address rule before any
 * of them is used.
 */
export async function discover(d: OidcDeps, issuer: string) {
  const body = await request(d, `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  const doc = discoveryDocument.safeParse(body);
  if (!doc.success) throw new OidcError("discovery document is not usable");
  if (doc.data.issuer !== issuer) throw new OidcError("discovery document is for another issuer");
  const check = d.check ?? publicTarget(d.resolve);
  for (const url of [doc.data.authorization_endpoint, doc.data.token_endpoint, doc.data.jwks_uri]) {
    await check(url);
  }
  return {
    authorizationEndpoint: doc.data.authorization_endpoint,
    tokenEndpoint: doc.data.token_endpoint,
    jwksUri: doc.data.jwks_uri,
  };
}

/** Where the browser goes to sign in: authorization code flow with PKCE, `state` and `nonce`. */
export function authorizeUrl(
  endpoint: string,
  p: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  },
) {
  const url = new URL(endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", p.state);
  url.searchParams.set("nonce", p.nonce);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

const tokenResponse = z.object({ id_token: z.string().min(1) });

/** Trades the code for the `id_token`. The access token that comes with it is dropped: nothing here uses it. */
export async function exchangeCode(
  d: OidcDeps,
  tokenEndpoint: string,
  p: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  },
) {
  const body = await request(d, tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code_verifier: p.codeVerifier,
    }).toString(),
  });
  const parsed = tokenResponse.safeParse(body);
  if (!parsed.success) throw new OidcError("token response has no id_token");
  return parsed.data.id_token;
}

const keySet = z.object({ keys: z.array(z.unknown()) });
const rsaKey = z.object({
  kty: z.literal("RSA"),
  kid: z.string().min(1),
  n: z.string(),
  e: z.string(),
});

/** The provider's RSA signing keys. Anything else could not verify the RS256 tokens we accept, and is left out. */
export async function fetchKeys(d: OidcDeps, jwksUri: string): Promise<Jwk[]> {
  const parsed = keySet.safeParse(await request(d, jwksUri));
  if (!parsed.success) throw new OidcError("key set is not usable");
  return parsed.data.keys.flatMap((k) => {
    const r = rsaKey.safeParse(k);
    return r.success ? [{ kty: r.data.kty, kid: r.data.kid, n: r.data.n, e: r.data.e }] : [];
  });
}

const clip = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined;

/**
 * Checks an `id_token` for this provider and says who it is. On top of the signature, issuer, audience and expiry
 * (`verifyIdToken`): the `nonce` of this sign-in, the client as the only audience (or `azp` when there are
 * several), a `sub` of the length the standard allows, and an `email` the provider says it verified at one of the
 * organization's domains (the whole domain, in any case). `role` is what the provider's role map gives these claims,
 * or nothing: the caller refuses a sign-in with none.
 */
export async function verifySignIn(
  provider: {
    issuer: string;
    clientId: string;
    emailDomains: readonly string[];
    roleMap: readonly RoleRule[];
  },
  idToken: string,
  o: { nonce: string; key: (kid: string) => Promise<Jwk | undefined>; now?: () => number },
) {
  let claims: IdClaims;
  try {
    claims = await verifyIdToken(idToken, {
      key: o.key,
      issuer: provider.issuer,
      audience: provider.clientId,
      ...(o.now && { now: o.now }),
    });
  } catch (error) {
    if (error instanceof IdTokenError) throw new OidcError(`id_token refused: ${error.reason}`);
    throw error;
  }
  const { aud, azp, nonce, email, email_verified: verified } = claims;
  const several = Array.isArray(aud) && aud.length > 1;
  if ((several || azp !== undefined) && azp !== provider.clientId) {
    throw new OidcError("id_token is not for this client alone");
  }
  if (typeof nonce !== "string" || !safeEqual(nonce, o.nonce)) {
    throw new OidcError("id_token nonce does not match");
  }
  if (claims.sub.length > 255) throw new OidcError("id_token sub is too long");
  if (typeof email !== "string" || verified !== true) {
    throw new OidcError("id_token has no verified email");
  }
  const parts = /^([^@\s]+)@([^@\s]+)$/.exec(email);
  const domain = parts?.[2]?.toLowerCase();
  if (!parts || !domain || !provider.emailDomains.some((d) => d.toLowerCase() === domain)) {
    throw new OidcError("email domain is not allowed");
  }
  const username = clip(claims.preferred_username) ?? clip(parts[1]) ?? claims.sub.slice(0, 200);
  return {
    subject: claims.sub,
    email,
    username,
    name: clip(claims.name) ?? username,
    role: roleFromClaims(provider.roleMap, claims),
  };
}
