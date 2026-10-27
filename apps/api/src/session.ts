import { ORG_ROLES, type OrgRole, PROJECT_ROLES, type ProjectRole, type Subject } from "@orch/core";
import { type Db, findSession, githubIdOf, ssoRolesOf, type User } from "@orch/db";
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
  /**
   * What a person who signs in with GitHub may do, by their GitHub user id (FRG-25). Left out, a GitHub account
   * holds no role. Like `roles`, a lookup that throws fails the request.
   */
  githubRoles?: (githubId: number) => Promise<Roles> | Roles;
  /** GitLab user ids that may create organizations. */
  platformAdmins?: readonly number[];
  /** GitHub user ids that may create organizations (FRG-34): a list of its own, GitLab and GitHub ids never cross. Read only where `githubRoles` is set. */
  githubPlatformAdmins?: readonly number[];
}

/** What `user` may do, as the subject of a request made as them (by cookie, or by token). */
export const subjectOf =
  ({
    db,
    roles = () => ({ orgRoles: {}, projectRoles: {} }),
    githubRoles,
    platformAdmins = [],
    githubPlatformAdmins = [],
  }: Pick<
    SessionOptions,
    "db" | "roles" | "githubRoles" | "platformAdmins" | "githubPlatformAdmins"
  >) =>
  async (user: User, kind: Subject["kind"]): Promise<Subject> => {
    const gitlab = hasGitlab(user) ? await roles(user) : { orgRoles: {}, projectRoles: {} };
    // What an identity provider gave this person (SSO-4), asked every time: it ends with the session or the provider.
    const sso = await ssoRolesOf(db, user.id);
    const rank = (role?: OrgRole) => (role ? ORG_ROLES.indexOf(role) : -1);
    const orgRoles: Record<string, OrgRole> = { ...gitlab.orgRoles };
    for (const [org, role] of Object.entries(sso)) {
      if (rank(role) > rank(orgRoles[org])) orgRoles[org] = role;
    }
    // What GitHub says of a person who signs in with it (FRG-25, FRG-34): the higher of the two where both speak.
    const githubId = githubRoles ? await githubIdOf(db, user.id) : undefined;
    const github = githubRoles && githubId !== undefined ? await githubRoles(githubId) : undefined;
    for (const [org, role] of Object.entries(github?.orgRoles ?? {})) {
      if (rank(role) > rank(orgRoles[org])) orgRoles[org] = role;
    }
    const projectRoles: Record<string, ProjectRole> = { ...gitlab.projectRoles };
    for (const [project, role] of Object.entries(github?.projectRoles ?? {})) {
      const held = projectRoles[project];
      if (!held || PROJECT_ROLES.indexOf(role) > PROJECT_ROLES.indexOf(held)) {
        projectRoles[project] = role;
      }
    }
    return {
      kind,
      platformAdmin:
        (hasGitlab(user) && platformAdmins.includes(user.gitlabId)) ||
        (githubId !== undefined && githubPlatformAdmins.includes(githubId)),
      orgRoles,
      projectRoles,
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
