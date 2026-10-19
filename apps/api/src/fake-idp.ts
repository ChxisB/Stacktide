/** Test helper: an OIDC identity provider shaped like Keycloak (discovery, keys, authorize, token), on loopback. A code is spent once; tests bend it through the fields of the returned object. */
import { createHash } from "node:crypto";
import { makeKey, type Signer, sign } from "./jwt-testing";

export interface FakeIdp {
  /** `http://127.0.0.1:<port>/realms/acme` */
  issuer: string;
  origin: string;
  clientId: string;
  clientSecret: string;
  /** Every request the provider answered, as `METHOD path`. */
  requests: string[];
  /** What the token endpoint returned, for leak checks: the id_token and access token of each exchange. */
  issued: string[];
  /** Who signs in at the authorize step. */
  claims: Record<string, unknown>;
  /** Changes the claims of the next tokens (wrong audience, expired, …). */
  tamper: (claims: Record<string, unknown>, nonce: string) => Record<string, unknown>;
  /** Signs the tokens; swap in another key to forge them. */
  signer: Signer;
  /** Fields replaced in the discovery document. */
  discovery: Record<string, unknown>;
  /** Answer discovery with a redirect instead. */
  redirectDiscovery: boolean;
  /** Keys published beside the real one: they sign nothing, but they are in the set. */
  extraKeys: unknown[];
  /** The id_token of a code, as it was minted. */
  tokenOf: (code: string) => string | undefined;
  stop: () => void;
}

export async function fakeIdp(o: { clientId: string; clientSecret: string; redirectUri: string }) {
  const base = await makeKey("kc-1");
  const codes = new Map<string, { nonce: string; challenge: string }>();
  const minted = new Map<string, string>();
  const idp: FakeIdp = {
    issuer: "",
    origin: "",
    clientId: o.clientId,
    clientSecret: o.clientSecret,
    requests: [],
    issued: [],
    claims: {
      sub: "kc-user-1",
      email: "ada@acme.example",
      email_verified: true,
      preferred_username: "ada",
      name: "Ada Lovelace",
      groups: ["all"],
    },
    tamper: (c) => c,
    signer: base,
    discovery: {},
    redirectDiscovery: false,
    extraKeys: [],
    tokenOf: (code) => minted.get(code),
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      idp.requests.push(`${req.method} ${url.pathname}`);
      const realm = "/realms/acme";
      const json = (body: unknown, status = 200) => Response.json(body, { status });
      if (url.pathname === `${realm}/.well-known/openid-configuration`) {
        if (idp.redirectDiscovery) {
          return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/x" } });
        }
        return json({
          issuer: idp.issuer,
          authorization_endpoint: `${idp.issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${idp.issuer}/protocol/openid-connect/token`,
          jwks_uri: `${idp.issuer}/protocol/openid-connect/certs`,
          ...idp.discovery,
        });
      }
      if (url.pathname === `${realm}/protocol/openid-connect/certs`) {
        return json({ keys: [base.jwk, ...idp.extraKeys] }); // only the real key: a token signed by another one is a forgery
      }
      if (url.pathname === `${realm}/protocol/openid-connect/auth`) {
        const q = url.searchParams;
        const [state, nonce, challenge] = [q.get("state"), q.get("nonce"), q.get("code_challenge")];
        if (
          q.get("client_id") !== idp.clientId ||
          q.get("redirect_uri") !== o.redirectUri ||
          q.get("response_type") !== "code" ||
          q.get("code_challenge_method") !== "S256" ||
          !state ||
          !nonce ||
          !challenge ||
          !q.get("scope")?.split(" ").includes("openid")
        ) {
          return json({ error: "invalid_request" }, 400);
        }
        const code = `code-${crypto.randomUUID()}`;
        codes.set(code, { nonce, challenge });
        const back = new URL(o.redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", state);
        return new Response(null, { status: 302, headers: { location: back.href } });
      }
      if (url.pathname === `${realm}/protocol/openid-connect/token` && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const code = form.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code); // spent, whatever follows
        const fail = () => json({ error: "invalid_grant" }, 400);
        if (!pending || form.get("grant_type") !== "authorization_code") return fail();
        if (form.get("client_id") !== idp.clientId) return fail();
        if (form.get("client_secret") !== idp.clientSecret)
          return json({ error: "invalid_client" }, 401);
        if (form.get("redirect_uri") !== o.redirectUri) return fail();
        const verifier = form.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== pending.challenge) {
          return fail();
        }
        const now = Math.floor(Date.now() / 1000);
        const claims = idp.tamper(
          {
            iss: idp.issuer,
            aud: idp.clientId,
            iat: now,
            exp: now + 300,
            nonce: pending.nonce,
            ...idp.claims,
          },
          pending.nonce,
        );
        const idToken = await sign(idp.signer, claims);
        minted.set(code, idToken);
        const access = `at-${crypto.randomUUID()}`;
        idp.issued.push(idToken, access);
        return json({ access_token: access, id_token: idToken, token_type: "Bearer" });
      }
      return json({ error: "not_found" }, 404);
    },
  });
  idp.origin = `http://127.0.0.1:${server.port}`;
  idp.issuer = `${idp.origin}/realms/acme`;
  return idp;
}
