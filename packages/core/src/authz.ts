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
  // Variables: a project's and an environment's need a project role, the organization's an org role.
  // Reading lists key names and `plain` values; the value of a `secret` or `file` comes out only
  // through `secret.reveal` (or `secret.reveal.org`), which is audited.
  "variable.read": { project: "reporter" },
  "variable.create": { project: "maintainer" },
  "variable.update": { project: "maintainer" },
  "variable.delete": { project: "maintainer" },
  "secret.reveal": { project: "maintainer" },
  // Putting a variable or a whole level back to an earlier moment (and the plan that compares secrets with their past): its own action, so a token needs it by name.
  "variable.restore": { project: "maintainer" },
  // Bringing in a file or a GitLab project's variables compares the incoming values with the secrets held: the same people who may reveal, and a name of its own.
  "variable.import": { project: "maintainer" },
  // Setting, renaming and deleting many at once, previewed first (the preview compares values with the secrets held): one action, so a token is given the whole bundle by name.
  "variable.bulk": { project: "maintainer" },
  "variable.org.read": { org: "viewer" },
  "variable.org.create": { org: "admin" },
  "variable.org.update": { org: "admin" },
  "variable.org.delete": { org: "admin" },
  "secret.reveal.org": { org: "admin" },
  "variable.org.restore": { org: "admin" },
  "variable.org.import": { org: "admin" },
  "variable.org.bulk": { org: "admin" },
  // Credentials for outside systems: org admins only, also to read (what they connect to is theirs to know).
  "connection.create": { org: "admin" },
  "connection.read": { org: "admin" },
  "connection.test": { org: "admin" },
  "connection.delete": { org: "admin" },
  // Issuing the secret GitLab signs a connection's webhooks with.
  "connection.webhook": { org: "admin" },
  // Reading a connection's GitLab with its token and bringing projects in: the same org admins.
  "project.import": { org: "admin" },
  // A sync target aims an organization's connection token at a GitLab project or group, so changing one is as privileged as the connection: org admins, not the project's maintainers. Reading one shows no credential.
  "sync.target.read": { project: "reporter" },
  "sync.target.create": { org: "admin" },
  "sync.target.update": { org: "admin" },
  "sync.target.delete": { org: "admin" },
  // Planning opens every secret of the project and the connection token and compares them with the target: an equality oracle, so the people who may reveal a secret. A stored plan holds keys, scopes and actions only.
  "sync.plan": { project: "maintainer" },
  "sync.run.read": { project: "reporter" },
  // Applying writes to the target with the organization's connection token, from a plan made by someone who may plan: the same people.
  "sync.apply": { project: "maintainer" },
  // What a project's pipeline is set up with: template, parameters and the merge request. Nothing secret.
  "pipeline.read": { project: "reporter" },
  // Previewing and applying a pipeline use the organization's connection token on the project's repository, and an override can add any job to the file: as privileged as a sync target, so org admins.
  "pipeline.apply": { org: "admin" },
  // A fleet upgrade is pipeline.apply on every project that uses a template: listing, dry-running and applying it take the same people.
  "pipeline.upgrade": { org: "admin" },
  // Retrying runs the failed jobs of a pipeline again: the same commit and the same jobs, so no new code, only the project's runners and CI variables once more.
  "pipeline.retry": { project: "maintainer" },
  // Runs of IaC stacks: a plan only reads the project's repository and runs its own CI, as any merge request does, so developers may start one and reporters may read. What a run holds is names, a commit and states.
  "run.read": { project: "reporter" },
  "run.create": { project: "developer" },
  // The plan summary a plan job posts for its own stack (counts and addresses). A reporter-level rule, as the CI token is a reporter: the route further requires that the caller is the CI job recorded for that stack's summary.
  "run.summary": { project: "reporter" },
  // Applying a saved plan changes real infrastructure with the credentials of the project's runners: a maintainer, as for retrying a pipeline, and not a developer, who may start a plan. Merging is a separate decision, made in GitLab.
  "run.apply": { project: "maintainer" },
  // Notification sinks hold an address that is itself a credential (a Slack hook, a webhook with a token) and send out of the platform: org admins create, list and delete them, as for connections. A project's reporters may see which sinks hear of the project; choosing them is the admins' too, as it decides what leaves.
  "notification.sink.read": { org: "admin" },
  "notification.sink.create": { org: "admin" },
  "notification.sink.delete": { org: "admin" },
  "notification.subscription.read": { project: "reporter" },
  "notification.subscription.update": { org: "admin" },
  // Policy sets decide which plans may be applied: an organization's, so org admins write them, as for sinks, and everyone in the organization may read what they are. A project's maintainers apply plans, so they must not be the ones to take a policy away.
  "policy.set.read": { org: "viewer" },
  "policy.set.create": { org: "admin" },
  "policy.set.delete": { org: "admin" },
  // The audit log (GOV-1) shows who did what in the organization: org admins, as for the other things that show how it is run. Exporting hands the whole log out and is audited, so it is an action of its own that a token is given by name. The retention is the one way events are ever deleted: only an owner chooses how long they are kept.
  "audit.read": { org: "admin" },
  "audit.export": { org: "admin" },
  "audit.retention.read": { org: "admin" },
  "audit.retention.update": { org: "owner" },
} as const satisfies Record<string, Rule>;
export type Action = keyof typeof RULES;

