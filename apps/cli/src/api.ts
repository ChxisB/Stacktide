import { createClient, problemOf } from "@orch/api-client";
import { CliError, type Context } from "./cli";
import { configPath, loadConfig } from "./config";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The API's origin from what the user gave: https, or http for this machine only (a token over plain
 * http would cross the network in the clear). Nothing else may ride along: credentials, a path, a
 * query or a fragment. The message never repeats the value, which may hold a password.
 */
export function apiUrlOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("the API URL is not a URL", 2);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new CliError("the API URL must use https (http is allowed for localhost only)", 2);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new CliError(
      "the API URL must be an origin such as https://orch.example.com: no credentials, path, query or fragment",
      2,
    );
  }
  return url.origin;
}

/**
 * Which API to talk to and as whom. The URL: `--api-url`, else `ORCH_API_URL`, else the config's.
 * The token: `ORCH_TOKEN`, else the config's, but a stored token is only ever used for the API it was
 * issued by, so a different URL (a typo, a poisoned environment) never receives it.
 */
export async function resolveApi(ctx: Context, flag?: string) {
  const config = await loadConfig(configPath(ctx.env, ctx.home));
  const given = flag ?? ctx.env.ORCH_API_URL ?? config.apiUrl;
  if (!given) {
    throw new CliError(
      "no API URL: pass --api-url, set ORCH_API_URL or run: orch login --api-url <url>",
      2,
    );
  }
  const apiUrl = apiUrlOf(given);
  const stored =
    config.apiUrl && new URL(config.apiUrl).origin === apiUrl ? config.token : undefined;
  return { config, apiUrl, token: ctx.env.ORCH_TOKEN || stored };
}

export const clientFor = (apiUrl: string, token?: string) =>
  createClient(apiUrl, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);

/**
 * The data of a typed client call, or the `CliError` for what went wrong. Messages hold the API's
 * origin and the problem the API reports, never the request (its headers hold the token).
 */
export async function call<T>(
  apiUrl: string,
  request: () => Promise<{ data: T | null; error: unknown; status: number }>,
): Promise<T> {
  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request();
  } catch {
    throw new CliError(`cannot reach ${apiUrl}`);
  }
  if (res.error) {
    // the client reports a call that never got an answer (refused, no route, timeout) as an error holding the exception
    if ((res.error as { value?: unknown }).value instanceof Error) {
      throw new CliError(`cannot reach ${apiUrl}`);
    }
    if (res.status === 401) {
      throw new CliError("your token is invalid or has expired; run: orch login");
    }
    const problem = problemOf(res as { error: unknown });
    throw new CliError(
      typeof problem?.code === "string" && typeof problem.title === "string"
        ? `${problem.detail ?? problem.title} (${problem.code})`
        : `${apiUrl} answered ${res.status}`,
    );
  }
  // a page that is not JSON (a proxy's login, another service) arrives as text; a 204 has no body at all
  if (res.status !== 204 && typeof res.data !== "object")
    throw new CliError(`${apiUrl} does not look like an orch API`);
  return res.data as T;
}
