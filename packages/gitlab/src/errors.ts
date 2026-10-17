export type GitlabErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "rate_limited"
  | "server"
  | "timeout"
  | "network"
  | "unexpected";

/**
 * Failure talking to GitLab. The message names the method, path (no query) and status, plus
 * GitLab's own short reason; never the request body or a token. `timeout` and `network` on a
 * POST/PATCH mean the outcome is unknown (it may have been applied); those are never retried here.
 */
export class GitlabError extends Error {
  override readonly name = "GitlabError";
  constructor(
    readonly kind: GitlabErrorKind,
    message: string,
    readonly status?: number,
    /** Set on 429/5xx when GitLab said how long to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function kindOfStatus(status: number): GitlabErrorKind {
  if (status >= 500) return "server";
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 400:
    case 422:
      return "invalid";
    case 429:
      return "rate_limited";
    default:
      return "unexpected";
  }
}
