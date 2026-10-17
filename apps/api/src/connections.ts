import { createGitlab, GitlabError, type GitlabErrorKind } from "@orch/gitlab";

/** What a connection test found. A failure is an answer, not an error: `message` is safe to show. */
export type ConnectionTest =
  | {
      ok: true;
      user: { gitlabId: number; username: string; name: string };
      /** What the token says it may do; `null` when GitLab would not say. */
      scopes: string[] | null;
      /** The token's expiry date (`2027-01-31`), `null` for none or unknown. */
      expiresAt: string | null;
    }
  | { ok: false; reason: GitlabErrorKind; message: string };

// Fixed texts: GitLab's own error text can name the URL or the path, and a user typed the URL.
const WHY: Record<GitlabErrorKind, string> = {
  unauthorized: "GitLab rejected the token: it is wrong, expired or revoked.",
  forbidden:
    "GitLab refused the token: it needs the read_api scope (or api) and an active account.",
  not_found: "GitLab has no API at this URL: check the base URL.",
  conflict: "The URL answered, but not like GitLab: check the base URL.",
  invalid: "The URL answered, but not like GitLab: check the base URL.",
  unexpected: "The URL answered, but not like GitLab: check the base URL.",
  rate_limited: "GitLab is rate limiting requests: try again in a minute.",
  server: "GitLab failed with a server error: try again later.",
  timeout: "GitLab did not answer in time: check the base URL and the network.",
  network: "GitLab could not be reached: check the base URL and the network.",
};
const fail = (reason: GitlabErrorKind): ConnectionTest => ({
  ok: false,
  reason,
  message: WHY[reason],
});

/**
 * Asks GitLab who the token is (`/user`) and what it may do (`/personal_access_tokens/self`).
 * One retry and a short timeout: a person is waiting. The scopes are best effort, since an
 * older GitLab or another kind of token may not answer that call; the user is not.
 */
export async function testGitlab(input: {
  baseUrl: string;
  token: string;
}): Promise<ConnectionTest> {
  const api = createGitlab({
    baseUrl: input.baseUrl,
    auth: { type: "private-token", token: input.token },
    timeoutMs: 10_000,
    maxRetries: 1,
    maxRetryDelayMs: 2_000, // a Retry-After of minutes must not hold the request
  });
  try {
    const me = await api.users.current();
    if (!me.active) return fail("forbidden");
    const info = await api.users.tokenInfo().catch(() => undefined);
    // Known scopes must allow reading the API; unknown ones (an older GitLab) are let through.
    if (info && !info.scopes.some((s) => s === "api" || s === "read_api")) return fail("forbidden");
    return {
      ok: true,
      user: { gitlabId: me.gitlabId, username: me.username, name: me.name },
      scopes: info?.scopes ?? null,
      expiresAt: info?.expiresAt ?? null,
    };
  } catch (error) {
    if (error instanceof GitlabError) return fail(error.kind);
    throw error;
  }
}
