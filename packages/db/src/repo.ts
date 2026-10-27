import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { BunSQLQueryResultHKT } from "drizzle-orm/bun-sql";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { baseUrlOf, DOTCOM } from "./project-connection";
import type * as schema from "./schema";
import { connections, environments, organizations, projects } from "./schema";

/** A `Db` or a transaction: repo functions work inside either, so callers can add audit writes. */
export type Executor = PgDatabase<BunSQLQueryResultHKT, typeof schema>;

type NewOrganization = typeof organizations.$inferInsert;
type NewProject = typeof projects.$inferInsert;
type NewEnvironment = typeof environments.$inferInsert;

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function createOrganization(db: Executor, input: NewOrganization) {
  return one(await db.insert(organizations).values(input).returning());
}

/** Drops `undefined` entries; a patch is applied only for the fields that were given. */
const given = <T extends object>(patch: T) =>
  Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as T;

export interface Page<K> {
  /** Keyset position: the last row of the previous page. */
  after?: K;
  limit: number;
}

export async function getOrganization(db: Executor, id: string) {
  return (await db.select().from(organizations).where(eq(organizations.id, id)))[0];
}

/** Ordered by id, which is time-ordered (v7): creation order. `only` limits the list to these ids. */
export function listOrganizations(db: Executor, page: Page<string>, only?: readonly string[]) {
  return db
    .select()
    .from(organizations)
    .where(
      and(
        page.after ? gt(organizations.id, page.after) : undefined,
        only ? inArray(organizations.id, [...only]) : undefined,
      ),
    )
    .orderBy(asc(organizations.id))
    .limit(page.limit);
}

/** The updated row, or undefined when there is none. */
export async function updateOrganization(db: Executor, id: string, patch: { name?: string }) {
  const set = given(patch);
  if (Object.keys(set).length === 0) return getOrganization(db, id);
  const rows = await db.update(organizations).set(set).where(eq(organizations.id, id)).returning();
  return rows[0];
}

/** True when a row was deleted. Fails (RESTRICT) while the organization still has projects. */
export async function deleteOrganization(db: Executor, id: string) {
  const rows = await db.delete(organizations).where(eq(organizations.id, id)).returning();
  return rows.length > 0;
}

export async function createProject(db: Executor, input: NewProject) {
  return one(await db.insert(projects).values(input).returning());
}

// Lookups below take the organization too, so a guessed id from another tenant matches nothing.
const inOrg = (organizationId: string, id: string) =>
  and(eq(projects.id, id), eq(projects.organizationId, organizationId));

export async function getProject(db: Executor, organizationId: string, id: string) {
  return (await db.select().from(projects).where(inOrg(organizationId, id)))[0];
}

export function listProjects(db: Executor, organizationId: string, page: Page<string>) {
  return db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        page.after ? gt(projects.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(projects.id))
    .limit(page.limit);
}

export async function updateProject(
  db: Executor,
  organizationId: string,
  id: string,
  patch: { name?: string; gitlabProjectId?: number | null; defaultBranch?: string },
) {
  const set = given(patch);
  if (Object.keys(set).length === 0) return getProject(db, organizationId, id);
  const rows = await db.update(projects).set(set).where(inOrg(organizationId, id)).returning();
  return rows[0];
}

/** True when a row was deleted; its environments go with it. */
export async function deleteProject(db: Executor, organizationId: string, id: string) {
  const rows = await db.delete(projects).where(inOrg(organizationId, id)).returning();
  return rows.length > 0;
}

export async function createEnvironment(db: Executor, input: NewEnvironment) {
  return one(await db.insert(environments).values(input).returning());
}

const inProject = (organizationId: string, projectId: string) =>
  and(eq(environments.projectId, projectId), eq(environments.organizationId, organizationId));

const envIs = (organizationId: string, projectId: string, id: string) =>
  and(inProject(organizationId, projectId), eq(environments.id, id));

export async function getEnvironment(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
) {
  const where = envIs(organizationId, projectId, id);
  return (await db.select().from(environments).where(where))[0];
}

export async function updateEnvironment(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
  patch: { name?: string; sortOrder?: number },
) {
  const set = given(patch);
  if (Object.keys(set).length === 0) return getEnvironment(db, organizationId, projectId, id);
  const where = envIs(organizationId, projectId, id);
  return (await db.update(environments).set(set).where(where).returning())[0];
}

/**
 * The environment, locked until the transaction ends: `share` keeps its protection from being
 * switched while a variable is written (a write that sees it unprotected commits before protection
 * turns on), `update` is for changing it or deleting the environment.
 */
export async function lockEnvironment(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
  mode: "share" | "update",
) {
  const where = envIs(organizationId, projectId, id);
  return (await db.select().from(environments).where(where).for(mode))[0];
}

