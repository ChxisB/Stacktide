import { DomainError, type Logger } from "@orch/core";
import { createSession, deleteSession, signInGithub } from "@orch/db";
import { GitlabError, pkceChallenge } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
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
import { problemSchema, type RouteDeps } from "./shared";

const GITHUB_COOKIE = "orch_github";
const FLOW_TTL_MS = 10 * 60_000;
const GITHUB_DOWN = new Set(["server", "timeout", "network", "rate_limited"]);

/** What the browser carries between the start and the callback: it must come back to the same browser. */
const githubFlow = z.object({ s: z.string(), v: z.string(), r: z.string(), e: z.number() });

/**
 * Sign in with GitHub (FRG-25): authorization code + PKCE + `state`, scope `read:user`. The person is known by their
 * GitHub user id, never by login or email, and is never matched to an existing person. They get a session only if
 * they hold a role through a repository linked here (`auth.githubRoles`): a sign-in with none is refused and makes
 * nobody. The access token answers "who is this" once and is dropped.
 */
export const githubLoginRoutes = ({
  db,
  principal,
  logger,
  auth = {},
}: RouteDeps & { logger: Logger; auth?: AuthDeps }) => {
  const {
    github,
    githubRoles,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    secureCookies = false,
  } = auth;
  const now = auth.now ?? Date.now;
  const { cookie, respond } = cookieKit(secureCookies);
  const clearFlow = cookie(GITHUB_COOKIE, "", 0, "/auth");
  const unavailable = () =>
    new DomainError("login_unavailable", 503, "GitHub sign-in is not configured");

  return new Elysia({ prefix: "/auth/github" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .use(rateLimitPlugin)
    .get(
      "/login",
      ({ query }) => {
        if (!github || !githubRoles) throw unavailable();
        const [state, verifier] = [randomToken(), randomToken()];
        const flow = {
          s: state,
          v: verifier,
          r: safeReturnTo(query.return_to),
          e: now() + FLOW_TTL_MS,
        };
        return respond(
          302,
          [
            cookie(
              GITHUB_COOKIE,
              Buffer.from(JSON.stringify(flow)).toString("base64url"),
              FLOW_TTL_MS / 1000,
              "/auth",
            ),
          ],
          github.authorizeUrl({ state, codeChallenge: pkceChallenge(verifier) }),
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
        if (!github || !githubRoles) throw unavailable();
        const bad = new DomainError(
          "invalid_login_state",
          400,
          "The sign-in is missing, invalid or expired. Start again.",
        );
        let flow: z.infer<typeof githubFlow>;
        try {
          const raw = readCookie(request, GITHUB_COOKIE) ?? "";
          flow = githubFlow.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
        } catch {
          throw bad;
        }
        if (flow.e < now() || !query.state || !safeEqual(flow.s, query.state)) throw bad;
        if (query.error || !query.code) {
          throw new DomainError("login_denied", 401, "GitHub sign-in was not completed");
        }

        let who: Awaited<ReturnType<typeof github.currentUser>>;
        try {
          // The access token is used for this one lookup and dropped: nothing stores it.
          const token = await github.exchangeCode({ code: query.code, codeVerifier: flow.v });
          who = await github.currentUser(token);
        } catch (error) {
          if (!(error instanceof GitlabError)) throw error;
          // A refused client secret is the deployment's fault, not the user's: make it loud.
          logger[error.kind === "unauthorized" ? "error" : "warn"]("github sign-in failed", {
            request_id: set.headers["x-request-id"], // set by the `http` plugin
            kind: error.kind,
            error: error.message,
          });
          throw GITHUB_DOWN.has(error.kind)
            ? new DomainError("github_unavailable", 502, "GitHub could not be reached. Try again.")
            : new DomainError("login_failed", 401, "GitHub did not accept the sign-in");
        }

        // No role through any linked repository: nobody is made and no session is given.
        const held = await githubRoles(who.githubId);
        if (
          Object.keys(held.projectRoles).length === 0 &&
          Object.keys(held.orgRoles).length === 0
        ) {
          logger.warn("github sign-in refused", {
            request_id: set.headers["x-request-id"],
            github_id: who.githubId,
            reason: "no role in any linked repository",
          });
          throw new DomainError(
            "no_access",
            403,
            "This GitHub account has no access to any project here",
          );
        }

        // A new token at every sign-in; the session this browser came with (if any) ends.
        const token = randomToken();
        const previous = readCookie(request, SESSION_COOKIE);
        await db.transaction(async (tx) => {
          const user = await signInGithub(tx, who);
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
              metadata: { provider: "github", githubId: who.githubId },
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
          403: problemSchema,
          422: problemSchema,
          500: problemSchema,
          502: problemSchema,
          503: problemSchema,
        },
        audit: "auth.login",
        public: "completes the sign-in: the caller has no session yet",
        limit: "login",
      },
    );
};
