import { describe, expect, test } from "bun:test";
import {
  can,
  isAction,
  isScope,
  ORG_ROLES,
  type OrgRole,
  orgAccess,
  type ProjectRole,
  type Resource,
  RULES,
  type Subject,
  visibleOrganizations,
} from "./authz";

const ORG = "org-1";
const PROJECT = "proj-1";
const res = { organizationId: ORG, projectId: PROJECT };

const user = (over: Partial<Subject> = {}): Subject => ({
  kind: "user",
  orgRoles: {},
  projectRoles: {},
  ...over,
});
const orgRole = (r: OrgRole) => user({ orgRoles: { [ORG]: r } });
const projectRole = (r: ProjectRole) => user({ projectRoles: { [PROJECT]: r } });

// Every kind of holder the model knows. Written out by hand, not derived from RULES.
const holders: Record<string, Subject> = {
  nobody: user(),
  "org viewer": orgRole("viewer"),
  "org member": orgRole("member"),
  "org admin": orgRole("admin"),
  "org owner": orgRole("owner"),
  "project reporter": projectRole("reporter"),
  "project developer": projectRole("developer"),
  "project maintainer": projectRole("maintainer"),
  "platform admin": user({ platformAdmin: true }),
};
const ORG_ALL = ["org viewer", "org member", "org admin", "org owner"];
const REPORTER_UP = [...ORG_ALL, "project reporter", "project developer", "project maintainer"];
// an org member is a developer on every project of the org
const DEVELOPER_UP = [
  "org member",
  "org admin",
  "org owner",
  "project developer",
  "project maintainer",
];
const MAINTAINER_UP = ["org admin", "org owner", "project maintainer"];

// Who may do what: the whole table, one list per action.
const allowed: Record<string, string[]> = {
  "organization.create": ["platform admin"],
  "organization.read": ORG_ALL,
  "organization.update": ["org admin", "org owner"],
  "organization.delete": ["org owner"],
  "project.create": ["org admin", "org owner"],
  "project.read": REPORTER_UP,
  "project.update": MAINTAINER_UP,
  "project.delete": ["org admin", "org owner"],
  "environment.read": REPORTER_UP,
  "environment.create": MAINTAINER_UP,
  "environment.update": MAINTAINER_UP,
  "environment.delete": MAINTAINER_UP,
  "variable.read": REPORTER_UP,
  "variable.create": MAINTAINER_UP,
  "variable.update": MAINTAINER_UP,
  "variable.delete": MAINTAINER_UP,
  "secret.reveal": MAINTAINER_UP,
  "variable.restore": MAINTAINER_UP,
  "variable.import": MAINTAINER_UP,
  "variable.bulk": MAINTAINER_UP,
  // The organization's own variables: org rules, so a project maintainer holds none of them.
  "variable.org.read": ORG_ALL,
  "variable.org.create": ["org admin", "org owner"],
  "variable.org.update": ["org admin", "org owner"],
  "variable.org.delete": ["org admin", "org owner"],
  "secret.reveal.org": ["org admin", "org owner"],
  "variable.org.restore": ["org admin", "org owner"],
  "variable.org.import": ["org admin", "org owner"],
  "variable.org.bulk": ["org admin", "org owner"],
  // Org rules, so a project maintainer holds none of them.
  "connection.create": ["org admin", "org owner"],
  "connection.read": ["org admin", "org owner"],
  "connection.test": ["org admin", "org owner"],
  "project.import": ["org admin", "org owner"],
  "connection.delete": ["org admin", "org owner"],
  "connection.webhook": ["org admin", "org owner"],
  // A target uses the connection's token: org rules for writes, any project reader may see one.
  "sync.target.read": REPORTER_UP,
  "sync.target.create": ["org admin", "org owner"],
  "sync.target.update": ["org admin", "org owner"],
  "sync.target.delete": ["org admin", "org owner"],
  "sync.plan": MAINTAINER_UP,
  "sync.run.read": REPORTER_UP,
  "sync.apply": MAINTAINER_UP,
  "pipeline.read": REPORTER_UP,
  "pipeline.apply": ["org admin", "org owner"],
  "pipeline.upgrade": ["org admin", "org owner"],
  "pipeline.retry": MAINTAINER_UP,
  "run.read": REPORTER_UP,
  "run.create": DEVELOPER_UP,
  "run.summary": REPORTER_UP,
  "run.apply": MAINTAINER_UP,
  // Org rules for everything that sets where notifications go; a project reader may see where its project's go.
  "notification.sink.read": ["org admin", "org owner"],
  "notification.sink.create": ["org admin", "org owner"],
  "notification.sink.delete": ["org admin", "org owner"],
  "notification.subscription.read": REPORTER_UP,
  "notification.subscription.update": ["org admin", "org owner"],
  // Policy is the organization's: anyone in it may read the sets, only admins write them (a project maintainer applies plans and must not remove what judges them).
  "policy.set.read": ORG_ALL,
  "policy.set.create": ["org admin", "org owner"],
  "policy.set.delete": ["org admin", "org owner"],
  "audit.read": ["org admin", "org owner"],
  "audit.export": ["org admin", "org owner"],
  "audit.retention.read": ["org admin", "org owner"],
  // deleting events is the owner's choice alone
  "audit.retention.update": ["org owner"],
  "audit.forwarding.read": ["org admin", "org owner"],
  "audit.forwarding.update": ["org admin", "org owner"],
  // lifting protection is the admins' (the maintainers who approve must not be the ones to lift it)
  "environment.protect": ["org admin", "org owner"],
  "change_request.read": REPORTER_UP,
  "change_request.create": DEVELOPER_UP,
  "change_request.approve": MAINTAINER_UP,
  "change_request.reject": MAINTAINER_UP,
};

