import { can, DomainError, type Logger } from "@orch/core";
import { checkSessionTtl, createSession, deleteSession, findSession, upsertUser } from "@orch/db";
import type { GithubOAuth } from "@orch/github";
import { GitlabError, type GitlabOAuth, pkceChallenge } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin, unauthenticated } from "../guard";
import type { OidcDeps } from "../oidc";
import { problem } from "../problem";
import { rateLimitPlugin } from "../rate-limit";
import type { Roles } from "../session";
import { hashToken, randomToken, safeEqual } from "../tokens";
import { problemSchema, type RouteDeps } from "./shared";

export interface AuthDeps {
  /** Sign in with GitLab. Left out, `/auth/login` answers 503 (sessions still work). */
  oauth?: GitlabOAuth;
  /** Sign in with GitHub (FRG-25). Needs `githubRoles` too: without both, `/auth/github/login` answers 503. */
  github?: GithubOAuth;
  /** What a GitHub account holds here, by its GitHub user id. A sign-in with no role is refused. */
  githubRoles?: (githubId: number) => Promise<Roles>;
  /** How long a session lasts, in total. Default 12 hours. */
  sessionTtlMs?: number;
  /** Cookies get `Secure`: set when the API is served over https. */
  secureCookies?: boolean;
  /** Where identity providers send the browser back to: `https://<host>/auth/sso/callback`. Left out, SSO sign-in answers 503. */
  ssoRedirectUri?: string;
  /** Test seams for talking to identity providers. */
  oidc?: OidcDeps;
  /** Test seam: milliseconds since the epoch. */
  now?: () => number;
}

export const SESSION_COOKIE = "orch_session";
const LOGIN_COOKIE = "orch_login";
const LOGIN_TTL_MS = 10 * 60_000;
export const DEFAULT_SESSION_TTL_MS = 12 * 3_600_000;
const GITLAB_DOWN = new Set(["server", "timeout", "network", "rate_limited"]);

/** A path on this site, nothing else: an absolute or protocol-relative URL would be an open redirect. */
export const safeReturnTo = (raw: string | undefined) =>
  raw && /^\/(?!\/)[\x21-\x7e]*$/.test(raw) && !raw.includes("\\") ? raw : "/";

/** The cookie and redirect answers every sign-in flow builds: HttpOnly, Lax, and Secure when served over https. */
export function cookieKit(secureCookies: boolean) {
  return {
    cookie: (name: string, value: string, maxAgeSeconds: number, path = "/") =>
      `${name}=${value}; Path=${path}; Max-Age=${Math.floor(maxAgeSeconds)}; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}`,
    respond(status: number, cookies: string[], location?: string) {
      const headers = new Headers({ "cache-control": "no-store" });
      if (location) headers.set("location", location);
      for (const c of cookies) headers.append("set-cookie", c);
      return new Response(null, { status, headers });
    },
  };
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || undefined;
  }
  return undefined;
}

/** The two flows' state travels in this cookie: the callback must come back to the same browser. */
const loginFlow = z.object({ s: z.string(), v: z.string(), r: z.string(), e: z.number() });

