import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  createSession,
  deleteSession,
  endSsoMembership,
  findSession,
  getSsoProviderById,
  getSsoProviderBySlug,
  linkSsoIdentity,
  openSsoSecret,
  setSsoMembership,
  signInSso,
} from "@orch/db";
import { pkceChallenge } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin, unauthenticated } from "../guard";
import { keyCache } from "../id-token";
import {
  authorizeUrl,
  discover,
  exchangeCode,
  fetchKeys,
  type OidcDeps,
  OidcError,
  verifySignIn,
} from "../oidc";
import { rateLimitPlugin } from "../rate-limit";
import { hashToken, randomToken, safeEqual } from "../tokens";
import {
  type AuthDeps,
  cookieKit,
  DEFAULT_SESSION_TTL_MS,
  readCookie,
  SESSION_COOKIE,
  safeReturnTo,
} from "./auth";
import { notFound, problemSchema, type RouteDeps } from "./shared";

const SSO_COOKIE = "orch_sso";
const FLOW_TTL_MS = 10 * 60_000;

/** What the browser carries between the start and the callback: it must come back to the same browser, and the provider's tokens are checked against it. */
const ssoFlow = z.object({
  s: z.string(),
  v: z.string(),
  n: z.string(),
  r: z.string(),
  p: z.uuid(),
  e: z.number(),
  /** Set for a link (SSO-7): the person who started it, who must still hold that session at the callback. */
  l: z.uuid().optional(),
});

/**
 * Sign in through an organization's identity provider (SSO-3, ADR-0016): authorization code with PKCE, `state` and
 * `nonce`, the `id_token` checked against the provider's own keys. The person gets a session like a GitLab sign-in
 * gets one. Roles come from the provider's role map (SSO-4): each sign-in replaces the person's role in the
 * organization with what the map gives the token's claims, for as long as the session lasts. A sign-in the map gives
 * no role to is refused, and ends the role an earlier sign-in gave.
 *
 * `POST /:slug/link` (SSO-7) adds the provider's identity to the person who is signed in instead of signing anyone in:
 * it needs their live session when it starts and the same session when it ends, and it never matches by email. It is
 * a POST so that no other site can start it in a signed-in person's browser (the session cookie is Lax): whoever runs
 * a provider can sign in as everyone linked to it, so a link must be that person's own act.
 */
