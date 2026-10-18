import type { Subject } from "@orch/core";
import { type Db, findSession, type User } from "@orch/db";
import type { PrincipalResolver } from "./principal";
import { readCookie, SESSION_COOKIE } from "./routes/auth";
import { hashToken } from "./tokens";

export type Roles = Pick<Subject, "orgRoles" | "projectRoles">;

export interface SessionOptions {
  db: Db;
  /**
   * What the user may do. AUTH-5 fills this from GitLab membership; until then nobody holds a
   * role. If it throws, the request fails: a lookup that did not finish never grants or guesses.
   */
  roles?: (user: User) => Promise<Roles> | Roles;
  /** GitLab user ids that may create organizations. */
  platformAdmins?: readonly number[];
}

/** What `user` may do, as the subject of a request made as them (by cookie, or by token). */
export const subjectOf =
  ({
    roles = () => ({ orgRoles: {}, projectRoles: {} }),
    platformAdmins = [],
  }: Pick<SessionOptions, "roles" | "platformAdmins">) =>
  async (user: User, kind: Subject["kind"]): Promise<Subject> => ({
    kind,
    platformAdmin: platformAdmins.includes(user.gitlabId),
    ...(await roles(user)),
  });

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
