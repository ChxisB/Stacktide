import { describe, expect, test } from "bun:test";
import { can, orgRoleOf, projectRoleOf } from "./index";

// GitLab's access levels: docs.gitlab.com/ee/api/members.html#roles
const LEVELS = {
  none: 0,
  minimal: 5,
  guest: 10,
  planner: 15,
  reporter: 20,
  securityManager: 25,
  developer: 30,
  maintainer: 40,
  owner: 50,
};

describe("a GitLab group role becomes an organization role", () => {
  test("each access level, written out", () => {
    expect(
      Object.fromEntries(Object.entries(LEVELS).map(([name, level]) => [name, orgRoleOf(level)])),
    ).toEqual({
      none: undefined,
      minimal: undefined,
      guest: undefined,
      planner: undefined,
      reporter: "viewer",
      securityManager: "viewer",
      developer: "member",
      maintainer: "admin",
      owner: "owner",
    });
  });

  test("a level GitLab does not define holds nothing", () => {
    for (const level of [-1, 1, 19, 21, 35, 45, 49, 51, 60, 100, 20.5, Number.NaN, Infinity]) {
      expect([level, orgRoleOf(level)]).toEqual([level, undefined]);
    }
    for (const level of ["50", null, undefined, {}, [50], true]) {
      expect(orgRoleOf(level as never)).toBeUndefined();
    }
  });
});

describe("a GitLab project role becomes a project role", () => {
  test("each access level, written out", () => {
    expect(
      Object.fromEntries(
        Object.entries(LEVELS).map(([name, level]) => [name, projectRoleOf(level)]),
      ),
    ).toEqual({
      none: undefined,
      minimal: undefined,
      guest: undefined,
      planner: undefined,
      reporter: "reporter",
      securityManager: "reporter",
      developer: "developer",
      maintainer: "maintainer",
      owner: "maintainer",
    });
  });

  test("a level GitLab does not define holds nothing", () => {
    for (const level of [-1, 1, 19, 21, 35, 45, 49, 51, 60, 100, 20.5, Number.NaN, Infinity]) {
      expect([level, projectRoleOf(level)]).toEqual([level, undefined]);
    }
    for (const level of ["40", null, undefined, {}, [40], true]) {
      expect(projectRoleOf(level as never)).toBeUndefined();
    }
  });
});

test("the mapped roles are the ones can() knows", () => {
  const org = crypto.randomUUID();
  const project = crypto.randomUUID();
  const resource = { organizationId: org, projectId: project };
  const [orgRole, projectRole] = [orgRoleOf(50), projectRoleOf(20)];
  if (!orgRole || !projectRole) throw new Error("expected both levels to map");
  const owner = { kind: "user" as const, orgRoles: { [org]: orgRole }, projectRoles: {} };
  expect(can(owner, "organization.delete", resource)).toBe(true);
  const reporter = {
    kind: "user" as const,
    orgRoles: {},
    projectRoles: { [project]: projectRole },
  };
  expect(can(reporter, "project.read", resource)).toBe(true);
  expect(can(reporter, "secret.reveal", resource)).toBe(false);
});
