import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { AuthStoreError, checkHash } from "./auth";
import { baseUrlOf, DOTCOM, ownedBy } from "./project-connection";
import type { Executor } from "./repo";
import { ciTokens, connections, environments, projects } from "./schema";

export type CiToken = typeof ciTokens.$inferSelect;

export const MAX_CI_TTL_MS = 3_600_000;

/**
 * The platform projects linked to a GitLab project: more than one is ambiguous, and callers refuse.
 * With a connection, only that connection's projects (see `ownedBy`): another instance's project
 * 42 is not this one.
 */
export async function projectsByGitlabId(
  db: Executor,
  gitlabProjectId: number,
  connectionId?: string,
) {
  return db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .where(
      and(
        eq(projects.gitlabProjectId, gitlabProjectId),
        connectionId ? await ownedBy(db, connectionId) : undefined,
      ),
    )
    .orderBy(asc(projects.id))
    .limit(2);
}

/**
 * The projects a CI token's verified issuer speaks for: those bound to a GitLab connection at that
 * address, and, when the issuer is the deployment's own (`GITLAB_URL`), those bound to none (they
 * predate connections, and the deployment's GitLab is where they came from). So a project has one
 * issuer and no other instance's project 42, nor a connection's address typed by someone else, reaches it.
 * More than one is ambiguous, and callers refuse.
 */
export async function projectsOfIssuer(
  db: Executor,
  gitlabProjectId: number,
  issuer: string,
  deploymentIssuer?: string,
) {
  const bound = and(eq(connections.type, "gitlab"), sql`rtrim(${baseUrlOf}, '/') = ${issuer}`);
  return db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .leftJoin(connections, eq(connections.id, projects.connectionId))
    .where(
      and(
        eq(projects.gitlabProjectId, gitlabProjectId),
        or(bound, issuer === deploymentIssuer ? isNull(projects.connectionId) : undefined),
      ),
    )
    .orderBy(asc(projects.id))
    .limit(2);
}

/**
 * The projects a GitHub Actions token's repository id speaks for: those bound to a github.com connection (FRG-23).
 * A repository id is one number across github.com and nowhere else, so a GitLab project, or a repository of a GitHub
 * Enterprise Server that has the same number, is not it. More than one is ambiguous, and callers refuse.
 */
export async function projectsOfGithubRepository(db: Executor, repositoryId: number) {
  return db
    .select({ id: projects.id, organizationId: projects.organizationId })
    .from(projects)
    .innerJoin(connections, eq(connections.id, projects.connectionId))
    .where(
      and(
        eq(projects.gitlabProjectId, repositoryId),
        eq(connections.type, "github"),
        sql`rtrim(${baseUrlOf}, '/') in (${sql.join(
          DOTCOM.map((u) => sql`${u}`),
          sql`, `,
        )})`,
      ),
    )
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
    gitlabPipelineId?: number;
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
