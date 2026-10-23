import { DomainError } from "@orch/core";
import { findSession, listOwnIdentities, unlinkIdentity } from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin, unauthenticated } from "../guard";
import { hashToken } from "../tokens";
import { readCookie, SESSION_COOKIE } from "./auth";
import { deleteResponses, iso, notFound, type RouteDeps, readErrors } from "./shared";

const identitySchema = z.object({
  id: z.uuid(),
  kind: z.enum(["gitlab", "github", "sso"]),
  organizationSlug: z.string().nullable(), // the organization an SSO identity belongs to
  organizationName: z.string().nullable(),
  email: z.string().nullable(), // what the provider last said, for showing only; never the `sub`
  createdAt: z.iso.datetime(),
});

/**
 * A person's own ways to sign in (SSO-7, ADR-0016). Only a live browser session reaches them: an API token is for
 * automation and never manages how a person signs in, so each route reads the session cookie itself and answers its
 * own 401, as `/auth/me` does. What one person may do to another's identity is nothing: it is not found.
 */
export const identityRoutes = ({ db, principal }: RouteDeps) => {
  const userOf = async (request: Request) => {
    const token = readCookie(request, SESSION_COOKIE);
    const found = token ? await findSession(db, hashToken(token)) : undefined;
    if (!found) throw unauthenticated();
    return found.user;
  };

  return new Elysia({ prefix: "/auth/identities" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ request, set }) => {
        set.headers["cache-control"] = "no-store"; // per-user answer: no shared cache may keep it
        const user = await userOf(request);
        // shortcut: no paging, a person has a handful of identities (one per organization at most), upgrade if that stops holding
        return (await listOwnIdentities(db, user.id)).map((i) => ({
          ...i,
          createdAt: iso(i.createdAt),
        }));
      },
      {
        response: { 200: z.array(identitySchema), ...readErrors },
        public:
          "answers 401 itself unless the cookie holds a live session; lists only that person's own",
      },
    )
    .delete(
      "/:id",
      async ({ request, params: { id }, audit, set }) => {
        const user = await userOf(request);
        await db.transaction(async (tx) => {
          const done = await unlinkIdentity(tx, user.id, id);
          if (done.status === "not_found") throw notFound("Identity");
          if (done.status === "gitlab") {
            throw new DomainError(
              "identity_not_removable",
              409,
              "The GitLab identity is the account's own and cannot be removed",
            );
          }
          if (done.status === "github") {
            throw new DomainError(
              "identity_not_removable",
              409,
              "The GitHub identity is the account's own and cannot be removed",
            );
          }
          if (done.status === "last") {
            throw new DomainError("last_identity", 409, "This is your only way to sign in");
          }
          await audit(
            tx,
            {
              action: "identity.unlink",
              resourceType: "user",
              resourceId: user.id,
              organizationId: done.organizationId,
              metadata: { ssoProviderId: done.ssoProviderId },
            },
            { kind: "user", id: user.id },
          );
        });
        set.status = 204;
      },
      {
        params: z.object({ id: z.uuid() }),
        response: deleteResponses,
        audit: "identity.unlink",
        public:
          "answers 401 itself unless the cookie holds a live session; acts only on that person's own",
      },
    );
};
