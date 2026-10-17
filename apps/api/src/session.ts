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

/** The signed-in user behind the `orch_session` cookie, or nobody (no cookie, unknown, ended). */
export const sessionPrincipal =
  ({
    db,
    roles = () => ({ orgRoles: {}, projectRoles: {} }),
    platformAdmins = [],
  }: SessionOptions): PrincipalResolver =>
  async (request) => {
    const token = readCookie(request, SESSION_COOKIE);
    const found = token ? await findSession(db, hashToken(token)) : undefined;
    if (!found) return undefined;
    const { user } = found;
    return {
      id: user.id,
      kind: "user",
      subject: {
        kind: "user",
        platformAdmin: platformAdmins.includes(user.gitlabId),
        ...(await roles(user)),
      },
    };
  };