describe("role x action", () => {
  test("the table above covers every action, and nothing else", () => {
    expect(Object.keys(allowed).sort()).toEqual(Object.keys(RULES).sort());
  });

  for (const [action, who] of Object.entries(allowed)) {
    test(action, () => {
      for (const [name, subject] of Object.entries(holders)) {
        expect([name, can(subject, action, res)]).toEqual([name, who.includes(name)]);
      }
    });
  }

  test("an org action needs no project id", () => {
    expect(can(orgRole("owner"), "organization.delete", { organizationId: ORG })).toBe(true);
    expect(can(orgRole("admin"), "project.create", { organizationId: ORG })).toBe(true);
  });
});

describe("boundaries", () => {
  test("a role in one org gives nothing in another", () => {
    const other = { organizationId: "org-2", projectId: PROJECT };
    for (const action of Object.keys(RULES)) {
      expect([action, can(orgRole("owner"), action, other)]).toEqual([action, false]);
    }
  });

  test("a role on one project gives nothing on another", () => {
    const other = { organizationId: ORG, projectId: "proj-2" };
    for (const action of Object.keys(RULES)) {
      expect([action, can(projectRole("maintainer"), action, other)]).toEqual([action, false]);
    }
  });

  test("a project action without both ids is refused", () => {
    expect(can(orgRole("owner"), "project.read", { organizationId: ORG })).toBe(false);
    expect(can(projectRole("maintainer"), "project.read", { projectId: PROJECT })).toBe(false);
    expect(can(orgRole("owner"), "project.read", {})).toBe(false);
    expect(can(orgRole("owner"), "project.read")).toBe(false);
  });

  test("an org action without the org id is refused", () => {
    expect(can(orgRole("owner"), "organization.read", {})).toBe(false);
  });

  test("an unknown action is denied, even for the strongest holder", () => {
    for (const action of [
      "",
      "nope",
      "organization",
      "organization.",
      "*",
      "secret.reveal ",
      "ORGANIZATION.READ",
    ]) {
      expect([action, can(orgRole("owner"), action, res)]).toEqual([action, false]);
    }
  });

  test("ids and actions that exist on every object find nothing", () => {
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const s = user({ orgRoles: {}, projectRoles: {} });
      expect(can(s, "organization.read", { organizationId: id })).toBe(false);
      expect(can(s, "project.read", { organizationId: id, projectId: id })).toBe(false);
      expect(can(orgRole("owner"), id, res)).toBe(false);
      expect(isAction(id)).toBe(false);
    }
  });

  test("a role name nobody defined is no role", () => {
    const bad = user({
      orgRoles: { [ORG]: "superadmin" as OrgRole },
      projectRoles: { [PROJECT]: "god" as ProjectRole },
    });
    for (const action of Object.keys(RULES)) expect(can(bad, action, res)).toBe(false);
  });

  test("an unknown kind is denied", () => {
    const dev = { ...orgRole("owner"), kind: "dev" as "user" };
    expect(can(dev, "organization.read", res)).toBe(false);
    expect(can({ ...dev, scopes: ["*"] }, "organization.read", res)).toBe(false);
  });

  test("only the platform admin flag, true exactly, creates organizations", () => {
    expect(can(user({ platformAdmin: true }), "organization.create")).toBe(true);
    expect(can(user({ platformAdmin: "yes" as unknown as boolean }), "organization.create")).toBe(
      false,
    );
    expect(
      can({ ...user({ platformAdmin: true }), kind: "ci", scopes: ["*"] }, "organization.create"),
    ).toBe(false);
    expect(
      can(
        { ...user({ platformAdmin: true }), kind: "token", scopes: ["*"] },
        "organization.create",
      ),
    ).toBe(true);
  });

  test("being platform admin grants nothing else", () => {
    const admin = user({ platformAdmin: true });
    for (const action of Object.keys(RULES).filter((a) => a !== "organization.create")) {
      expect([action, can(admin, action, res)]).toEqual([action, false]);
    }
  });
});

