import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { BunSQLQueryResultHKT } from "drizzle-orm/bun-sql";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type * as schema from "./schema";
import { environments, organizations, projects } from "./schema";

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
