import { and, asc, count, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { connections, projects } from "./schema";

/**
 * The projects of this connection: bound to it, or unbound while it is the organization's only
 * GitLab connection (an unbound project predates connections and cannot say which of two it came
 * from, so it is nobody's then). Nothing matches a connection that is gone.
 */
export async function ownedBy(db: Executor, connectionId: string): Promise<SQL> {
  const [c] = await db
    .select({ organizationId: connections.organizationId, type: connections.type })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!c) return sql`false`;
  const own = eq(projects.connectionId, connectionId);
  // shortcut: an unbound project is taken to be a GitLab one, so a GitHub project must be bound to its connection; the import does that (FRG-15), but nothing stops a hand-made link or a later writer from leaving it unbound.
  if (c.type !== "gitlab") return own;
  const [row] = await db
    .select({ n: count() })
    .from(connections)
    .where(and(eq(connections.organizationId, c.organizationId), eq(connections.type, c.type)));
  const unbound = and(isNull(projects.connectionId), eq(projects.organizationId, c.organizationId));
  return row?.n === 1 ? (or(own, unbound) ?? own) : own;
}

/**
 * The connection(s) a project could be talking to: its own, or for an unbound project the
 * organization's GitLab connections. One is the answer, none means there is no connection, two
 * is ambiguous and callers refuse (like `projectsByGitlabId`).
 */
export async function connectionsOfProject(db: Executor, projectId: string): Promise<string[]> {
  const [p] = await db
    .select({ organizationId: projects.organizationId, connectionId: projects.connectionId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!p) return [];
  if (p.connectionId) return [p.connectionId];
  const rows = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.organizationId, p.organizationId), eq(connections.type, "gitlab")))
    .orderBy(asc(connections.id))
    .limit(2);
  return rows.map((r) => r.id);
}

/**
 * A connection's `baseUrl`, read in SQL. The driver stores `config` as a JSON *string* in the jsonb column
 * (`jsonb_typeof` says `string`), where `->>` finds nothing; `#>> '{}'` unwraps that, and also reads a real object.
 */
export const baseUrlOf = sql<
  string | null
>`((${connections.config} #>> '{}')::jsonb ->> 'baseUrl')`;

/**
 * The GitLab connections whose address is this issuer (a job token's `iss`: the instance URL without a
 * trailing slash), with the address as stored. Only a registered address is one whose keys the
 * platform will fetch; the token never names a URL to call.
 */
export async function connectionsByIssuer(db: Executor, issuer: string) {
  const rows = await db
    .select({ id: connections.id, baseUrl: baseUrlOf })
    .from(connections)
    .where(and(eq(connections.type, "gitlab"), sql`rtrim(${baseUrlOf}, '/') = ${issuer}`))
    .orderBy(asc(connections.id));
  return rows;
}

/** The web addresses a github.com connection is made with (`apiRootOf` in `@orch/github` serves both from api.github.com). */
export const DOTCOM = ["https://github.com", "https://api.github.com"];

/**
 * Which forge each project is on, in the order given: its connection's type when that is GitHub, else GitLab (a
 * project with no connection predates them and is a GitLab one, as `ownedBy` takes it).
 */
export async function forgesOfProjects(
  db: Executor,
  rows: readonly { connectionId: string | null }[],
): Promise<("gitlab" | "github")[]> {
  const ids = [...new Set(rows.flatMap((r) => (r.connectionId ? [r.connectionId] : [])))];
  const found = ids.length
    ? await db
        .select({ id: connections.id, type: connections.type })
        .from(connections)
        .where(inArray(connections.id, ids))
    : [];
  const hub = new Set(found.filter((c) => c.type === "github").map((c) => c.id));
  return rows.map((r) => (r.connectionId && hub.has(r.connectionId) ? "github" : "gitlab"));
}
