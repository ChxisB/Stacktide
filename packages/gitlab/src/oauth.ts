import { z } from "zod";
import { createGitlabClient, parseBaseUrl } from "./client";
import { decode } from "./decode";
import { GitlabError, kindOfStatus } from "./errors";

export interface OAuthApp {
  baseUrl: string;
  clientId: string;
  /** Sent when set: a confidential GitLab application (the default kind) needs it. */
  clientSecret?: string;
  /** One of the application's registered redirect URIs. */
  redirectUri: string;
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
}

const user = z
  .object({
    id: z.number().int().positive(),
    username: z.string(),
    name: z.string(),
    state: z.string(),
  })
  .transform((u) => ({
    gitlabId: u.id,
    username: u.username,
    name: u.name,
    active: u.state === "active",
  }));
export type GitlabUser = z.output<typeof user>;

const tokenResponse = z.object({ access_token: z.string().min(8) });
// An OAuth error code (`invalid_grant`): the only part of GitLab's reply worth keeping.
const OAUTH_ERROR = /^[a-z_]{1,40}$/;

/** The S256 `code_challenge` for a PKCE `code_verifier` (RFC 7636). */
export const pkceChallenge = (verifier: string) =>
  new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

/**
 * Sign in with GitLab: authorization code + PKCE. The access token only proves who the user is
 * (scope `read_user`); callers use it once and drop it.
 */
export function gitlabOAuth(app: OAuthApp) {
  const base = parseBaseUrl(app.baseUrl, app.allowInsecureHttp);
  if (!app.clientId) throw new TypeError("GitLab OAuth clientId is missing");
  try {
    new URL(app.redirectUri);
  } catch {
    throw new TypeError("GitLab OAuth redirectUri is not a valid URL");
  }
  const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
  const timeoutMs = app.timeoutMs ?? 15_000;

  return {
    authorizeUrl(p: { state: string; codeChallenge: string }): string {
      const q = new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: app.redirectUri,
        response_type: "code",
        scope: "read_user",
        state: p.state,
        code_challenge: p.codeChallenge,
        code_challenge_method: "S256",
      });
      return `${root}/oauth/authorize?${q}`;
    },

    /**
     * Trades the code for an access token. Never retried: a code works once, so a repeat after a
     * lost answer could only fail. The error names the status and OAuth error code, nothing sent.
     */
    async exchangeCode(p: { code: string; codeVerifier: string }): Promise<string> {
      const fail = (what: string, kind: GitlabError["kind"], status?: number) =>
        new GitlabError(kind, `GitLab POST /oauth/token ${what}`, status);
      let res: Response;
      let text: string;
      try {
        res = await fetch(`${root}/oauth/token`, {
          method: "POST",
          headers: { accept: "application/json" },
          body: new URLSearchParams({
            client_id: app.clientId,
            ...(app.clientSecret ? { client_secret: app.clientSecret } : {}),
            code: p.code,
            code_verifier: p.codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: app.redirectUri,
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (e) {
        const timedOut = e instanceof Error && e.name === "TimeoutError";
        throw timedOut
          ? fail(`timed out after ${timeoutMs}ms`, "timeout")
          : fail("request failed", "network");
      }
      if (!res.ok) {
        let code: unknown;
        try {
          code = (JSON.parse(text) as { error?: unknown }).error;
        } catch {}
        const said = typeof code === "string" && OAUTH_ERROR.test(code) ? `: ${code}` : "";
        throw fail(`failed (${res.status})${said}`, kindOfStatus(res.status), res.status);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw fail("returned a non-JSON response", "unexpected", res.status);
      }
      return decode(tokenResponse, body, "token response").access_token;
    },

    /** Who the access token belongs to. */
    async currentUser(accessToken: string): Promise<GitlabUser> {
      const client = createGitlabClient({
        baseUrl: app.baseUrl,
        auth: { type: "oauth", token: accessToken },
        allowInsecureHttp: app.allowInsecureHttp,
        timeoutMs,
        maxRetries: 1,
      });
      return decode(user, await client.request("GET", "/user"), "user");
    },
  };
}

export type GitlabOAuth = ReturnType<typeof gitlabOAuth>;
