import { type Gitlab, GitlabError, type ProjectRef } from "@orch/gitlab";
import { z } from "zod";
import type { GithubClient } from "./client";
import { decode } from "./decode";
import { segment, whole } from "./paths";

/** GitLab's access levels (Reporter 20, Developer 30, Maintainer 40, Owner 50), which `orgRoleOf` and `projectRoleOf` turn into roles. */
const REPO_LEVEL = new Map([
  ["read", 20],
  ["triage", 20],
  ["write", 30],
  ["maintain", 40],
  ["admin", 50],
]);
/** The old three-valued `permission`, for a custom role: what it is built on, and so the least it holds. */
const BASE_LEVEL = new Map([
  ["read", 20],
  ["write", 30],
  ["admin", 50],
]);
/** An organization's owner is its Owner and a member a Developer; a billing manager holds no access to code. */
const ORG_LEVEL = new Map([
  ["admin", 50],
  ["member", 30],
]);

const account = z.object({ login: z.string(), type: z.string() });
const permission = z.object({
  permission: z.string(),
  // the exact role (`maintain`, `triage`, a custom role's name); `permission` alone folds them into read, write and admin
  role_name: z.string().nullish(),
});
const membership = z.object({ state: z.string(), role: z.string() });

const missing = (e: unknown) => e instanceof GitlabError && e.kind === "not_found";

/**
 * Who holds what, in GitLab's levels (FRG-15). 0 for anyone who is not a member, or whose repository, organization or
 * account GitHub does not show; any other failure is thrown, because a lookup that did not finish must not read as no
 * access. GitHub is asked by login, so a user id costs one request to turn it into one.
 * The caller of the permission route needs push access to the repository (GitHub's documentation, not run against GitHub).
 */
export function membersApi(
  client: GithubClient,
  base: (p: ProjectRef) => Promise<string>,
): { members: Gitlab["members"] } {
  /** The login of a user account, or nothing for an id that is not one (an organization's, or none). */
  const loginOf = async (id: number) => {
    const a = decode(account, await client.request("GET", `/user/${whole(id)}`), "account");
    return a.type === "User" ? a.login : undefined;
  };
  const repo = async (owner: ProjectRef, userId: number) => {
    const login = await loginOf(userId);
    if (!login) return 0;
    const at = `${await base(owner)}/collaborators/${segment(login)}`;
    // 204 for a collaborator, 404 for anyone else: the permission route alone says `read` to a stranger on a public repository
    await client.request("GET", at);
    const p = decode(permission, await client.request("GET", `${at}/permission`), "permission");
    return REPO_LEVEL.get(p.role_name ?? "") ?? BASE_LEVEL.get(p.permission) ?? 0;
  };
  const org = async (group: number | string, userId: number) => {
    const login = await loginOf(userId);
    if (!login) return 0;
    const name =
      typeof group === "string"
        ? group
        : decode(
            account,
            await client.request("GET", `/organizations/${whole(group)}`),
            "organization",
          ).login;
    const m = decode(
      membership,
      await client.request("GET", `/orgs/${segment(name)}/memberships/${segment(login)}`),
      "membership",
    );
    return m.state === "active" ? (ORG_LEVEL.get(m.role) ?? 0) : 0;
  };
  return {
    members: {
      async accessLevel(owner, userId) {
        try {
          return "project" in owner
            ? await repo(owner.project, userId)
            : await org(owner.group, userId);
        } catch (e) {
          if (missing(e)) return 0;
          throw e;
        }
      },
    },
  };
}
