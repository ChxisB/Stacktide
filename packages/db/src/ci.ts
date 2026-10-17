import { and, asc, eq, gt, sql } from "drizzle-orm";
import { AuthStoreError, checkHash } from "./auth";
import type { Executor } from "./repo";
import { ciTokens, environments, projects } from "./schema";

export type CiToken = typeof ciTokens.$inferSelect;

export const MAX_CI_TTL_MS = 3_600_000;

/** The platform projects linked to a GitLab project: more than one is ambiguous, and callers refuse. */
export function projectsByGitlabId(db: Executor, gitlabProjectId: number) {
  return db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.gitlabProjectId, gitlabProjectId))
    .orderBy(asc(projects.id))
    .limit(2);
}

/** The environment of a project with this slug, or nothing. */
export async function environmentBySlug(db: Executor, projectId: string, slug: string) {
  const [row] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.slug, slug)));
  return row;
}

/**
 * Stores a CI token by its hash. It expires `ttlMs` from now (database clock), within an hour.
 * Tokens that expired over a day ago are deleted on the way, so the table needs no cleanup job.
 */
export async function createCiToken(
  db: Executor,
  input: {
    organizationId: string;
    projectId: string;
    environmentId?: string;
    tokenHash: string;
    scopes: readonly string[];
    gitlabProjectId: number;
    gitlabJobId?: number;
    ref: string;
    refProtected: boolean;
    ttlMs: number;
  },
): Promise<CiToken> {
  checkHash(input.tokenHash);
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1000 || input.ttlMs > MAX_CI_TTL_MS) {
    throw new AuthStoreError("ci token ttl must be between one second and one hour");
  }
  const { ttlMs, scopes, ...rest } = input;
  await db.delete(ciTokens).where(sql`${ciTokens.expiresAt} < now() - interval '1 day'`);
  const [row] = await db
    .insert(ciTokens)
    .values({
      ...rest,
      scopes: [...scopes],
      expiresAt: sql`now() + make_interval(secs => ${ttlMs / 1000})`,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

/** The CI token behind a hash if it has not expired, or nothing. */
export async function useCiToken(db: Executor, tokenHash: string): Promise<CiToken | undefined> {
  checkHash(tokenHash);
  const [row] = await db
    .select()
    .from(ciTokens)
    .where(and(eq(ciTokens.tokenHash, tokenHash), gt(ciTokens.expiresAt, sql`now()`)));
  return row;
}
