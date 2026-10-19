import { z } from "zod";
import type { GitlabClient } from "./client";
import { decode } from "./decode";
import { type ProjectRef, projectPath } from "./projects";

export interface CreateAccessTokenInput {
  name: string;
  scopes: string[];
  /** `YYYY-MM-DD`. */
  expiresAt: string;
  /** 10 guest .. 50 owner; GitLab's default is 40 (maintainer). */
  accessLevel?: number;
  description?: string;
}

/**
 * A project access token as GitLab holds it. The secret sits behind a getter over a private field, as a
 * variable's value does, so JSON.stringify, spread and console.log never show it. It is there only on
 * the answer to `create` and `rotate`: GitLab shows it once and never again.
 */
export class AccessToken {
  readonly id: number;
  readonly name: string;
  readonly scopes: string[];
  readonly accessLevel: number;
  /** Neither revoked nor expired. */
  readonly active: boolean;
  readonly revoked: boolean;
  /** `YYYY-MM-DD`, or null when it does not expire. */
  readonly expiresAt: string | null;
  readonly #token: string | null;

  constructor(f: Omit<AccessToken, "token">, token: string | null) {
    this.id = f.id;
    this.name = f.name;
    this.scopes = f.scopes;
    this.accessLevel = f.accessLevel;
    this.active = f.active;
    this.revoked = f.revoked;
    this.expiresAt = f.expiresAt;
    this.#token = token;
  }

  /** Null unless this is the answer to `create` or `rotate`. */
  get token(): string | null {
    return this.#token;
  }
}

const accessToken = z
  .object({
    id: z.number().int(),
    name: z.string(),
    scopes: z.array(z.string()),
    access_level: z.number().int(),
    active: z.boolean(),
    revoked: z.boolean(),
    expires_at: z.string().nullish(),
    token: z.string().nullish(),
  })
  .transform(
    (t) =>
      new AccessToken(
        {
          id: t.id,
          name: t.name,
          scopes: t.scopes,
          accessLevel: t.access_level,
          active: t.active,
          revoked: t.revoked,
          expiresAt: t.expires_at ?? null,
        },
        t.token ?? null,
      ),
  );

function assertId(id: number) {
  if (!Number.isSafeInteger(id) || id < 1)
    throw new TypeError("GitLab token id must be a positive integer");
}

export function accessTokensApi(client: GitlabClient) {
  const base = (p: ProjectRef) => `${projectPath(p)}/access_tokens`;
  return {
    accessTokens: {
      /** Needs a personal access token: a project access token cannot make another. */
      async create(project: ProjectRef, input: CreateAccessTokenInput) {
        const raw = await client.request("POST", base(project), {
          body: {
            name: input.name,
            scopes: input.scopes,
            expires_at: input.expiresAt,
            access_level: input.accessLevel,
            description: input.description,
          },
        });
        return decode(accessToken, raw, "access token");
      },
      /** Never shows the secret. A revoked or expired token is still found, with `active: false`. */
      async get(project: ProjectRef, id: number) {
        assertId(id);
        return decode(
          accessToken,
          await client.request("GET", `${base(project)}/${id}`),
          "access token",
        );
      },
      /**
       * Makes a new token with the old one's name and scopes and revokes the old one in the same call:
       * there is no overlap. `expiresAt` (`YYYY-MM-DD`) defaults to a week on GitLab's side. Rotating
       * a token other than the caller's own needs a personal access token with the `api` scope.
       * `invalid` when the token cannot be rotated (revoked, say). On a `timeout` or `network` error
       * the outcome is unknown: the old token may be gone and the new one never seen.
       */
      async rotate(project: ProjectRef, id: number, opts: { expiresAt?: string } = {}) {
        assertId(id);
        const raw = await client.request("POST", `${base(project)}/${id}/rotate`, {
          body: { expires_at: opts.expiresAt },
        });
        return decode(accessToken, raw, "access token");
      },
      /** `not_found` when there is no such token. */
      async revoke(project: ProjectRef, id: number) {
        assertId(id);
        await client.request("DELETE", `${base(project)}/${id}`);
      },
    },
  };
}
