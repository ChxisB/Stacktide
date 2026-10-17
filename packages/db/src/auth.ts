import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Executor, Page } from "./repo";
import { apiTokens, cliLogins, sessions, users } from "./schema";

export type User = typeof users.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;

/** A refused input. The message never carries the value. */
export class AuthStoreError extends Error {
  override readonly name = "AuthStoreError";
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_TTL_MS = 90 * 86_400_000;

/** Throws unless a session may last `ttlMs`: callers check at start-up, not after a login code is spent. */
export function checkSessionTtl(ttlMs: number) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) {
    throw new AuthStoreError("session ttl must be between one second and 90 days");
  }
}

export function checkHash(tokenHash: string) {
  // Only a hash may reach the table: a caller that passes the cookie value itself is a bug.
  if (!SHA256_HEX.test(tokenHash))
    throw new AuthStoreError("tokenHash must be a SHA-256 hex digest");
}

/** Creates the user on first sign-in; later sign-ins refresh the name and the login time. */
export async function upsertUser(
  db: Executor,
  input: { gitlabId: number; username: string; name: string },
): Promise<User> {
  const [row] = await db
    .insert(users)
    .values(input)
    .onConflictDoUpdate({
      target: users.gitlabId,
      set: { username: input.username, name: input.name, lastLoginAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error("upsert returned no row");
  return row;
}

/**
 * Starts a session that ends `ttlMs` from now (database clock). Sessions that ended over a day ago
 * are deleted on the way, so the table does not need a cleanup job.
 */
export async function createSession(
  db: Executor,
  input: { userId: string; tokenHash: string; ttlMs: number },
): Promise<void> {
  checkHash(input.tokenHash);
  checkSessionTtl(input.ttlMs);
  await db.delete(sessions).where(sql`${sessions.expiresAt} < now() - interval '1 day'`);
  await db.insert(sessions).values({
    userId: input.userId,
    tokenHash: input.tokenHash,
    expiresAt: sql`now() + make_interval(secs => ${input.ttlMs / 1000})`,
  });
}

/** The live session behind a token hash and its user, or nothing (unknown, ended). */
export async function findSession(
  db: Executor,
  tokenHash: string,
): Promise<{ sessionId: string; user: User } | undefined> {
  checkHash(tokenHash);
  const [row] = await db
    .select({ sessionId: sessions.id, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`)));
  return row;
}

/** Ends a session. Returns whose it was, or nothing when there was none. */
export async function deleteSession(
  db: Executor,
  tokenHash: string,
): Promise<{ sessionId: string; userId: string } | undefined> {
  checkHash(tokenHash);
  const [row] = await db
    .delete(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .returning({ sessionId: sessions.id, userId: sessions.userId });
  return row;
}

export const MAX_TOKEN_TTL_DAYS = 365;
const MAX_TOKEN_TTL_MS = MAX_TOKEN_TTL_DAYS * 86_400_000;

/** Stores a token by its hash. It always expires `ttlMs` from now (database clock), within a year. */
export async function createApiToken(
  db: Executor,
  input: {
    userId: string;
    name: string;
    prefix: string;
    tokenHash: string;
    scopes: readonly string[];
    ttlMs: number;
  },
): Promise<ApiToken> {
  checkHash(input.tokenHash);
  if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1000 || input.ttlMs > MAX_TOKEN_TTL_MS) {
    throw new AuthStoreError("token ttl must be between one second and 365 days");
  }
  const { ttlMs, scopes, ...rest } = input;
  const [row] = await db
    .insert(apiTokens)
    .values({
      ...rest,
      scopes: [...scopes],
      expiresAt: sql`now() + make_interval(secs => ${ttlMs / 1000})`,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

/**
 * The live token behind a hash (not revoked, not expired) and its owner, or nothing. Records the
 * use, at most once a minute, so a busy token costs one query and no write on most requests.
 */
export async function useApiToken(
  db: Executor,
  tokenHash: string,
): Promise<{ token: ApiToken; user: User } | undefined> {
  checkHash(tokenHash);
  const [row] = await db
    .select({
      token: apiTokens,
      user: users,
      stale: sql<boolean>`${apiTokens.lastUsedAt} is null or ${apiTokens.lastUsedAt} < now() - interval '1 minute'`,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, tokenHash),
        isNull(apiTokens.revokedAt),
        gt(apiTokens.expiresAt, sql`now()`),
      ),
    );
  if (!row) return undefined;
  if (row.stale) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(apiTokens.id, row.token.id));
  }
  return { token: row.token, user: row.user };
}

/** The user's tokens, revoked and expired ones included, oldest first. */
export function listApiTokens(db: Executor, userId: string, page: Page<string>) {
  return db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), page.after ? gt(apiTokens.id, page.after) : undefined))
    .orderBy(asc(apiTokens.id))
    .limit(page.limit);
}

/** Revokes the user's own token. Nothing for an unknown, foreign or already revoked one. */
export async function revokeApiToken(
  db: Executor,
  userId: string,
  id: string,
): Promise<ApiToken | undefined> {
  const [row] = await db
    .update(apiTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning();
  return row;
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const CLI_LOGIN_TTL_MS = 120_000;

/**
 * Stores the one-time code of a browser sign-in for the CLI (it lives `CLI_LOGIN_TTL_MS`, database
 * clock). Codes that have run out are deleted on the way, so the table needs no cleanup job.
 */
export async function createCliLogin(
  db: Executor,
  input: { userId: string; codeHash: string; challenge: string },
): Promise<void> {
  checkHash(input.codeHash);
  if (!PKCE_CHALLENGE.test(input.challenge)) {
    throw new AuthStoreError("challenge must be a base64url SHA-256 digest");
  }
  await db.delete(cliLogins).where(sql`${cliLogins.expiresAt} < now()`);
  await db.insert(cliLogins).values({
    ...input,
    expiresAt: sql`now() + make_interval(secs => ${CLI_LOGIN_TTL_MS / 1000})`,
  });
}

/**
 * Takes a code: who it was issued to and the challenge it is bound to, or nothing (unknown, used,
 * expired). It is gone after this call whether or not the caller then proves it holds the verifier,
 * so a stolen code cannot be tried more than once.
 */
export async function takeCliLogin(
  db: Executor,
  codeHash: string,
): Promise<{ userId: string; challenge: string } | undefined> {
  checkHash(codeHash);
  const [row] = await db
    .delete(cliLogins)
    .where(and(eq(cliLogins.codeHash, codeHash), gt(cliLogins.expiresAt, sql`now()`)))
    .returning({ userId: cliLogins.userId, challenge: cliLogins.challenge });
  return row;
}

/** Revokes a token by its id, whoever owns it: for the token's own holder ending it. */
export async function revokeApiTokenById(db: Executor, id: string): Promise<ApiToken | undefined> {
  const [row] = await db
    .update(apiTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning();
  return row;
}
