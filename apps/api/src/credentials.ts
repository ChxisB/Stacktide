import type { Subject } from "@orch/core";
import { type CiToken, useApiToken, useCiToken } from "@orch/db";
import type { PrincipalResolver } from "./principal";
import { type SessionOptions, sessionPrincipal, subjectOf } from "./session";
import { hashToken, isApiToken, isCiToken } from "./tokens";

const BEARER = /^Bearer ([^\s]+)$/i;
const BASIC = /^Basic ([A-Za-z0-9+/]+={0,2})$/i;
/** The state routes (STATE-3), the only ones that read Basic credentials. */
const STATE_PATH = /^\/organizations\/[^/]+\/projects\/[^/]+\/state\//;

/**
 * The API or CI token in `Authorization: Bearer ...`; any other header (a proxy's Basic auth) is not ours.
 * Terraform's `http` backend can send HTTP Basic credentials only, so on the state routes alone the password
 * of a Basic header is read as a token too, and then only a CI token (the user name is whatever it is).
 */
const tokenOf = (request: Request) => {
  const header = request.headers.get("authorization");
  const given = header?.match(BEARER)?.[1];
  if (given) return isApiToken(given) || isCiToken(given) ? given : undefined;
  const basic = header?.match(BASIC)?.[1];
  if (!basic || !STATE_PATH.test(new URL(request.url).pathname)) return undefined;
  const password = Buffer.from(basic, "base64").toString("utf8").split(":").slice(1).join(":");
  return isCiToken(password) ? password : undefined;
};

/**
 * A CI job's token: read access to its project, and to its environment if it has one, nothing else.
 * Revealing the environment's values (`secret.reveal`) is a maintainer's right, so a token that
 * carries that scope is a maintainer on its one project: the scopes allow three actions, the
 * environment tie limits two of them to one environment, and no other action is open to it. Taking a
 * lease (`lease.issue`) is a developer's right, held the same way: the scopes name the actions, and so
 * does writing the project's Terraform state (`state.write`).
 */
const ciSubject = (row: CiToken): Subject => ({
  kind: "ci",
  orgRoles: {},
  projectRoles: {
    [row.projectId]: row.scopes.includes("secret.reveal")
      ? "maintainer"
      : row.scopes.includes("lease.issue") || row.scopes.includes("state.write")
        ? "developer"
        : "reporter",
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
          job: { gitlabJobId: row.gitlabJobId, ref: row.ref, expiresAt: row.expiresAt },
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
