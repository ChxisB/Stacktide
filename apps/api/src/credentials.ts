import { useApiToken } from "@orch/db";
import type { PrincipalResolver } from "./principal";
import { type SessionOptions, sessionPrincipal, subjectOf } from "./session";
import { hashToken, isApiToken } from "./tokens";

const BEARER = /^Bearer ([^\s]+)$/i;

/** The API token in `Authorization: Bearer ...`; any other header (a proxy's Basic auth) is not ours. */
const tokenOf = (request: Request) => {
  const given = request.headers.get("authorization")?.match(BEARER)?.[1];
  return given && isApiToken(given) ? given : undefined;
};

/**
 * The owner of the API token in `Authorization: Bearer ...`, limited to the token's scopes, or
 * nobody (not a token, unknown, expired, revoked). The owner's roles are looked up on every
 * request, so a token loses what its owner loses.
 */
export const bearerPrincipal = (options: SessionOptions): PrincipalResolver => {
  const subject = subjectOf(options);
  return async (request) => {
    const given = tokenOf(request);
    const found = given && (await useApiToken(options.db, hashToken(given)));
    if (!found) return undefined;
    return {
      id: found.token.id,
      kind: "token",
      subject: { ...(await subject(found.user, "token")), scopes: found.token.scopes },
    };
  };
};

/**
 * Who is calling: the token when the request carries one (a bad token is nobody, it does not
 * fall back to a cookie), else the session cookie.
 */
export const callerPrincipal = (options: SessionOptions): PrincipalResolver => {
  const [bearer, session] = [bearerPrincipal(options), sessionPrincipal(options)];
  return (request) => (tokenOf(request) ? bearer(request) : session(request));
};
