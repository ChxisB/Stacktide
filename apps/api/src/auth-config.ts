import type { Logger } from "@orch/core";
import type { Db } from "@orch/db";
import { createGitlab, gitlabKeys, gitlabOAuth } from "@orch/gitlab";
import { z } from "zod";
import { keyCache } from "./id-token";
import { gitlabRoles } from "./membership";
import type { AuthDeps } from "./routes/auth";
import type { CiDeps } from "./routes/ci";

const KEYS = [
  "GITLAB_URL",
  "GITLAB_OAUTH_CLIENT_ID",
  "GITLAB_OAUTH_CLIENT_SECRET",
  "GITLAB_OAUTH_REDIRECT_URI",
] as const;

/** Where the provider sends the browser back: https (http only on this machine, where nothing crosses a network) and the route that completes a sign-in. */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
function isSsoCallback(uri: string) {
  try {
    const { protocol, hostname, pathname } = new URL(uri);
    return (
      (protocol === "https:" || (protocol === "http:" && LOOPBACK.includes(hostname))) &&
      pathname === "/auth/sso/callback"
    );
  } catch {
    return false; // not a URL at all
  }
}

/**
 * Sign in with GitLab: all four settings or none, so a half-set deploy fails at start, not at login.
 * `GITLAB_MEMBERSHIP_TOKEN` (needs the four) is what reads who is a member of the linked
 * groups and projects; without it nobody holds a role. `ORCH_CI_AUDIENCE` (needs `GITLAB_URL`,
 * so the four) turns on the CI `id_token` exchange: the `aud` jobs ask for. `ORCH_SSO_REDIRECT_URI`
 * (`https://<host>/auth/sso/callback`, registered at each identity provider) turns on sign-in through an
 * organization's identity provider; it needs none of the GitLab settings.
 */
export const authEnv = z
  .object({
    GITLAB_URL: z.url().optional(),
    GITLAB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    GITLAB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    GITLAB_OAUTH_REDIRECT_URI: z.url().optional(),
    GITLAB_MEMBERSHIP_TOKEN: z.string().min(1).optional(),
    ORCH_CI_AUDIENCE: z.string().min(1).optional(),
    ORCH_SSO_REDIRECT_URI: z
      .string()
      .refine(isSsoCallback, "an https URL ending /auth/sso/callback")
      .optional(),
  })
  .superRefine((c, ctx) => {
    if (c.ORCH_CI_AUDIENCE !== undefined && c.GITLAB_URL === undefined) {
      ctx.addIssue({ code: "custom", path: ["GITLAB_URL"], message: "required" });
    }
    if (c.GITLAB_MEMBERSHIP_TOKEN === undefined && KEYS.every((k) => c[k] === undefined)) return;
    for (const k of KEYS) {
      if (c[k] === undefined) ctx.addIssue({ code: "custom", path: [k], message: "required" });
    }
  });

/** Who may do what, beyond the GitLab sign-in itself. */
export const accessEnv = z.object({
  /** `1` turns authentication off: every caller is the dev principal. `index.ts` allows it only on loopback in development. */
  ORCH_DEV_AUTH: z.literal("1").optional(),
  /** GitLab user ids (comma separated) that may create organizations. */
  ORCH_PLATFORM_ADMIN_GITLAB_IDS: z
    .string()
    .regex(/^(\d+(\s*,\s*\d+)*)?$/, "comma separated GitLab user ids")
    .transform((list) => (list ? list.split(",").map(Number) : [])) // empty means none
    .refine((ids) => ids.every(Number.isSafeInteger), "GitLab user id too large")
    .optional(),
});

/** An https redirect URI (GitLab's or SSO's) means browsers reach the API over https: cookies get `Secure`. */
export function authFromEnv(c: z.output<typeof authEnv>): AuthDeps {
  const { GITLAB_URL: baseUrl, GITLAB_OAUTH_CLIENT_ID: clientId } = c;
  const { GITLAB_OAUTH_CLIENT_SECRET: clientSecret, GITLAB_OAUTH_REDIRECT_URI: redirectUri } = c;
  const { ORCH_SSO_REDIRECT_URI: ssoRedirectUri } = c;
  const gitlab =
    baseUrl && clientId && clientSecret && redirectUri
      ? { oauth: gitlabOAuth({ baseUrl, clientId, clientSecret, redirectUri }) }
      : undefined;
  if (!gitlab && !ssoRedirectUri) return {};
  return {
    ...gitlab,
    ...(ssoRedirectUri && { ssoRedirectUri }),
    secureCookies: [redirectUri, ssoRedirectUri].some((u) => u?.startsWith("https:")),
  };
}

/**
 * Roles from GitLab membership, or nothing (nobody holds a role) when no membership token is set.
 * The token needs `read_api` and must be a member, or an admin, of every linked group and project.
 */
export function rolesFromEnv(
  c: Pick<z.output<typeof authEnv>, "GITLAB_URL" | "GITLAB_MEMBERSHIP_TOKEN">,
  db: Db,
  logger: Logger,
) {
  const { GITLAB_URL: baseUrl, GITLAB_MEMBERSHIP_TOKEN: token } = c;
  if (!baseUrl || !token) return undefined;
  const gitlab = createGitlab({ baseUrl, auth: { type: "private-token", token } });
  return gitlabRoles({ db, gitlab, logger });
}

/** The CI `id_token` exchange, or nothing (it then answers 503) when no audience is set. */
export function ciFromEnv(c: z.output<typeof authEnv>): CiDeps | undefined {
  const { GITLAB_URL: baseUrl, ORCH_CI_AUDIENCE: audience } = c;
  if (!baseUrl || !audience) return undefined;
  const keys = gitlabKeys({ baseUrl });
  return {
    key: keyCache({ fetch: () => keys.jwks() }),
    issuer: baseUrl.replace(/\/+$/, ""), // GitLab's `iss` has no trailing slash
    audience,
  };
}