export const ssoLoginRoutes = ({
  db,
  principal,
  logger,
  keys,
  auth = {},
}: RouteDeps & { logger: Logger; keys?: KeyProvider; auth?: AuthDeps }) => {
  const { ssoRedirectUri, sessionTtlMs = DEFAULT_SESSION_TTL_MS, secureCookies = false } = auth;
  const now = auth.now ?? Date.now;
  const oidc: OidcDeps = auth.oidc ?? {};
  const { cookie, respond } = cookieKit(secureCookies);
  const clearFlow = cookie(SSO_COOKIE, "", 0, "/auth");

  // One key cache per key set, so a busy provider is not asked for its keys at every sign-in.
  const keySets = new Map<string, ReturnType<typeof keyCache>>();
  const keysOf = (jwksUri: string) => {
    let set = keySets.get(jwksUri);
    if (!set) {
      set = keyCache({ fetch: () => fetchKeys(oidc, jwksUri), now });
      keySets.set(jwksUri, set);
    }
    return set;
  };

  /** Logs why, with no address, code or token in it, and answers with one of two sentences. */
  function fail(error: unknown, providerId: string, requestId: unknown): never {
    if (!(error instanceof OidcError)) throw error;
    logger.warn("sso sign-in refused", {
      request_id: requestId,
      provider_id: providerId,
      reason: error.message,
    });
    throw error.unavailable
      ? new DomainError(
          "idp_unavailable",
          502,
          "The identity provider could not be reached. Try again.",
        )
      : new DomainError("login_failed", 401, "The identity provider did not accept the sign-in");
  }
  const unavailable = () =>
    new DomainError("login_unavailable", 503, "Single sign-on is not configured");
  const sessionOf = async (request: Request) => {
    const token = readCookie(request, SESSION_COOKIE);
    return token ? findSession(db, hashToken(token)) : undefined;
  };

  /**
   * The provider's authorize address and the flow cookie for it. `linking` is the person who asked to add the
   * provider's identity to themselves; nobody else begins a link, and no organization, no provider and a disabled
   * one look the same, so a caller learns nothing about which exist.
   */
  async function begin(
    slug: string,
    returnTo: string | undefined,
    linking: string | undefined,
    requestId: unknown,
  ) {
    if (!ssoRedirectUri) throw unavailable();
    const provider = await getSsoProviderBySlug(db, slug);
    if (!provider?.enabled) throw notFound("Single sign-on");
    const found = await discover(oidc, provider.issuer).catch((e) =>
      fail(e, provider.id, requestId),
    );
    const [state, verifier, nonce] = [randomToken(), randomToken(), randomToken()];
    const flow = {
      s: state,
      v: verifier,
      n: nonce,
      r: safeReturnTo(returnTo),
      p: provider.id,
      e: now() + FLOW_TTL_MS,
      ...(linking && { l: linking }),
    };
    return {
      flowCookie: cookie(
        SSO_COOKIE,
        Buffer.from(JSON.stringify(flow)).toString("base64url"),
        FLOW_TTL_MS / 1000,
        "/auth",
      ),
      location: authorizeUrl(found.authorizationEndpoint, {
        clientId: provider.clientId,
        redirectUri: ssoRedirectUri,
        state,
        nonce,
        codeChallenge: pkceChallenge(verifier),
      }),
    };
  }

  return new Elysia({ prefix: "/auth/sso" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .use(rateLimitPlugin)
    .get(
      "/:slug/login",
      async ({ params, query, set }) => {
        const { flowCookie, location } = await begin(
          params.slug,
          query.return_to,
          undefined,
          set.headers["x-request-id"],
        );
        return respond(302, [flowCookie], location);
      },
      {
        params: z.object({ slug: z.string().max(63) }),
        query: z.object({ return_to: z.string().max(500).optional() }),
        response: {
          302: z.undefined(),
          404: problemSchema,
          422: problemSchema,
          502: problemSchema,
          503: problemSchema,
        },
        public: "starts the sign-in: the caller has no session yet",
        limit: "login",
      },
    )
    .post(
      "/:slug/link",
      async ({ params, query, request, set }) => {
        // Only a POST: another site can make a signed-in browser send a GET (the session cookie is Lax), never a POST.
        const user = (await sessionOf(request))?.user.id;
        if (!user) throw unauthenticated();
        const { flowCookie, location } = await begin(
          params.slug,
          query.return_to,
          user,
          set.headers["x-request-id"],
        );
        return new Response(JSON.stringify({ location }), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "set-cookie": flowCookie,
          },
        });
      },
      {
        params: z.object({ slug: z.string().max(63) }),
        query: z.object({ return_to: z.string().max(500).optional() }),
        response: {
          200: z.object({ location: z.string() }),
          401: problemSchema,
          404: problemSchema,
          415: problemSchema,
          422: problemSchema,
          502: problemSchema,
          503: problemSchema,
        },
        public: "starts a link: answers 401 itself unless the cookie holds a live session",
        noAudit:
          "changes nothing: the link is written as identity.link when the callback completes it",
        limit: "login",
      },
    )
    .get(
      "/callback",
      async ({ query, request, set, audit }) => {
        if (!ssoRedirectUri || !keys) throw unavailable();
        const bad = new DomainError(
          "invalid_login_state",
          400,
          "The sign-in is missing, invalid or expired. Start again.",
        );
        let flow: z.infer<typeof ssoFlow>;
        try {
          const raw = readCookie(request, SSO_COOKIE) ?? "";
          flow = ssoFlow.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
        } catch {
          throw bad;
        }
        if (flow.e < now() || !query.state || !safeEqual(flow.s, query.state)) throw bad;
        // A link goes to the person who started it, and only while they still hold that session.
        if (flow.l && (await sessionOf(request))?.user.id !== flow.l) throw bad;
        if (query.error || !query.code) {
          throw new DomainError(
            "login_denied",
            401,
            "The identity provider sign-in was not completed",
          );
        }

        // Read again now: a provider turned off while the person was signing in signs nobody in.
        const provider = await getSsoProviderById(db, flow.p);
        if (!provider?.enabled) throw notFound("Single sign-on");
        const requestId = set.headers["x-request-id"]; // set by the `http` plugin
        let who: Awaited<ReturnType<typeof verifySignIn>>;
        try {
          const secret = await openSsoSecret(db, keys, provider.id);
          if (secret === undefined) throw notFound("Single sign-on");
          const found = await discover(oidc, provider.issuer);
          const idToken = await exchangeCode(oidc, found.tokenEndpoint, {
            clientId: provider.clientId,
            clientSecret: secret,
            redirectUri: ssoRedirectUri,
            code: query.code,
            codeVerifier: flow.v,
          });
          who = await verifySignIn(provider, idToken, {
            nonce: flow.n,
            key: keysOf(found.jwksUri),
            now,
          });
        } catch (error) {
          fail(error, provider.id, requestId);
        }

        const { role, ...person } = who;
        if (!role) {
          // Nobody holds a role here on this sign-in's word: refuse, and end what an earlier one gave (no person is made).
          await db.transaction(async (tx) => {
            const userId = await endSsoMembership(tx, provider.id, person.subject);
            if (userId) {
              await audit(
                tx,
                {
                  action: "sso.membership.end",
                  resourceType: "user",
                  resourceId: userId,
                  organizationId: provider.organizationId,
                  metadata: { ssoProviderId: provider.id },
                },
                { kind: "user", id: userId },
              );
            }
          });
          fail(new OidcError("id_token has no role in this organization"), provider.id, requestId);
        }

        const linkTo = flow.l;
        if (linkTo) {
          await db.transaction(async (tx) => {
            if ((await linkSsoIdentity(tx, linkTo, provider.id, person)) === "taken") {
              throw new DomainError(
                "identity_taken",
                409,
                "This sign-in already belongs to another person",
              );
            }
            await setSsoMembership(tx, linkTo, provider.id, role, sessionTtlMs);
            await audit(
              tx,
              {
                action: "identity.link",
                resourceType: "user",
                resourceId: linkTo,
                organizationId: provider.organizationId,
                metadata: { ssoProviderId: provider.id, role },
              },
              { kind: "user", id: linkTo },
            );
          });
          return respond(302, [clearFlow], flow.r); // their session is the one they came with
        }

        // A new token at every sign-in; the session this browser came with (if any) ends.
        const token = randomToken();
        const previous = readCookie(request, SESSION_COOKIE);
        await db.transaction(async (tx) => {
          const user = await signInSso(tx, provider.id, person);
          await createSession(tx, {
            userId: user.id,
            tokenHash: hashToken(token),
            ttlMs: sessionTtlMs,
          });
          await setSsoMembership(tx, user.id, provider.id, role, sessionTtlMs);
          if (previous) await deleteSession(tx, hashToken(previous));
          await audit(
            tx,
            {
              action: "auth.login",
              resourceType: "user",
              resourceId: user.id,
              organizationId: provider.organizationId,
              metadata: { provider: "sso", ssoProviderId: provider.id, role },
            },
            { kind: "user", id: user.id },
          );
        });
        return respond(
          302,
          [cookie(SESSION_COOKIE, token, sessionTtlMs / 1000), clearFlow],
          flow.r,
        );
      },
      {
        query: z.object({
          code: z.string().max(2000).optional(),
          state: z.string().max(500).optional(),
          error: z.string().max(100).optional(),
        }),
        response: {
          302: z.undefined(),
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
          409: problemSchema,
          422: problemSchema,
          502: problemSchema,
          503: problemSchema,
        },
        audit: ["auth.login", "sso.membership.end", "identity.link"],
        public: "completes the sign-in: the caller has no session yet",
        limit: "login",
      },
    );
};
