import { and, asc, eq } from "drizzle-orm";
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

/** True when a row was deleted; its environments go with it. */
export async function deleteProject(db: Executor, organizationId: string, id: string) {
  const rows = await db.delete(projects).where(inOrg(organizationId, id)).returning();
  return rows.length > 0;
}

export async function createEnvironment(db: Executor, input: NewEnvironment) {
  return one(await db.insert(environments).values(input).returning());
}

export function listEnvironments(db: Executor, organizationId: string, projectId: string) {
  return db
    .select()
    .from(environments)
    .where(
      and(eq(environments.projectId, projectId), eq(environments.organizationId, organizationId)),
    )
    .orderBy(asc(environments.sortOrder), asc(environments.slug));
}
