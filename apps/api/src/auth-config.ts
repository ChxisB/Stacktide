import { gitlabOAuth } from "@orch/gitlab";
import { z } from "zod";
import type { AuthDeps } from "./routes/auth";

const KEYS = [
  "GITLAB_URL",
  "GITLAB_OAUTH_CLIENT_ID",
  "GITLAB_OAUTH_CLIENT_SECRET",
  "GITLAB_OAUTH_REDIRECT_URI",
] as const;

/** Sign in with GitLab: all four settings or none, so a half-set deploy fails at start, not at login. */
export const authEnv = z
  .object({
    GITLAB_URL: z.url().optional(),
    GITLAB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    GITLAB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    GITLAB_OAUTH_REDIRECT_URI: z.url().optional(),
  })
  .superRefine((c, ctx) => {
    if (KEYS.every((k) => c[k] === undefined)) return;
    for (const k of KEYS) {
      if (c[k] === undefined) ctx.addIssue({ code: "custom", path: [k], message: "required" });
    }
  });

/** An https redirect URI means browsers reach the API over https: cookies get `Secure`. */
export function authFromEnv(c: z.output<typeof authEnv>): AuthDeps {
  const { GITLAB_URL: baseUrl, GITLAB_OAUTH_CLIENT_ID: clientId } = c;
  const { GITLAB_OAUTH_CLIENT_SECRET: clientSecret, GITLAB_OAUTH_REDIRECT_URI: redirectUri } = c;
  if (!baseUrl || !clientId || !clientSecret || !redirectUri) return {};
  return {
    oauth: gitlabOAuth({ baseUrl, clientId, clientSecret, redirectUri }),
    secureCookies: redirectUri.startsWith("https:"),
  };
}
