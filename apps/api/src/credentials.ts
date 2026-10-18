import type { Subject } from "@orch/core";
import { type CiToken, useApiToken, useCiToken } from "@orch/db";
import type { PrincipalResolver } from "./principal";
import { type SessionOptions, sessionPrincipal, subjectOf } from "./session";
import { hashToken, isApiToken, isCiToken } from "./tokens";

const BEARER = /^Bearer ([^\s]+)$/i;

/** The API or CI token in `Authorization: Bearer ...`; any other header (a proxy's Basic auth) is not ours. */
const tokenOf = (request: Request) => {
  const given = request.headers.get("authorization")?.match(BEARER)?.[1];
  return given && (isApiToken(given) || isCiToken(given)) ? given : undefined;
};

/**
 * A CI job's token: read access to its project, and to its environment if it has one, nothing else.
 * Revealing the environment's values (`secret.reveal`) is a maintainer's right, so a token that
 * carries that scope is a maintainer on its one project: the scopes allow three actions, the
 * environment tie limits two of them to one environment, and no other action is open to it.
 */
const ciSubject = (row: CiToken): Subject => ({
  kind: "ci",
  orgRoles: {},
  projectRoles: {
    [row.projectId]: row.scopes.includes("secret.reveal") ? "maintainer" : "reporter",
  },
  scopes: row.scopes,
  environmentId: row.environmentId ?? undefined,
});

/**
 * The owner of the API token in `Authorization: Bearer ...`, limited to the token's scopes, or
 * the CI job a CI token was issued to, or nobody (not a token, unknown, expired, revoked). The
 * owner's roles are looked up on every request, so a token loses what its owner loses.
 */
export const bearerPrincipal = (options: SessionOptions): PrincipalResolver => {
  const subject = subjectOf(options);
  return async (request) => {
    const given = tokenOf(request);
    if (given && isCiToken(given)) {
      const row = await useCiToken(options.db, hashToken(given));
      return (
        row && {
          id: row.id,
          kind: "ci",
          subject: ciSubject(row),
          job: { gitlabJobId: row.gitlabJobId, ref: row.ref },
        }
      );
    }
    const found = given && (await useApiToken(options.db, hashToken(given)));
    if (!found) return undefined;
    return {
      id: found.token.id,
      kind: "token",
      userId: found.user.id,
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