/** Turns protection on or off. Undefined when there is no such environment; `previous` is what it was. */
export async function setEnvironmentProtection(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
  value: boolean,
) {
  const was = await lockEnvironment(db, organizationId, projectId, id, "update");
  if (!was) return undefined;
  const where = envIs(organizationId, projectId, id);
  const [env] = await db.update(environments).set({ protected: value }).where(where).returning();
  return env && { env, previous: was.protected };
}

/** True when a row was deleted. */
export async function deleteEnvironment(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
) {
  const where = envIs(organizationId, projectId, id);
  return (await db.delete(environments).where(where).returning()).length > 0;
}

/**
 * Ordered by (sort_order, slug); slug is unique per project, so the order is total and `after`
 * (the last row's pair) pages without skipping or repeating. Without `page`: all of them.
 */
export function listEnvironments(
  db: Executor,
  organizationId: string,
  projectId: string,
  page?: Partial<Page<[number, string]>>,
) {
  const after = page?.after;
  const query = db
    .select()
    .from(environments)
    .where(
      and(
        inProject(organizationId, projectId),
        after
          ? sql`(${environments.sortOrder}, ${environments.slug}) > (${after[0]}, ${after[1]})`
          : undefined,
      ),
    )
    .orderBy(asc(environments.sortOrder), asc(environments.slug));
  return page?.limit === undefined ? query : query.limit(page.limit);
}

/**
 * What AUTH-5 asks GitLab about: every organization linked to a GitLab group and every project
 * linked to a GitLab project, with the platform ids that roles are keyed by. Only the deployment's own
 * GitLab (`deploymentUrl`, `GITLAB_URL`) is asked: people sign in to it, so their `gitlab_id` is an id
 * there and nowhere else. A project bound to a connection at another address is left out (FRG-6), or user
 * 100 on one instance would hold the roles of user 100 on the other. An unbound project is the deployment's.
 * shortcut: a group link is taken to be the deployment's GitLab too; it has no connection of its own until
 * a second instance has its own OAuth sign-in.
 */
export async function gitlabLinks(db: Executor, deploymentUrl: string) {
  const orgs = await db
    .select({ organizationId: organizations.id, gitlabGroupId: organizations.gitlabGroupId })
    .from(organizations)
    .where(isNotNull(organizations.gitlabGroupId))
    .orderBy(asc(organizations.id));
  const projs = await db
    .select({ projectId: projects.id, gitlabProjectId: projects.gitlabProjectId })
    .from(projects)
    .leftJoin(connections, eq(connections.id, projects.connectionId))
    .where(
      and(
        isNotNull(projects.gitlabProjectId),
        or(
          isNull(projects.connectionId),
          and(
            eq(connections.type, "gitlab"),
            sql`rtrim(${baseUrlOf}, '/') = ${deploymentUrl.replace(/\/+$/, "")}`,
          ),
        ),
      ),
    )
    .orderBy(asc(projects.id));
  return {
    groups: orgs.flatMap((o) =>
      o.gitlabGroupId === null ? [] : [{ ...o, gitlabGroupId: o.gitlabGroupId }],
    ),
    projects: projs.flatMap((p) =>
      p.gitlabProjectId === null ? [] : [{ ...p, gitlabProjectId: p.gitlabProjectId }],
    ),
  };
}

/** The organizations linked to a GitHub organization (FRG-34): whose members' roles GitHub is asked about. */
export async function githubOrgLinks(db: Executor) {
  const rows = await db
    .select({ organizationId: organizations.id, githubOrgId: organizations.githubOrgId })
    .from(organizations)
    .where(isNotNull(organizations.githubOrgId))
    .orderBy(asc(organizations.id));
  return rows.flatMap((o) =>
    o.githubOrgId === null ? [] : [{ ...o, githubOrgId: o.githubOrgId }],
  );
}

/**
 * The repositories a GitHub account's project roles are read from (FRG-25): the projects bound to a github.com
 * connection, with the repository id (`gitlabProjectId` holds it for these projects) and the connection whose token
 * reads who may do what there. A GitLab project, an unbound one and an Enterprise Server's repository are not: a
 * person's GitHub id is one number on github.com and means nothing elsewhere.
 */
export async function githubLinks(db: Executor) {
  const rows = await db
    .select({
      projectId: projects.id,
      organizationId: projects.organizationId,
      connectionId: connections.id,
      repositoryId: projects.gitlabProjectId,
    })
    .from(projects)
    .innerJoin(connections, eq(connections.id, projects.connectionId))
    .where(
      and(
        eq(connections.type, "github"),
        isNotNull(projects.gitlabProjectId),
        sql`rtrim(${baseUrlOf}, '/') in (${sql.join(
          DOTCOM.map((u) => sql`${u}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(asc(projects.id));
  return rows.flatMap((r) =>
    r.repositoryId === null ? [] : [{ ...r, repositoryId: r.repositoryId }],
  );
}
