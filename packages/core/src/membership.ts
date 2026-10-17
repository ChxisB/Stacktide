import type { OrgRole, ProjectRole } from "./authz";

// GitLab access levels (docs.gitlab.com/ee/api/members.html#roles). Anything not listed, Minimal
// (5), Guest (10), Planner (15) and a level GitLab adds later included, holds nothing here.
const ORG: ReadonlyMap<number, OrgRole> = new Map([
  [20, "viewer"], // Reporter
  [25, "viewer"], // Security Manager
  [30, "member"], // Developer
  [40, "admin"], // Maintainer
  [50, "owner"], // Owner
]);
const PROJECT: ReadonlyMap<number, ProjectRole> = new Map([
  [20, "reporter"],
  [25, "reporter"],
  [30, "developer"],
  [40, "maintainer"],
  [50, "maintainer"],
]);

/** The organization role a GitLab group access level confers, or nothing. */
export const orgRoleOf = (level: number): OrgRole | undefined => ORG.get(level);

/** The project role a GitLab project access level confers, or nothing. */
export const projectRoleOf = (level: number): ProjectRole | undefined => PROJECT.get(level);
