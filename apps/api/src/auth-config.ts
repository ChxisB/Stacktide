import type { Logger } from "@orch/core";
import { connectionsByIssuer, type Db } from "@orch/db";
import { githubForge } from "@orch/forge";
import { createGithubClient, githubKeys, githubOAuth } from "@orch/github";
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
const GITHUB_KEYS = [
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "GITHUB_OAUTH_REDIRECT_URI",
] as const;

/** Where the provider sends the browser back: https (http only on this machine, where nothing crosses a network) and the route that completes a sign-in. */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const isCallback = (path: string) => (uri: string) => {
  try {
    const { protocol, hostname, pathname } = new URL(uri);
    return (
      (protocol === "https:" || (protocol === "http:" && LOOPBACK.includes(hostname))) &&
      pathname === path
    );
  } catch {
    return false; // not a URL at all
  }
};

/**
 * Sign in with GitLab: all four settings or none, so a half-set deploy fails at start, not at login.
 * `GITLAB_MEMBERSHIP_TOKEN` (needs the four) is what reads who is a member of the linked
 * groups and projects; without it nobody holds a role. `ORCH_CI_AUDIENCE` (needs `GITLAB_URL`,
 * so the four) turns on the CI `id_token` exchange: the `aud` jobs ask for. `ORCH_SSO_REDIRECT_URI`
 * (`https://<host>/auth/sso/callback`, registered at each identity provider) turns on sign-in through an
 * organization's identity provider; it needs none of the GitLab settings. The three `GITHUB_OAUTH_*` settings (all or
 * none, FRG-25) turn on sign-in with GitHub; they need none of the others, and the roles it gives are read at start
 * (`index.ts`), so they also need `ORCH_MASTER_KEYS`. `GITHUB_MEMBERSHIP_TOKEN` (needs the three, FRG-34) reads who
 * owns or belongs to the GitHub organizations that organizations here are linked to: a token with the `read:org`
 * scope, whose owner is a member of each of them.
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
      .refine(isCallback("/auth/sso/callback"), "an https URL ending /auth/sso/callback")
      .optional(),
    GITHUB_MEMBERSHIP_TOKEN: z.string().min(1).optional(),
    GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    GITHUB_OAUTH_REDIRECT_URI: z
      .string()
      .refine(isCallback("/auth/github/callback"), "an https URL ending /auth/github/callback")
      .optional(),
  })
  .superRefine((c, ctx) => {
    if (c.ORCH_CI_AUDIENCE !== undefined && c.GITLAB_URL === undefined) {
      ctx.addIssue({ code: "custom", path: ["GITLAB_URL"], message: "required" });
    }
    if (GITHUB_KEYS.some((k) => c[k] !== undefined) || c.GITHUB_MEMBERSHIP_TOKEN !== undefined) {
      for (const k of GITHUB_KEYS) {
        if (c[k] === undefined) ctx.addIssue({ code: "custom", path: [k], message: "required" });
      }
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
  /** GitHub user ids (comma separated) that may create organizations: a list of their own, a GitLab id never counts here (FRG-34). */
  ORCH_PLATFORM_ADMIN_GITHUB_IDS: z
    .string()
    .regex(/^(\d+(\s*,\s*\d+)*)?$/, "comma separated GitHub user ids")
    .transform((list) => (list ? list.split(",").map(Number) : []))
    .refine((ids) => ids.every(Number.isSafeInteger), "GitHub user id too large")
    .optional(),
});

/** An https redirect URI (GitLab's, GitHub's or SSO's) means browsers reach the API over https: cookies get `Secure`. */
export function authFromEnv(c: z.output<typeof authEnv>): AuthDeps {
  const { GITLAB_URL: baseUrl, GITLAB_OAUTH_CLIENT_ID: clientId } = c;
  const { GITLAB_OAUTH_CLIENT_SECRET: clientSecret, GITLAB_OAUTH_REDIRECT_URI: redirectUri } = c;
  const { ORCH_SSO_REDIRECT_URI: ssoRedirectUri } = c;
  const { GITHUB_OAUTH_CLIENT_ID: hubId, GITHUB_OAUTH_CLIENT_SECRET: hubSecret } = c;
  const { GITHUB_OAUTH_REDIRECT_URI: hubRedirect } = c;
  const gitlab =
    baseUrl && clientId && clientSecret && redirectUri
      ? { oauth: gitlabOAuth({ baseUrl, clientId, clientSecret, redirectUri }) }
      : undefined;
  const github =
    hubId && hubSecret && hubRedirect
      ? {
          github: githubOAuth({
            clientId: hubId,
            clientSecret: hubSecret,
            redirectUri: hubRedirect,
          }),
        }
      : undefined;
  if (!gitlab && !github && !ssoRedirectUri) return {};
  return {
    ...gitlab,
    ...github,
    ...(ssoRedirectUri && { ssoRedirectUri }),
    secureCookies: [redirectUri, ssoRedirectUri, hubRedirect].some((u) => u?.startsWith("https:")),
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
  return gitlabRoles({ db, gitlab, baseUrl, logger });
}

/** The forge that reads GitHub organization membership (FRG-34), or nothing when no membership token is set. */
export const orgForgeFromEnv = (c: Pick<z.output<typeof authEnv>, "GITHUB_MEMBERSHIP_TOKEN">) =>
  c.GITHUB_MEMBERSHIP_TOKEN
    ? githubForge(createGithubClient({ token: c.GITHUB_MEMBERSHIP_TOKEN }))
    : undefined;

/**
 * The CI `id_token` exchange, or nothing (it then answers 503) when no audience is set. Tokens of the deployment's
 * own GitLab (`GITLAB_URL`) are checked against its keys; tokens of any other GitLab only when a GitLab connection
 * is registered at that address (FRG-5), against the keys that connection's instance publishes.
 */
export function ciFromEnv(c: z.output<typeof authEnv>, db: Db): CiDeps | undefined {
  const { GITLAB_URL: baseUrl, ORCH_CI_AUDIENCE: audience } = c;
  // shortcut: the exchange needs GITLAB_URL even when every instance is a connection, because the audience setting
  // is validated against it; drop that dependency when a deployment has no GitLab of its own.
  if (!baseUrl || !audience) return undefined;
  const keys = gitlabKeys({ baseUrl });
  const others = new Map<string, CiDeps["key"]>(); // one cache per registered issuer, so its keys are fetched once
  return {
    key: keyCache({ fetch: () => keys.jwks() }),
    issuer: baseUrl.replace(/\/+$/, ""), // GitLab's `iss` has no trailing slash
    audience,
    // GitHub Actions' keys: fetched on the first token of that issuer, never for a deployment that gets none
    github: keyCache({ fetch: () => githubKeys().jwks() }),
    async forIssuer(issuer) {
      const [registered] = await connectionsByIssuer(db, issuer);
      if (!registered?.baseUrl) return undefined;
      let key = others.get(issuer);
      if (!key) {
        const theirs = gitlabKeys({ baseUrl: registered.baseUrl });
        key = keyCache({ fetch: () => theirs.jwks() });
        others.set(issuer, key);
      }
      return key;
    },
  };
}
