import { DomainError } from "@orch/core";
import {
  createApiToken,
  createCliLogin,
  findSession,
  revokeApiTokenById,
  takeCliLogin,
} from "@orch/db";
import { pkceChallenge } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin, unauthenticated } from "../guard";
import { hashToken, newApiToken, randomToken, safeEqual } from "../tokens";
import { readCookie, SESSION_COOKIE } from "./auth";
import { deleteResponses, iso, name, notFound, problemSchema, type RouteDeps } from "./shared";
import { createdSchema, DAY_MS, tokenDto } from "./tokens";

/** What a CLI signed in this way holds: the owner's permissions, for a month, never longer. */
const CLI_TOKEN_DAYS = 30;
const URL_SAFE = /^[A-Za-z0-9_-]+$/;

const loginQuery = z.object({
  /** Where the CLI listens on this machine. Unprivileged ports only. */
  port: z
    .string()
    .regex(/^\d{4,5}$/)
    .refine((p) => Number(p) >= 1024 && Number(p) <= 65535),
  /** Chosen by the CLI and returned untouched: ties the browser's answer to its own request. */
  state: z.string().min(16).max(128).regex(URL_SAFE),
  /** PKCE S256 challenge of a verifier only the CLI knows. */
  challenge: z.string().length(43).regex(URL_SAFE),
});
const exchange = z.strictObject({
  code: z.string().min(20).max(200),
  verifier: z.string().min(43).max(128).regex(URL_SAFE),
  name: name.optional(),
});

const bad = () =>
  new DomainError(
    "invalid_login_code",
    400,
    "The sign-in code is invalid, expired or already used. Start again.",
  );

/**
 * What `orch` needs of the API to sign in (CLI-2). The browser sign-in is the OAuth loopback
 * flow with PKCE (RFC 8252): the CLI listens on 127.0.0.1, sends the browser to `/auth/cli`,
 * and the browser comes back to the CLI with a one-time code that only the CLI's verifier can
 * turn into a token at `POST /auth/cli/token`. The token never travels through the browser.
 */
export const cliRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia()
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "/auth/whoami",
      ({ principal, set }) => {
        set.headers["cache-control"] = "no-store";
        if (!principal) throw unauthenticated();
        const subject = "subject" in principal ? principal.subject : undefined;
        return {
          kind: principal.kind,
          id: principal.id,
          scopes: subject?.scopes ? [...subject.scopes] : null,
          environmentId: subject?.environmentId ?? null,
        };
      },
      {
        response: {
          200: z.object({
            kind: z.string(),
            /** For an API token: the token's id (see `GET /tokens`), not the owner's. */
            id: z.string(),
            /** The scopes a token is limited to; null when there is no such limit. */
            scopes: z.array(z.string()).nullable(),
            environmentId: z.string().nullable(),
          }),
          401: problemSchema,
        },
        signedIn: "tells the caller who it is",
      },
    )
    .get(
      "/auth/cli",
      async ({ query, request }) => {
        const session = readCookie(request, SESSION_COOKIE);
        const found = session ? await findSession(db, hashToken(session)) : undefined;
        const headers = new Headers({ "cache-control": "no-store" });
        if (!found) {
          // Sign in first, then come back here.
          const back = `/auth/cli?${new URLSearchParams({ port: query.port, state: query.state, challenge: query.challenge })}`;
          headers.set("location", `/auth/login?${new URLSearchParams({ return_to: back })}`);
          return new Response(null, { status: 302, headers });
        }
        const code = randomToken();
        await createCliLogin(db, {
          userId: found.user.id,
          codeHash: hashToken(code),
          challenge: query.challenge,
        });
        headers.set(
          "location",
          `http://127.0.0.1:${Number(query.port)}/callback?${new URLSearchParams({ code, state: query.state })}`,
        );
        return new Response(null, { status: 302, headers });
      },
      {
        query: loginQuery,
        response: { 302: z.undefined(), 422: problemSchema },
        // No audit: minting a code changes nothing anyone can use; the exchange below is audited.
        public: "hands a signed-in browser's one-time code to the CLI; sends others to sign in",
      },
    )
    .post(
      "/auth/cli/token",
      async ({ body, audit, set }) => {
        // Taken before anything is checked: a wrong verifier burns the code.
        const login = await takeCliLogin(db, hashToken(body.code));
        if (!login || !safeEqual(login.challenge, pkceChallenge(body.verifier))) throw bad();
        const fresh = newApiToken();
        const row = await db.transaction(async (tx) => {
          const row = await createApiToken(tx, {
            userId: login.userId,
            name: body.name ?? "orch cli",
            prefix: fresh.prefix,
            tokenHash: fresh.tokenHash,
            scopes: ["*"],
            ttlMs: CLI_TOKEN_DAYS * DAY_MS,
          });
          await audit(
            tx,
            {
              action: "token.create",
              resourceType: "api_token",
              resourceId: row.id,
              metadata: {
                name: row.name,
                prefix: row.prefix,
                scopes: row.scopes,
                expiresAt: iso(row.expiresAt),
                via: "cli_login",
              },
            },
            { kind: "user", id: login.userId },
          );
          return row;
        });
        set.status = 201;
        set.headers["cache-control"] = "no-store";
        return { ...tokenDto(row), token: fresh.token };
      },
      {
        body: exchange,
        parse: "json",
        response: {
          201: createdSchema,
          400: problemSchema,
          415: problemSchema,
          422: problemSchema,
        },
        audit: "token.create",
        public: "the one-time code and its verifier are the credentials",
      },
    )
    .post(
      "/auth/cli/logout",
      async ({ principal, audit, set }) => {
        // `DELETE /tokens/:id` is for people; a token may only end itself.
        if (principal?.kind !== "token") {
          throw new DomainError("forbidden", 403, "Only an API token can sign itself out");
        }
        const tokenId = principal.id;
        await db.transaction(async (tx) => {
          const row = await revokeApiTokenById(tx, tokenId);
          if (!row) throw notFound("Token");
          await audit(tx, {
            action: "token.revoke",
            resourceType: "api_token",
            resourceId: row.id,
            metadata: { name: row.name, prefix: row.prefix, via: "cli_logout" },
          });
        });
        set.status = 204;
      },
      {
        response: deleteResponses,
        audit: "token.revoke",
        signedIn:
          "revokes the token the request was made with; the handler refuses any other caller",
      },
    );
