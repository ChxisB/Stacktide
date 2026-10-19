import { LEASE_ACCESS_LEVEL, LEASE_SCOPES } from "@orch/core";
import { GitlabError } from "@orch/gitlab";
import { RotationError } from "./errors";
import { type GitlabTokenDeps, gitlabFailure } from "./gitlab-token";
import type { Leaser } from "./types";

const DAY_MS = 86_400_000;
const isId = (v: number) => Number.isSafeInteger(v) && v > 0;

/**
 * The `gitlab-token` lease: a project access token made through one of the organization's stored
 * connections, read-only and at Reporter level whatever the caller asked for (ADR-0014: the request
 * cannot widen what the connection mints, so a scope outside `LEASE_SCOPES` is refused here too).
 *
 * GitLab ends a token at midnight UTC *starting* the date it is given, so the date used is the one a
 * day after the lease's expiry: never early, and at most a day late if the platform's own revoke
 * never happens. That backstop is GitLab's, not ours.
 */
export function gitlabLeaser(deps: Pick<GitlabTokenDeps, "open">): Leaser {
  return {
    type: "gitlab-token",
    async issue({ target, scopes, expiresAt, name, organizationId }) {
      if (
        scopes.length === 0 ||
        scopes.some((s) => !(LEASE_SCOPES as readonly string[]).includes(s))
      ) {
        throw new RotationError(
          "invalid_config",
          `gitlab-token: a lease takes only ${LEASE_SCOPES.join(", ")}`,
        );
      }
      if (!isId(target.projectId)) {
        throw new RotationError("invalid_config", "gitlab-token: the project has no GitLab id");
      }
      const gitlab = await deps.open(organizationId, target.connectionId);
      let token: Awaited<ReturnType<typeof gitlab.accessTokens.create>>;
      try {
        token = await gitlab.accessTokens.create(target.projectId, {
          name,
          scopes: [...scopes],
          accessLevel: LEASE_ACCESS_LEVEL,
          expiresAt: new Date(expiresAt.getTime() + DAY_MS).toISOString().slice(0, 10),
        });
      } catch (e) {
        throw gitlabFailure(e);
      }
      if (!token.token) throw new RotationError("failed", "gitlab-token: GitLab sent no token");
      return { value: token.token, handle: String(token.id) };
    },
    async revoke(target, handle, { organizationId }) {
      const tokenId = Number(handle);
      // not an id GitLab could have given: nothing it could name
      if (!isId(tokenId) || !isId(target.projectId)) return;
      const gitlab = await deps.open(organizationId, target.connectionId);
      try {
        await gitlab.accessTokens.revoke(target.projectId, tokenId);
      } catch (e) {
        if (e instanceof GitlabError && e.kind === "not_found") return;
        throw gitlabFailure(e);
      }
    },
  };
}