describe("scopes", () => {
  const owner = { orgRoles: { [ORG]: "owner" as const }, projectRoles: {} };
  const token = (scopes?: string[]): Subject => ({ kind: "token", ...owner, scopes });

  test("a token or CI job without scopes can do nothing; an empty list too", () => {
    for (const kind of ["token", "ci"] as const) {
      expect(can({ kind, ...owner }, "organization.read", res)).toBe(false);
      expect(can({ kind, ...owner, scopes: [] }, "organization.read", res)).toBe(false);
    }
  });

  test("a scope narrows what the role would allow", () => {
    expect(can(token(["project.read"]), "project.read", res)).toBe(true);
    expect(can(token(["project.read"]), "project.update", res)).toBe(false);
    expect(can(token(["project.read"]), "environment.read", res)).toBe(false);
  });

  test("a scope cannot widen the role", () => {
    const reporter: Subject = {
      kind: "token",
      orgRoles: {},
      projectRoles: { [PROJECT]: "reporter" },
      scopes: ["*"],
    };
    expect(can(reporter, "project.read", res)).toBe(true);
    expect(can(reporter, "project.update", res)).toBe(false);
    expect(can(reporter, "secret.reveal", res)).toBe(false);
  });

  test("variable.* reads and writes variables but never reveals a secret", () => {
    const t = token(["variable.*"]);
    for (const action of ["variable.read", "variable.create", "variable.org.update"]) {
      expect([action, can(t, action, res)]).toEqual([action, true]);
    }
    for (const action of ["secret.reveal", "secret.reveal.org"]) {
      expect([action, can(t, action, res)]).toEqual([action, false]);
    }
    expect(can(token(["secret.*"]), "secret.reveal.org", res)).toBe(true);
    expect(can(token(["secret.reveal"]), "secret.reveal.org", res)).toBe(false); // not a prefix match
  });

  test("resource.* covers that resource's actions only, * covers all", () => {
    expect(can(token(["environment.*"]), "environment.delete", res)).toBe(true);
    expect(can(token(["environment.*"]), "project.read", res)).toBe(false);
    expect(can(token(["env.*"]), "environment.read", res)).toBe(false); // not a prefix match
    expect(can(token(["*"]), "secret.reveal", res)).toBe(true);
  });

  test("scopes that are not a list of strings allow nothing, and never throw", () => {
    for (const scopes of [null, "project.read", { 0: "*" }, 42, [123], [null, {}], [["*"]]]) {
      const bad = { kind: "token", ...owner, scopes } as unknown as Subject;
      expect([scopes, can(bad, "project.read", res)]).toEqual([scopes, false]);
    }
    // A bad entry does not cancel a good one beside it.
    expect(can(token([123 as unknown as string, "project.read"]), "project.read", res)).toBe(true);
  });

  test("a scope is not a pattern", () => {
    for (const s of [
      "project",
      "project.rea",
      "project.read.",
      "project.*.read",
      "proj*",
      "project.read ",
      ".*",
    ]) {
      expect([s, can(token([s]), "project.read", res)]).toEqual([s, false]);
    }
  });

  test("a user's scopes, when given, narrow too; none means no narrowing", () => {
    expect(can(user({ ...owner, scopes: ["project.read"] }), "project.update", res)).toBe(false);
    expect(can(user({ ...owner }), "project.update", res)).toBe(true);
  });
});

