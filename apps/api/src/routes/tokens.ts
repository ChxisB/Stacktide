import { DomainError, isScope } from "@orch/core";
import {
  type ApiToken,
  createApiToken,
  listApiTokens,
  MAX_TOKEN_TTL_DAYS,
  revokeApiToken,
} from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import type { Principal } from "../principal";
import { newApiToken } from "../tokens";
import {
  deleteResponses,
  iso,
  name,
  notFound,
  paged,
  pageOf,
  pageQuery,
  type RouteDeps,
  readErrors,
  writeErrors,
} from "./shared";

const DAY_MS = 86_400_000;

const stamp = z.iso.datetime();
const tokenSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** What to look for in a leaked token or a log line; not a secret. */
  prefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: stamp,
  lastUsedAt: stamp.nullable(),
  revokedAt: stamp.nullable(),
  createdAt: stamp,
});
const createdSchema = tokenSchema.extend({ token: z.string() });
// Never the hash: nothing here can be turned into a credential.
const tokenDto = (t: ApiToken): z.infer<typeof tokenSchema> => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  scopes: t.scopes,
  expiresAt: iso(t.expiresAt),
  lastUsedAt: t.lastUsedAt && iso(t.lastUsedAt),
  revokedAt: t.revokedAt && iso(t.revokedAt),
  createdAt: iso(t.createdAt),
});

const params = z.object({ tokenId: z.uuid() });
const create = z.strictObject({
  name,
  scopes: z.array(z.string().refine(isScope, "not a scope")).min(1).max(50),
  // Always expires: a token that never does is a static secret in a pipeline.
  expiresInDays: z.int().min(1).max(MAX_TOKEN_TTL_DAYS).default(30),
});

/** Tokens belong to people: a token (even with every scope) cannot mint or revoke tokens. */
function ownerOf(principal: Principal | undefined) {
  if (principal?.kind !== "user") {
    throw new DomainError("forbidden", 403, "Only a signed-in user manages API tokens");
  }
  return principal.id;
}

export const tokenRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/tokens" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      ({ query, principal }) => {
        const userId = ownerOf(principal);
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (t) => [t.id],
          fetch: (after, limit) => listApiTokens(db, userId, { after: after?.[0], limit }),
          dto: tokenDto,
        });
      },
      {
        query: pageQuery,
        response: { 200: pageOf(tokenSchema), ...readErrors },
        signedIn: "lists the caller's own tokens",
      },
    )
    .post(
      "",
      async ({ body, principal, audit, set }) => {
        const userId = ownerOf(principal);
        const fresh = newApiToken();
        const row = await db.transaction(async (tx) => {
          const row = await createApiToken(tx, {
            userId,
            name: body.name,
            prefix: fresh.prefix,
            tokenHash: fresh.tokenHash,
            scopes: [...new Set(body.scopes)],
            ttlMs: body.expiresInDays * DAY_MS,
          });
          await audit(tx, {
            action: "token.create",
            resourceType: "api_token",
            resourceId: row.id,
            metadata: {
              name: row.name,
              prefix: row.prefix,
              scopes: row.scopes,
              expiresAt: iso(row.expiresAt),
            },
          });
          return row;
        });
        set.status = 201;
        set.headers["cache-control"] = "no-store";
        // The only time the token is shown: only its hash is kept.
        return { ...tokenDto(row), token: fresh.token };
      },
      {
        body: create,
        parse: "json",
        response: { 201: createdSchema, ...writeErrors },
        audit: "token.create",
        signedIn: "creates a token for the caller; the handler refuses callers that are not users",
      },
    )
    .delete(
      "/:tokenId",
      async ({ params: { tokenId }, principal, audit, set }) => {
        const userId = ownerOf(principal);
        await db.transaction(async (tx) => {
          const row = await revokeApiToken(tx, userId, tokenId);
          if (!row) throw notFound("Token");
          await audit(tx, {
            action: "token.revoke",
            resourceType: "api_token",
            resourceId: row.id,
            metadata: { name: row.name, prefix: row.prefix },
          });
        });
        set.status = 204;
      },
      {
        params,
        response: deleteResponses,
        audit: "token.revoke",
        signedIn: "revokes one of the caller's own tokens; anyone else's is not found",
      },
    );
