import { z } from "zod";

/** `fetch`, narrowed to what the cloud clients use; `tls.ca` is Bun's way to trust a private CA. */
export type Init = RequestInit & { tls?: { ca: string } };
export type Fetch = (url: string, init: Init) => Promise<Response>;

/** Why a call to an outside system did not work, in the words a person can act on. */
export type CheckReason =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "rate_limited"
  | "server"
  | "timeout"
  | "network"
  | "unexpected";

/**
 * A failed call. The reason is all it carries: a message built from the cause could name a URL, a
 * header or a body, and a person typed the URL.
 */
export class CloudError extends Error {
  constructor(readonly reason: CheckReason) {
    super(reason);
    this.name = "CloudError";
  }
}

export interface Reply {
  status: number;
  text: string;
}

/** No answer these clients ask for is larger; a longer one is not the system they were pointed at. */
const MAX_BODY = 1_048_576;

/**
 * One request with a deadline. Redirects are never followed (a bearer token or an `X-Vault-Token`
 * would go wherever the answer points), and a body over the cap is refused, not read to the end.
 * Any failure to get an answer is a `CloudError`.
 */
export async function send(
  fetch: Fetch,
  url: string,
  init: Init,
  timeoutMs = 10_000,
): Promise<Reply> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, { ...init, redirect: "manual", signal });
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new CloudError("unexpected");
      }
      chunks.push(value);
    }
    return { status: res.status, text: Buffer.concat(chunks).toString("utf8") };
  } catch (e) {
    if (e instanceof CloudError) throw e;
    throw new CloudError(signal.aborted ? "timeout" : "network");
  }
}

/** What an HTTP status other than success amounts to. */
export function reasonOf(status: number): CheckReason {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid";
  return "unexpected";
}

/** The answer of a check: it either worked, or it says why not in fixed words. */
export type Check =
  | { ok: true; summary: string }
  | { ok: false; reason: CheckReason; message: string };

const COMMON: Record<CheckReason, string> = {
  unauthorized: "was rejected: the credential is wrong, expired or revoked",
  forbidden: "refused the credential: it is not allowed to do what is needed",
  not_found: "has nothing at this address: check the address and the names",
  invalid: "did not accept the request: check the names and the configuration",
  rate_limited: "is rate limiting requests: try again in a minute",
  server: "failed with a server error: try again later",
  timeout: "did not answer in time: check the address and the network",
  network: "could not be reached: check the address and the network",
  unexpected: "answered, but not like the system it should be: check the address",
};

/** `<system> <what happened>`; `specific` overrides the common text for the reasons that need to say more. */
export const failure = (
  system: string,
  reason: CheckReason,
  specific: Partial<Record<CheckReason, string>> = {},
): Check => ({ ok: false, reason, message: `${system} ${specific[reason] ?? COMMON[reason]}.` });

/**
 * The address of an outside system as a connection keeps it: https, no credentials, no path, query or
 * fragment, so it is an origin and nothing else. What is checked is not echoed: a person typed it.
 */
export const httpsOrigin = z
  .string()
  .max(2000)
  .transform((v, ctx) => {
    try {
      const u = new URL(v);
      if (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        u.pathname === "/" &&
        !u.search &&
        !u.hash
      ) {
        return u.origin;
      }
    } catch {
      // not a URL: the same answer as one that is not allowed
    }
    ctx.addIssue({
      code: "custom",
      message: "must be an https address without credentials or a path",
    });
    return z.NEVER;
  });
