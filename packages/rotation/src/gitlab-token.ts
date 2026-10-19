import { type Gitlab, GitlabError } from "@orch/gitlab";
import { RotationError } from "./errors";
import type { Rotator } from "./types";

/**
 * Which project access token, through which stored connection. Ids and a lifetime only: the token
 * itself exists as a variable version and nowhere else. `tokenId` moves on with every rotation.
 */
export interface GitlabTokenConfig {
  connectionId: string;
  projectId: number;
  tokenId: number;
  /** How long each new token lives at least (GitLab ends it then, whether or not it was rotated; up to a day later). */
  expiresInDays: number;
}

export const GITLAB_TOKEN_EXPIRY = { min: 1, max: 365, default: 90 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (why: string) => new RotationError("invalid_config", `gitlab-token: ${why}`);
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export interface GitlabTokenDeps {
  /**
   * The GitLab client of one of the organization's stored connections. It must refuse a connection of
   * another organization (the config's id is the caller's text) and one that is not GitLab's.
   */
  open: (organizationId: string, connectionId: string) => Promise<Pick<Gitlab, "accessTokens">>;
  now?: () => Date;
}

/** What GitLab said, as a kind a person can act on; its text is not passed on. */
export function gitlabFailure(e: unknown): unknown {
  if (!(e instanceof GitlabError)) return e;
  switch (e.kind) {
    case "unauthorized":
    case "forbidden":
      return new RotationError(
        "denied",
        "gitlab-token: GitLab refused the connection's token (rotating a token needs a personal access token with the api scope)",
      );
    case "not_found":
      return bad("the project or token is not there");
    default:
      return new RotationError(
        "failed",
        `gitlab-token: GitLab did not rotate the token (${e.kind})`,
      );
  }
}

/**
 * The `gitlab-token` provider: rotates a project access token through GitLab's own call, which makes
 * the new token and revokes the old one in a single step. So the old token ends at once (there is no
 * grace: `endsReplaced`), the new token's id is the handle, and the config moves on to it.
 *
 * Limits, both left to a person: a rotation whose answer was lost (timeout, a failed commit afterwards)
 * has already ended the old token, so the variable holds a dead value and the next rotation, aimed at
 * the old id, is refused by GitLab; set the config to the token that is live. And the connection must
 * not be authenticated by the token it rotates.
 */
export function gitlabTokenRotator(deps: GitlabTokenDeps): Rotator<GitlabTokenConfig> {
  const now = deps.now ?? (() => new Date());
  return {
    type: "gitlab-token",
    external: true,
    endsReplaced: true,
    validate(config) {
      if (config === null || typeof config !== "object" || Array.isArray(config)) {
        throw bad("the config is { connectionId, projectId, tokenId, expiresInDays? }");
      }
      const {
        connectionId,
        projectId,
        tokenId,
        expiresInDays = GITLAB_TOKEN_EXPIRY.default,
        ...rest
      } = config as Record<string, unknown>;
      // the key names are the caller's text: say how many, not which
      if (Object.keys(rest).length > 0) throw bad("the config has a setting this provider lacks");
      if (typeof connectionId !== "string" || !UUID.test(connectionId)) {
        throw bad("connectionId is the id of a stored GitLab connection");
      }
      if (!id(projectId)) throw bad("projectId is the project's numeric id");
      if (!id(tokenId)) throw bad("tokenId is the token's numeric id");
      if (
        typeof expiresInDays !== "number" ||
        !Number.isInteger(expiresInDays) ||
        expiresInDays < GITLAB_TOKEN_EXPIRY.min ||
        expiresInDays > GITLAB_TOKEN_EXPIRY.max
      ) {
        throw bad(
          `expiresInDays is a whole number from ${GITLAB_TOKEN_EXPIRY.min} to ${GITLAB_TOKEN_EXPIRY.max}`,
        );
      }
      return { connectionId, projectId, tokenId, expiresInDays };
    },
    lifetimeDays: (config) => config.expiresInDays,
    async rotate({ config, organizationId }) {
      const gitlab = await deps.open(organizationId, config.connectionId);
      // GitLab ends a token at 00:00 UTC of its date, so the date a day on: never before `expiresInDays`
      const expiresAt = new Date(now().getTime() + (config.expiresInDays + 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      let token: Awaited<ReturnType<typeof gitlab.accessTokens.rotate>>;
      try {
        token = await gitlab.accessTokens.rotate(config.projectId, config.tokenId, { expiresAt });
      } catch (e) {
        throw gitlabFailure(e);
      }
      if (!token.token) throw new RotationError("failed", "gitlab-token: GitLab sent no token");
      return {
        value: token.token,
        handle: String(token.id),
        config: { ...config, tokenId: token.id },
      };
    },
    async revoke(config, handle, { organizationId }) {
      const tokenId = Number(handle);
      // not an id GitLab could have given: nothing it could name
      if (!id(tokenId)) return;
      const gitlab = await deps.open(organizationId, config.connectionId);
      try {
        await gitlab.accessTokens.revoke(config.projectId, tokenId);
      } catch (e) {
        if (e instanceof GitlabError && e.kind === "not_found") return;
        throw gitlabFailure(e);
      }
    },
  };
}
