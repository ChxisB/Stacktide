import {
  DomainError,
  type Logger,
  type OrgRole,
  orgRoleOf,
  type ProjectRole,
  projectRoleOf,
} from "@orch/core";
import { type Db, gitlabLinks } from "@orch/db";
import { type Gitlab, GitlabError } from "@orch/gitlab";
import type { Roles } from "./session";

export interface MembershipOptions {
  db: Db;
  gitlab: Pick<Gitlab, "members">;
  /** The address of the GitLab `gitlab` talks to: only its links are asked about (see `gitlabLinks`). */
  baseUrl: string;
  logger?: Logger;
  /** How long a user's roles are kept before GitLab is asked again. Default 5 minutes. */
  ttlMs?: number;
  /** GitLab lookups in flight at once for one user. Default 8. */
  concurrency?: number;
  /** Users kept in the cache; the oldest go first. Default 10 000. */
  maxUsers?: number;
  now?: () => number;
}

/**
 * Where roles come from: the user's GitLab access level on every organization's linked group and
 * every project's linked GitLab project on this instance (inherited membership included), mapped by `orgRoleOf` /
 * `projectRoleOf`. One lookup per link, so a user's roles cost as many GitLab calls as there are
 * links, then none until the TTL ends.
 *
 * Fails closed: if GitLab cannot answer, the request fails with 503. Nothing is guessed, and an
 * expired answer is never served in its place. A failed lookup is not cached.
 *
 * shortcut: the whole link set is asked about for every user, not just the resource being
 * requested. Upgrade to lookups on demand when links outgrow a few hundred.
 */
export function gitlabRoles({
  db,
  gitlab,
  baseUrl,
  logger,
  ttlMs = 5 * 60_000,
  concurrency = 8,
  maxUsers = 10_000,
  now = Date.now,
}: MembershipOptions) {
  async function lookup(user: { gitlabId: number }): Promise<Roles> {
    const links = await gitlabLinks(db, baseUrl);
    const orgRoles: Record<string, OrgRole> = {};
    const projectRoles: Record<string, ProjectRole> = {};
    const level = (owner: Parameters<Gitlab["members"]["accessLevel"]>[0]) =>
      gitlab.members.accessLevel(owner, user.gitlabId);
    await inParallel(concurrency, [
      ...links.groups.map((g) => async () => {
        const role = orgRoleOf(await level({ group: g.gitlabGroupId }));
        if (role) orgRoles[g.organizationId] = role;
      }),
      ...links.projects.map((p) => async () => {
        const role = projectRoleOf(await level({ project: p.gitlabProjectId }));
        if (role) projectRoles[p.projectId] = role;
      }),
    ]);
    return { orgRoles, projectRoles };
  }

  const cached = rolesCache<number>({ ttlMs, maxUsers, now }, (gitlabId) =>
    lookup({ gitlabId }).catch((error: unknown) => {
      if (!(error instanceof GitlabError)) throw error;
      // The message names the method, path and status; never a token.
      logger?.[error.kind === "unauthorized" || error.kind === "forbidden" ? "error" : "warn"](
        "gitlab membership lookup failed",
        { kind: error.kind, status: error.status, message: error.message },
      );
      throw new DomainError(
        "membership_unavailable",
        503,
        "GitLab membership could not be checked",
      );
    }),
  );
  return (user: { gitlabId: number }): Promise<Roles> => cached(user.gitlabId);
}

/**
 * Keeps each key's answer for `ttlMs`, and one lookup in flight per key. The oldest keys go first when more than
 * `maxUsers` are kept. A failed lookup is forgotten, so the next request asks again; an expired answer is never
 * served in place of a new one.
 */
export function rolesCache<K>(
  { ttlMs, maxUsers, now }: { ttlMs: number; maxUsers: number; now: () => number },
  load: (key: K) => Promise<Roles>,
): (key: K) => Promise<Roles> {
  const cache = new Map<K, { until: number; roles: Promise<Roles> }>();
  return (key) => {
    const at = now();
    const hit = cache.get(key);
    if (hit && hit.until > at) return hit.roles;
    const roles = load(key);
    cache.delete(key); // re-inserted last: Map order is age
    for (const [oldKey, entry] of cache) {
      if (cache.size < maxUsers && entry.until > at) break;
      cache.delete(oldKey);
    }
    const entry = { until: at + ttlMs, roles };
    cache.set(key, entry);
    // A failure is forgotten, so the next request asks again.
    roles.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return roles;
  };
}

/** Runs the tasks, `limit` at a time; after the first failure no new task starts. */
export async function inParallel(limit: number, tasks: readonly (() => Promise<void>)[]) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < tasks.length) {
      try {
        await tasks[next++]?.();
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}
