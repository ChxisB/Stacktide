import { ORG_ROLES, type OrgRole, type Subject } from "@orch/core";
import { type Db, findSession, ssoRolesOf, type User } from "@orch/db";
import type { PrincipalResolver } from "./principal";
import { readCookie, SESSION_COOKIE } from "./routes/auth";
import { hashToken } from "./tokens";

export type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
/** A person who signs in with GitLab: the only kind whose roles come from a GitLab group. */
export type GitlabUser = User & { gitlabId: number };
const hasGitlab = (user: User): user is GitlabUser => user.gitlabId !== null;

export interface SessionOptions {
  db: Db;
  /**
   * What the user may do. AUTH-5 fills this from GitLab membership; until then nobody holds a
   * role. If it throws, the request fails: a lookup that did not finish never grants or guesses.
   */
  roles?: (user: GitlabUser) => Promise<Roles> | Roles;
  /** GitLab user ids that may create organizations. */
  platformAdmins?: readonly number[];
}

/** What `user` may do, as the subject of a request made as them (by cookie, or by token). */
export const subjectOf =
  ({
    db,
    roles = () => ({ orgRoles: {}, projectRoles: {} }),
    platformAdmins = [],
  }: Pick<SessionOptions, "db" | "roles" | "platformAdmins">) =>
  async (user: User, kind: Subject["kind"]): Promise<Subject> => {
    const gitlab = hasGitlab(user) ? await roles(user) : { orgRoles: {}, projectRoles: {} };
    // What an identity provider gave this person (SSO-4), asked every time: it ends with the session or the provider.
    const sso = await ssoRolesOf(db, user.id);
    const rank = (role?: OrgRole) => (role ? ORG_ROLES.indexOf(role) : -1);
    const orgRoles: Record<string, OrgRole> = { ...gitlab.orgRoles };
    for (const [org, role] of Object.entries(sso)) {
      if (rank(role) > rank(orgRoles[org])) orgRoles[org] = role;
    }
    return {
      kind,
      platformAdmin: hasGitlab(user) && platformAdmins.includes(user.gitlabId),
      orgRoles,
      projectRoles: gitlab.projectRoles,
    };
  };

/** The signed-in user behind the `orch_session` cookie, or nobody (no cookie, unknown, ended). */
export const sessionPrincipal = (options: SessionOptions): PrincipalResolver => {
  const subject = subjectOf(options);
  return async (request) => {
    const token = readCookie(request, SESSION_COOKIE);
    const found = token ? await findSession(options.db, hashToken(token)) : undefined;
    if (!found) return undefined;
    return {
      id: found.user.id,
      kind: "user",
      userId: found.user.id,
      subject: await subject(found.user, "user"),
    };
  };
};