describe("a subject tied to an environment", () => {
  const ENV = "env-1";
  const ci = (over: Partial<Subject> = {}): Subject => ({
    kind: "ci",
    orgRoles: {},
    projectRoles: { [PROJECT]: "maintainer" },
    scopes: ["*"],
    environmentId: ENV,
    ...over,
  });

  test("acts on the environment it is tied to", () => {
    expect(can(ci(), "environment.read", { ...res, environmentId: ENV })).toBe(true);
    expect(can(ci(), "environment.update", { ...res, environmentId: ENV })).toBe(true);
  });

  test("not on another environment, nor on a request that names none", () => {
    expect(can(ci(), "environment.read", { ...res, environmentId: "env-2" })).toBe(false);
    expect(can(ci(), "environment.read", res)).toBe(false);
    expect(can(ci(), "environment.read", { ...res, environmentId: "" })).toBe(false);
  });

  test("outside its environment it may read the project and nothing else", () => {
    expect(can(ci(), "project.read", res)).toBe(true);
    expect(can(ci(), "project.read", { ...res, environmentId: "env-2" })).toBe(true);
    for (const action of Object.keys(RULES).filter((a) => a !== "project.read")) {
      expect([action, can(ci(), action, res)]).toEqual([action, false]);
    }
    expect(can(ci(), "secret.reveal", { ...res, environmentId: "env-2" })).toBe(false);
  });

  test("a CI job's own grant is reading its project and revealing its environment, and nothing else", () => {
    const job = ci({ scopes: ["project.read", "environment.read", "secret.reveal"] });
    const own = { ...res, environmentId: ENV };
    const allowed = (resource: Resource) =>
      Object.keys(RULES)
        .filter((a) => can(job, a, resource))
        .sort();
    expect(allowed(own)).toEqual(["environment.read", "project.read", "secret.reveal"]);
    expect(allowed({ ...own, environmentId: "env-2" })).toEqual(["project.read"]);
    expect(allowed(res)).toEqual(["project.read"]);
    // another project's environment id does not help: the role is on one project only
    expect(allowed({ ...own, projectId: "project-2" })).toEqual([]);
  });

  test("a CI job with no environment may read its project and post a plan summary, on that project only", () => {
    const job = ci({ environmentId: undefined, scopes: ["project.read", "run.summary"] });
    const allowed = (resource: Resource) =>
      Object.keys(RULES)
        .filter((a) => can(job, a, resource))
        .sort();
    expect(allowed(res)).toEqual(["project.read", "run.summary"]);
    expect(allowed({ ...res, projectId: "project-2" })).toEqual([]);
  });

  test("roles and scopes still apply on its own environment", () => {
    const own = { ...res, environmentId: ENV };
    expect(can(ci({ projectRoles: { [PROJECT]: "reporter" } }), "environment.update", own)).toBe(
      false,
    );
    expect(can(ci({ scopes: ["project.read"] }), "environment.read", own)).toBe(false);
    expect(can(ci({ scopes: undefined }), "project.read", res)).toBe(false);
  });

  test("a subject tied to no environment is not held to one", () => {
    const free = ci({ environmentId: undefined });
    expect(can(free, "environment.read", res)).toBe(true);
    expect(can(free, "environment.read", { ...res, environmentId: "env-2" })).toBe(true);
  });
});

describe("visibleOrganizations", () => {
  const roles = { "org-a": "viewer", "org-b": "owner" } as const;

  test("lists the organizations the subject holds a role in", () => {
    expect(visibleOrganizations(user({ orgRoles: roles })).sort()).toEqual(["org-a", "org-b"]);
  });

  test("nothing without roles, with a project role alone, or without a subject", () => {
    expect(visibleOrganizations(user())).toEqual([]);
    expect(visibleOrganizations(projectRole("maintainer"))).toEqual([]);
    expect(visibleOrganizations(user({ platformAdmin: true }))).toEqual([]);
    expect(visibleOrganizations(undefined)).toEqual([]);
  });

  test("a role name nobody defined lists nothing", () => {
    const bad = user({ orgRoles: { "org-a": "superadmin" as OrgRole } });
    expect(visibleOrganizations(bad)).toEqual([]);
  });

  test("scopes narrow the list like they narrow everything else", () => {
    const token = (scopes?: string[]): Subject => ({
      kind: "token",
      orgRoles: roles,
      projectRoles: {},
      scopes,
    });
    expect(visibleOrganizations(token()).length).toBe(0);
    expect(visibleOrganizations(token(["project.read"])).length).toBe(0);
    expect(visibleOrganizations(token(["organization.read"])).sort()).toEqual(["org-a", "org-b"]);
  });
});

