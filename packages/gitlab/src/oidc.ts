import { z } from "zod";
import { parseBaseUrl } from "./client";
import { decode } from "./decode";
import { GitlabError, kindOfStatus } from "./errors";

/** The public half of an RSA signing key, as GitLab publishes it. */
export interface Jwk {
  kty: "RSA";
  kid: string;
  n: string;
  e: string;
}

export interface KeysApp {
  baseUrl: string;
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
}

const rsaKey = z.object({
  kty: z.literal("RSA"),
  kid: z.string().min(1),
  n: z.string(),
  e: z.string(),
});
const keySet = z.object({ keys: z.array(z.unknown()) });

/**
 * The keys that sign this GitLab's job `id_token`s (`/oauth/discovery/keys`, public). Only RSA keys
 * with an id are kept: anything else could not verify the RS256 tokens GitLab issues, and
 * ignoring it keeps one odd key from failing the lot.
 */
export function gitlabKeys(app: KeysApp) {
  const base = parseBaseUrl(app.baseUrl, app.allowInsecureHttp);
  const url = `${base.origin}${base.pathname.replace(/\/+$/, "")}/oauth/discovery/keys`;
  const timeoutMs = app.timeoutMs ?? 15_000;
  return {
    async jwks(): Promise<Jwk[]> {
      const fail = (what: string, kind: GitlabError["kind"], status?: number) =>
        new GitlabError(kind, `GitLab GET /oauth/discovery/keys ${what}`, status);
      let res: Response;
      let text: string;
      try {
        res = await fetch(url, {
          headers: { accept: "application/json" },
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
      if (!res.ok) throw fail(`failed (${res.status})`, kindOfStatus(res.status), res.status);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw fail("returned a non-JSON response", "unexpected", res.status);
      }
      const { keys } = decode(keySet, body, "key set");
      return keys.flatMap((k) => {
        const r = rsaKey.safeParse(k);
        return r.success ? [{ kty: r.data.kty, kid: r.data.kid, n: r.data.n, e: r.data.e }] : [];
      });
    },
  };
}

export type GitlabKeys = ReturnType<typeof gitlabKeys>;
