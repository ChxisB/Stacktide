import {
  DomainError,
  type Logger,
  type OrgRole,
  orgRoleOf,
  type ProjectRole,
  projectRoleOf,
} from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { type Db, githubLinks, githubOrgLinks } from "@orch/db";
import type { Forge } from "@orch/forge";
import { GitlabError } from "@orch/gitlab";
import { forgeFor, openGithubConnection } from "./connections";
import { inParallel, rolesCache } from "./membership";
import type { Roles } from "./session";

export interface GithubRolesOptions {
  db: Db;
  keys: KeyProvider;
  logger: Logger;
  /** Test seam: the forge for a stored connection and its token. Default: `forgeFor`, the connection's own address. */
  forge?: (connection: { type: string; config: Record<string, unknown> }, token: string) => Forge;
  /**
   * The forge that reads membership of the GitHub organizations organizations here are linked to (FRG-34), opened
   * with the deployment's `GITHUB_MEMBERSHIP_TOKEN`: a new organization has no connection yet to read it with.
   * Left out, no organization role comes from GitHub.
   */
  orgForge?: Forge;
  /** How long an account's roles are kept before GitHub is asked again. Default 5 minutes. */
  ttlMs?: number;
  /** GitHub lookups in flight at once for one account. Default 8. */
  concurrency?: number;
  /** Accounts kept in the cache; the oldest go first. Default 10 000. */
  maxUsers?: number;
  now?: () => number;
}

/**
 * Where a GitHub account's roles come from (FRG-25): its permission on every repository linked to a project through a
 * github.com connection, read with that connection's own token and mapped by `projectRoleOf` (read and triage report,
 * write develops, maintain and admin maintain). An organization linked to a GitHub organization (FRG-34) also gives
 * the account its membership there: an owner is an owner here, a member a member, a billing manager or a pending
 * invitation nothing; this is read with `orgForge`, the deployment's own token. Keyed by the GitHub user id, never the
 * login.
 *
 * Fails closed, like `gitlabRoles`: if GitHub cannot answer, the request fails with 503 and the failure is not kept.
 * A connection whose secret cannot be opened fails the lookup too.
 *
 * shortcut: every linked repository is asked about for every account (about three GitHub calls each, then none until
 * the TTL ends), not just the resource being requested. Upgrade to lookups on demand when links outgrow a few hundred.
 */
export function githubRoles({
  db,
  keys,
  logger,
  forge = forgeFor,
  orgForge,
  ttlMs = 5 * 60_000,
  concurrency = 8,
  maxUsers = 10_000,
  now = Date.now,
}: GithubRolesOptions) {
  async function lookup(githubId: number): Promise<Roles> {
    const links = await githubLinks(db);
    const projectRoles: Record<string, ProjectRole> = {};
    const orgRoles: Record<string, OrgRole> = {};
    const orgs = orgForge ? await githubOrgLinks(db) : [];
    // each connection is opened once per lookup, however many repositories it reads
    const forges = new Map<string, Promise<Forge>>();
    const forgeOf = (link: (typeof links)[number]) => {
      let opened = forges.get(link.connectionId);
      if (!opened) {
        opened = openGithubConnection(
          { db, keys, logger },
          link.organizationId,
          link.connectionId,
          undefined,
        ).then(({ connection, token }) => forge(connection, token));
        forges.set(link.connectionId, opened);
      }
      return opened;
    };
    await inParallel(concurrency, [
      ...links.map((link) => async () => {
        const role = projectRoleOf(
          await (await forgeOf(link)).members.accessLevel({ project: link.repositoryId }, githubId),
        );
        if (role) projectRoles[link.projectId] = role;
      }),
      ...orgs.map((link) => async () => {
        const role = orgRoleOf(
          (await orgForge?.members.accessLevel({ group: link.githubOrgId }, githubId)) ?? 0,
        );
        if (role) orgRoles[link.organizationId] = role;
      }),
    ]);
    return { orgRoles, projectRoles };
  }

  return rolesCache<number>({ ttlMs, maxUsers, now }, (githubId) =>
    lookup(githubId).catch((error: unknown) => {
      if (!(error instanceof GitlabError)) throw error;
      // The message names the method, path and status; never a token.
      logger[error.kind === "unauthorized" || error.kind === "forbidden" ? "error" : "warn"](
        "github membership lookup failed",
        { kind: error.kind, status: error.status, message: error.message },
      );
      throw new DomainError(
        "membership_unavailable",
        503,
        "GitHub membership could not be checked",
      );
    }),
  );
}