export const isAction = (action: string): action is Action => Object.hasOwn(RULES, action);

/** A scope a token may carry: one that allows at least one action. */
export const isScope = (scope: string) => Object.keys(RULES).some((a) => scopeMatches(scope, a));

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
  /** Ties the subject to one environment (a CI job's): see `can()`. */
  environmentId?: string;
}

/**
 * The ids the caller's request is held to: a handler may take them from the path only if every
 * query it runs repeats them (so `/organizations/A/projects/P` with a P that is in B finds
 * nothing). Never an id from a body.
 */
export interface Resource {
  organizationId?: string;
  projectId?: string;
  /** The environment the request names, from the path. */
  environmentId?: string;
}

const KINDS: readonly string[] = ["user", "token", "ci"];

/** The own value of `key`: an id like `__proto__` or `constructor` must not find a role. */
const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string | undefined) =>
  record && key !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

/** Does `scope` allow `action`? An action, `resource.*` or `*`: nothing else is a pattern. */
const scopeMatches = (scope: string, action: string) =>
  scope === "*" ||
  scope === action ||
  (scope.endsWith(".*") && action.startsWith(scope.slice(0, -1)));

// Scopes may come from decoded claims: anything that is not a list of strings allows nothing.
const inScope = (scopes: unknown, action: string) =>
  Array.isArray(scopes) && scopes.some((s) => typeof s === "string" && scopeMatches(s, action));

/** What a subject tied to one environment may do outside that environment. */
const BEYOND_ENVIRONMENT: readonly string[] = ["project.read"];

/**
 * Pure and total: bad input, an unknown action or an unknown role is a no. A subject tied to an
 * environment may do nothing but read the project, except on resources that name that environment
 * (so a list of environments is not for it either).
 */
export function can(subject: Subject, action: string, resource: Resource = {}): boolean {
  if (!isAction(action) || !KINDS.includes(subject.kind)) return false;
  if (subject.scopes === undefined ? subject.kind !== "user" : !inScope(subject.scopes, action)) {
    return false;
  }
  if (
    subject.environmentId !== undefined &&
    resource.environmentId !== subject.environmentId &&
    !BEYOND_ENVIRONMENT.includes(action)
  ) {
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

/**
 * What a screen may offer `subject` in one organization: its role there and the organization-level
 * actions it may do (project actions depend on the project, so they are not listed). Only for
 * choosing what to show: the guard still decides every request.
 */
export function orgAccess(
  subject: Subject,
  organizationId: string,
): { role: OrgRole | undefined; actions: Action[] } {
  const held = own(subject.orgRoles, organizationId);
  return {
    role: ORG_ROLES.find((r) => r === held),
    actions: (Object.keys(RULES) as Action[]).filter(
      (a) => "org" in RULES[a] && can(subject, a, { organizationId }),
    ),
  };
}

/** The organizations `subject` may read, for narrowing a list. A subject without roles sees none. */
export function visibleOrganizations(subject: Subject | undefined): string[] {
  if (!subject) return [];
  return Object.keys(subject.orgRoles).filter((id) =>
    can(subject, "organization.read", { organizationId: id }),
  );
}
