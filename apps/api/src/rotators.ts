import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import type { Db } from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import {
  gitlabLeaser,
  gitlabTokenRotator,
  type Leaser,
  RotationError,
  type Rotator,
  randomRotator,
} from "@orch/rotation";
import { openGitlabConnection } from "./connections";

type OpenDeps = { db: Db; keys?: KeyProvider | undefined; logger: Logger };

/**
 * One of the organization's stored GitLab connections, opened for the organization asking, so a config
 * or a lease naming another organization's connection finds none. Never retried: a call GitLab did
 * carry out (a token rotated or made), sent again, would end or duplicate what it just did.
 */
const openGitlab = (deps: OpenDeps) => async (organizationId: string, connectionId: string) => {
  try {
    const { baseUrl, token } = await openGitlabConnection(
      deps,
      organizationId,
      connectionId,
      undefined,
    );
    return createGitlab({
      baseUrl,
      auth: { type: "private-token", token },
      timeoutMs: 15_000,
      maxRetries: 0,
    });
  } catch (e) {
    // not found, not GitLab's, another organization's, secret unreadable: a person fixes the connection
    if (e instanceof DomainError) {
      throw new RotationError(
        "denied",
        "gitlab-token: the connection cannot be opened (it must exist in this organization, be a GitLab connection and have a readable secret)",
      );
    }
    throw e;
  }
};

/**
 * The providers this build has, by `Rotator.type`: the API checks a rotation's config with them and the
 * worker rotates with them. `gitlab-token` reaches GitLab through one of the organization's stored
 * connections, opened with the organization of the rotation.
 */
export function builtInRotators(deps: OpenDeps): ReadonlyMap<string, Rotator> {
  const gitlabToken = gitlabTokenRotator({ open: openGitlab(deps) });
  return new Map<string, Rotator>([
    [randomRotator.type, randomRotator],
    [gitlabToken.type, gitlabToken],
  ]);
}

/** The lease providers (ADR-0014), through the same connection opener: `gitlab-token` only. */
export function builtInLeasers(deps: OpenDeps): ReadonlyMap<string, Leaser> {
  const gitlabToken = gitlabLeaser({ open: openGitlab(deps) });
  return new Map<string, Leaser>([[gitlabToken.type, gitlabToken]]);
}
