import { and, eq, gt, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { sessions, users } from "./schema";

export type User = typeof users.$inferSelect;

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

function checkHash(tokenHash: string) {
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
