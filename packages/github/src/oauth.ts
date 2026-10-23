import { GitlabError, kindOfStatus, parseBaseUrl } from "@orch/gitlab";
import { z } from "zod";
import { createGithubClient } from "./client";
import { decode } from "./decode";

export interface GithubOAuthApp {
  /** The web address of the GitHub the people sign in to. Default `https://github.com`. */
  baseUrl?: string;
  clientId: string;
  /** GitHub asks for it at every exchange, PKCE or not (its changelog of 2025-07-14). */
  clientSecret: string;
  /** The callback registered with the OAuth app. */
  redirectUri: string;
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
}

export const githubUser = z
  .object({
    id: z.number().int().positive(),
    login: z.string().min(1),
    name: z.string().nullish(),
  })
  .transform((u) => ({ githubId: u.id, login: u.login, name: u.name || u.login }));
export type GithubUser = z.output<typeof githubUser>;

const tokenResponse = z.object({ access_token: z.string().min(8) });
// An OAuth error code (`bad_verification_code`): the only part of GitHub's reply worth keeping.
const OAUTH_ERROR = /^[a-z_]{1,40}$/;
// The app, not the person, is at fault: make these loud (`unauthorized`); the rest is a code that did not hold (`invalid`).
const APP_FAULT = new Set([
  "incorrect_client_credentials",
  "redirect_uri_mismatch",
  "application_suspended",
]);

/**
 * Sign in with GitHub (FRG-25): authorization code + PKCE (S256) + `state`, scope `read:user`. The access token
 * only says who the person is; callers use it once and drop it.
 * shortcut: github.com only in practice (the settings give no `baseUrl`): a person's id is one number on github.com, and
 * the roles lookup reads only github.com connections' repositories. Upgrade when an Enterprise Server gets its own
 * identity key.
 */
export function githubOAuth(app: GithubOAuthApp) {
  const base = parseBaseUrl(app.baseUrl ?? "https://github.com", app.allowInsecureHttp, "GitHub");
  if (!app.clientId) throw new TypeError("GitHub OAuth clientId is missing");
  if (!app.clientSecret) throw new TypeError("GitHub OAuth clientSecret is missing");
  try {
    new URL(app.redirectUri);
  } catch {
    throw new TypeError("GitHub OAuth redirectUri is not a valid URL");
  }
  const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
  const timeoutMs = app.timeoutMs ?? 15_000;

  return {
    authorizeUrl(p: { state: string; codeChallenge: string }): string {
      const q = new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: app.redirectUri,
        scope: "read:user",
        state: p.state,
        code_challenge: p.codeChallenge,
        code_challenge_method: "S256",
      });
      return `${root}/login/oauth/authorize?${q}`;
    },

    /**
     * Trades the code for an access token. Never retried: a code works once, so a repeat after a lost answer could
     * only fail. GitHub answers 200 with an `error` in the body when the exchange fails. The error names the status
     * and the OAuth error code, nothing sent.
     */
    async exchangeCode(p: { code: string; codeVerifier: string }): Promise<string> {
      const fail = (what: string, kind: GitlabError["kind"], status?: number) =>
        new GitlabError(kind, `GitHub POST /login/oauth/access_token ${what}`, status);
      let res: Response;
      let text: string;
      try {
        res = await fetch(`${root}/login/oauth/access_token`, {
          method: "POST",
          headers: { accept: "application/json" }, // without it GitHub answers in a form-encoded body
          body: new URLSearchParams({
            client_id: app.clientId,
            client_secret: app.clientSecret,
            code: p.code,
            code_verifier: p.codeVerifier,
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
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        if (!res.ok) throw fail(`failed (${res.status})`, kindOfStatus(res.status), res.status);
        throw fail("returned a non-JSON response", "unexpected", res.status);
      }
      const code = (body as { error?: unknown } | null)?.error;
      if (!res.ok || code !== undefined) {
        const said = typeof code === "string" && OAUTH_ERROR.test(code) ? code : undefined;
        const kind =
          said && APP_FAULT.has(said) ? "unauthorized" : kindOfStatus(res.ok ? 400 : res.status);
        throw fail(`failed (${res.status})${said ? `: ${said}` : ""}`, kind, res.status);
      }
      return decode(tokenResponse, body, "token response").access_token;
    },

    /** Who the access token belongs to. */
    async currentUser(accessToken: string): Promise<GithubUser> {
      const client = createGithubClient({
        baseUrl: app.baseUrl,
        token: accessToken,
        allowInsecureHttp: app.allowInsecureHttp,
        timeoutMs,
        maxRetries: 1,
      });
      return decode(githubUser, await client.request("GET", "/user"), "user");
    },
  };
}

export type GithubOAuth = ReturnType<typeof githubOAuth>;