export const authRoutes = ({
  db,
  principal,
  logger,
  auth = {},
}: RouteDeps & { logger: Logger; auth?: AuthDeps }) => {
  const { oauth, sessionTtlMs = DEFAULT_SESSION_TTL_MS, secureCookies = false } = auth;
  const now = auth.now ?? Date.now;
  checkSessionTtl(sessionTtlMs);

  const { cookie, respond } = cookieKit(secureCookies);
  const clearLogin = cookie(LOGIN_COOKIE, "", 0, "/auth");
  const clearSession = cookie(SESSION_COOKIE, "", 0);

  return new Elysia({ prefix: "/auth" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .use(rateLimitPlugin)
    .get(
      "/login",
      ({ query }) => {
        if (!oauth)
          throw new DomainError("login_unavailable", 503, "GitLab sign-in is not configured");
        const [state, verifier] = [randomToken(), randomToken()];
        const flow = {
          s: state,
          v: verifier,
          r: safeReturnTo(query.return_to),
          e: now() + LOGIN_TTL_MS,
        };
        const value = Buffer.from(JSON.stringify(flow)).toString("base64url");
        return respond(
          302,
          [cookie(LOGIN_COOKIE, value, LOGIN_TTL_MS / 1000, "/auth")],
          oauth.authorizeUrl({ state, codeChallenge: pkceChallenge(verifier) }),
        );
      },
      {
        query: z.object({ return_to: z.string().max(500).optional() }),
        response: { 302: z.undefined(), 422: problemSchema, 503: problemSchema },
        public: "starts the sign-in: the caller has no session yet",
        limit: "login",
      },
    )
    .get(
      "/callback",
      async ({ query, request, set, audit }) => {
        if (!oauth)
          throw new DomainError("login_unavailable", 503, "GitLab sign-in is not configured");
        const bad = new DomainError(
          "invalid_login_state",
          400,
          "The sign-in is missing, invalid or expired. Start again.",
        );
        let flow: z.infer<typeof loginFlow>;
        try {
          const raw = readCookie(request, LOGIN_COOKIE) ?? "";
          flow = loginFlow.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
        } catch {
          throw bad;
        }
        if (flow.e < now() || !query.state || !safeEqual(flow.s, query.state)) throw bad;
        if (query.error || !query.code) {
          throw new DomainError("login_denied", 401, "GitLab sign-in was not completed");
        }

        let gitlabUser: Awaited<ReturnType<GitlabOAuth["currentUser"]>>;
        try {
          // The access token is used for this one lookup and dropped: nothing stores it.
          const token = await oauth.exchangeCode({ code: query.code, codeVerifier: flow.v });
          gitlabUser = await oauth.currentUser(token);
        } catch (error) {
          if (!(error instanceof GitlabError)) throw error;
          // A refused client secret is the deployment's fault, not the user's: make it loud.
          logger[error.kind === "unauthorized" ? "error" : "warn"]("gitlab sign-in failed", {
            request_id: set.headers["x-request-id"], // set by the `http` plugin
            kind: error.kind,
            error: error.message,
          });
          throw GITLAB_DOWN.has(error.kind)
            ? new DomainError("gitlab_unavailable", 502, "GitLab could not be reached. Try again.")
            : new DomainError("login_failed", 401, "GitLab did not accept the sign-in");
        }
        if (!gitlabUser.active) {
          throw new DomainError("account_inactive", 403, "This GitLab account is not active");
        }

        // A new token at every sign-in; the session this browser came with (if any) ends.
        const token = randomToken();
        const previous = readCookie(request, SESSION_COOKIE);
        await db.transaction(async (tx) => {
          const user = await upsertUser(tx, gitlabUser);
          await createSession(tx, {
            userId: user.id,
            tokenHash: hashToken(token),
            ttlMs: sessionTtlMs,
          });
          if (previous) await deleteSession(tx, hashToken(previous));
          await audit(
            tx,
            {
              action: "auth.login",
              resourceType: "user",
              resourceId: user.id,
              metadata: { gitlabId: user.gitlabId },
            },
            { kind: "user", id: user.id },
          );
        });
        return respond(
          302,
          [cookie(SESSION_COOKIE, token, sessionTtlMs / 1000), clearLogin],
          flow.r,
        );
      },
      {
        query: z.object({
          code: z.string().max(500).optional(),
          state: z.string().max(500).optional(),
          error: z.string().max(100).optional(),
        }),
        response: {
          302: z.undefined(),
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          422: problemSchema,
          502: problemSchema,
          503: problemSchema,
        },
        audit: "auth.login",
        public: "completes the sign-in: the caller has no session yet",
        limit: "login",
      },
    )
    .get(
      "/me",
      async ({ request, set, principal }) => {
        set.headers["cache-control"] = "no-store"; // per-user answer: no shared cache may keep it
        const token = readCookie(request, SESSION_COOKIE);
        const found = token ? await findSession(db, hashToken(token)) : undefined;
        if (!found) throw unauthenticated();
        const { user } = found;
        // What the guard of `organization.create` would say, for a screen that offers it (a hint: the guard decides).
        // Only when the caller is the person the cookie names: a bearer token of someone else says nothing about them.
        const platformAdmin =
          principal?.kind === "dev" ||
          (!!principal &&
            principal.userId === user.id &&
            can(principal.subject, "organization.create"));
        return {
          id: user.id,
          gitlabId: user.gitlabId,
          username: user.username,
          name: user.name,
          platformAdmin,
        };
      },
      {
        response: {
          200: z.object({
            id: z.uuid(),
            gitlabId: z.number().nullable(), // none for a person who signs in only through an identity provider
            username: z.string(),
            name: z.string(),
            platformAdmin: z.boolean(), // may create organizations
          }),
          401: problemSchema,
        },
        public: "answers 401 itself when the cookie holds no live session",
      },
    )
    .post(
      "/logout",
      async ({ request, set, audit }) => {
        const token = readCookie(request, SESSION_COOKIE);
        const ended = token
          ? await db.transaction(async (tx) => {
              const gone = await deleteSession(tx, hashToken(token));
              if (!gone) return false;
              await audit(
                tx,
                { action: "auth.logout", resourceType: "user", resourceId: gone.userId },
                { kind: "user", id: gone.userId },
              );
              return true;
            })
          : false;
        if (!ended) {
          // Nothing to end, but a dead cookie should not linger in the browser.
          const res = problem(
            401,
            "unauthenticated",
            String(set.headers["x-request-id"]),
            "Sign in first",
          );
          res.headers.append("set-cookie", clearSession);
          return res;
        }
        return respond(204, [clearSession]);
      },
      {
        response: { 204: z.undefined(), 401: problemSchema, 415: problemSchema },
        audit: "auth.logout",
        public: "ends the session in the cookie, or answers 401 itself and clears it",
      },
    );
};