describe("isScope", () => {
  test("is an action, a resource wildcard of an existing resource, or everything", () => {
    for (const ok of ["*", ...Object.keys(RULES), "project.*", "organization.*", "secret.*"]) {
      expect([ok, isScope(ok)]).toEqual([ok, true]);
    }
  });

  test("is nothing else: no typos, no patterns, no empty parts", () => {
    for (const bad of [
      "",
      ".",
      ".*",
      "project",
      "project.",
      "project.reed",
      "proj.*",
      "proj*",
      "**",
      "*.read",
      "project.read.*",
      "constructor",
      "__proto__",
      "nothing.*",
    ]) {
      expect([bad, isScope(bad)]).toEqual([bad, false]);
    }
  });

  test("every scope it accepts is understood by can()", () => {
    const subject: Subject = {
      kind: "token",
      orgRoles: { [ORG]: "owner" },
      projectRoles: {},
      scopes: ["project.*"],
    };
    expect(can(subject, "project.read", res)).toBe(true);
    expect(can(subject, "environment.read", res)).toBe(false);
  });
});

describe("orgAccess", () => {
  const canDo = (r: OrgRole | undefined, action: string) =>
    orgAccess(r ? orgRole(r) : user(), ORG).actions.includes(action as never);

  test("names the role held in that organization, and nothing for another one", () => {
    expect(orgAccess(orgRole("member"), ORG).role).toBe("member");
    expect(orgAccess(orgRole("member"), "org-2").role).toBeUndefined();
    expect(orgAccess(user(), ORG).role).toBeUndefined();
  });

  test("lists the organization-level actions the role allows, matching `can`", () => {
    expect(canDo("viewer", "organization.read")).toBe(true);
    expect(canDo("viewer", "connection.read")).toBe(false);
    expect(canDo("member", "connection.read")).toBe(false);
    expect(canDo("admin", "connection.read")).toBe(true);
    expect(canDo("admin", "organization.delete")).toBe(false);
    expect(canDo("owner", "organization.delete")).toBe(true);
    // every action it lists is one `can` allows, and every org-level one `can` allows is listed
    for (const r of ORG_ROLES) {
      const subject = orgRole(r);
      const listed = orgAccess(subject, ORG).actions;
      const allowed = Object.keys(RULES).filter(
        (a) => "org" in RULES[a as keyof typeof RULES] && can(subject, a, { organizationId: ORG }),
      );
      expect([...listed].sort() as string[]).toEqual([...allowed].sort());
    }
  });

  test("leaves out project actions and the platform's, which a role in the org does not settle", () => {
    const actions = orgAccess(orgRole("owner"), ORG).actions as string[];
    expect(actions).not.toContain("variable.create");
    expect(actions).not.toContain("organization.create");
    // a platform admin who is also a member of the org still gets only what the role allows
    const both = orgAccess({ ...orgRole("viewer"), platformAdmin: true }, ORG).actions as string[];
    expect(both).not.toContain("organization.create");
    expect(both).toContain("organization.read");
  });

  test("scopes narrow it like they narrow everything else", () => {
    const token = (scopes: string[]): Subject => ({ ...orgRole("owner"), kind: "token", scopes });
    expect(orgAccess(token(["connection.read"]), ORG).actions).toEqual(["connection.read"]);
    expect(orgAccess(token([]), ORG).actions).toEqual([]);
  });

  test("a role name nobody defined, and an inherited key, give no role", () => {
    expect(
      orgAccess(user({ orgRoles: { [ORG]: "superadmin" as OrgRole } }), ORG).role,
    ).toBeUndefined();
    expect(orgAccess(orgRole("owner"), "__proto__").role).toBeUndefined();
  });
});
