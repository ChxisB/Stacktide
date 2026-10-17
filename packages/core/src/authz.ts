/** Org roles, lowest first. They apply to every project of the org. */
export const ORG_ROLES = ["viewer", "member", "admin", "owner"] as const;
/** Project roles, lowest first. They apply to one project, on top of what its org confers. */
export const PROJECT_ROLES = ["reporter", "developer", "maintainer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** The project role an org role confers on every project in that org. */
const INHERITED: Record<OrgRole, ProjectRole> = {
  viewer: "reporter",
  member: "developer",
  admin: "maintainer",
  owner: "maintainer",
};

/**
 * What an action needs: `platform` (a platform admin, no org exists yet), `org` (at least that role
 * in the resource's org) or `project` (at least that role on the resource's project, direct or
 * inherited from the org). Later features add their actions here, nowhere else.
 */
type Rule = { platform: true } | { org: OrgRole } | { project: ProjectRole };
export const RULES = {
  "organization.create": { platform: true },
  "organization.read": { org: "viewer" },
  "organization.update": { org: "admin" },
  "organization.delete": { org: "owner" },
  "project.create": { org: "admin" },
  "project.read": { project: "reporter" },
  "project.update": { project: "maintainer" },
  "project.delete": { org: "admin" },
  "environment.read": { project: "reporter" },
  "environment.create": { project: "maintainer" },
  "environment.update": { project: "maintainer" },
  "environment.delete": { project: "maintainer" },
  "secret.reveal": { project: "maintainer" },
} as const satisfies Record<string, Rule>;
export type Action = keyof typeof RULES;

export const isAction = (action: string): action is Action => Object.hasOwn(RULES, action);

/** Who is asking, as resolved by the caller from the session, token or CI claims. */
export interface Subject {
  kind: "user" | "token" | "ci";
  /** May create organizations. Ignored for CI jobs. */
  platformAdmin?: boolean;
  /** Org id -> role. */
  orgRoles: Readonly<Record<string, OrgRole>>;
  /** Project id -> role (direct membership). */
  projectRoles: Readonly<Record<string, ProjectRole>>;
  /**
   * Narrows what the roles allow: an action, `resource.*` or `*`. Tokens and CI jobs must have
   * them (none means nothing is allowed); for users they are optional.
   */
  scopes?: readonly string[];
}

/** Ids come from the stored row of the thing being touched, never from the request. */
export interface Resource {
  organizationId?: string;
  projectId?: string;
}

const KINDS: readonly string[] = ["user", "token", "ci"];

/** The own value of `key`: an id like `__proto__` or `constructor` must not find a role. */
const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string | undefined) =>
  record && key !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

// Scopes may come from decoded claims: anything that is not a list of strings allows nothing.
const inScope = (scopes: unknown, action: string) =>
  Array.isArray(scopes) &&
  scopes.some(
    (s) =>
      typeof s === "string" &&
      (s === "*" || s === action || (s.endsWith(".*") && action.startsWith(s.slice(0, -1)))),
  );

/** Pure and total: bad input, an unknown action or an unknown role is a no. */
export function can(subject: Subject, action: string, resource: Resource = {}): boolean {
  if (!isAction(action) || !KINDS.includes(subject.kind)) return false;
  if (subject.scopes === undefined ? subject.kind !== "user" : !inScope(subject.scopes, action)) {
    return false;
  }
  const rule: Rule = RULES[action];
  if ("platform" in rule) return subject.platformAdmin === true && subject.kind !== "ci";

  const orgRank = ORG_ROLES.indexOf(own(subject.orgRoles, resource.organizationId) as OrgRole);
  if ("org" in rule) return orgRank >= ORG_ROLES.indexOf(rule.org);

  // A project action needs both ids: an org-only resource has no project to hold a role on.
  if (resource.organizationId === undefined || resource.projectId === undefined) return false;
  const inherited =
    orgRank < 0 ? -1 : PROJECT_ROLES.indexOf(INHERITED[ORG_ROLES[orgRank] as OrgRole]);
  const direct = PROJECT_ROLES.indexOf(
    own(subject.projectRoles, resource.projectId) as ProjectRole,
  );
  return Math.max(inherited, direct) >= PROJECT_ROLES.indexOf(rule.project);
}
