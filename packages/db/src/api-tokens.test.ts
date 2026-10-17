import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  AuthStoreError,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  upsertUser,
  useApiToken,
} from "./auth";
import { apiTokens, users } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

let n = 0;
const hash = () => (++n).toString(16).padStart(64, "0");
const newUser = () => upsertUser(t.db, { gitlabId: 5_000_000 + ++n, username: `u${n}`, name: "U" });
async function newToken(over: Partial<Parameters<typeof createApiToken>[1]> = {}) {
  const userId = over.userId ?? (await newUser()).id;
  const tokenHash = hash();
  const token = await createApiToken(t.db, {
    userId,
    name: "ci",
    prefix: "orch_abcdefgh",
    tokenHash,
    scopes: ["project.read"],
    ttlMs: 60_000,
    ...over,
  });
  return { token, tokenHash, userId };
}

describe("createApiToken", () => {
  test("stores the hash, scopes and an expiry on the database clock", async () => {
    const { token, tokenHash, userId } = await newToken({ scopes: ["a", "b.*"], ttlMs: 3_600_000 });
    expect(token).toMatchObject({
      userId,
      name: "ci",
      prefix: "orch_abcdefgh",
      tokenHash,
      scopes: ["a", "b.*"],
      lastUsedAt: null,
      revokedAt: null,
    });
    const left = token.expiresAt.getTime() - Date.now();
    expect(left).toBeGreaterThan(3_500_000);
    expect(left).toBeLessThan(3_700_000);
  });

  test("refuses anything but a SHA-256 digest, and a lifetime outside one second to a year", async () => {
    const userId = (await newUser()).id;
    const base = { userId, name: "x", prefix: "orch_x", scopes: ["a"] };
    await expect(
      createApiToken(t.db, { ...base, tokenHash: "orch_secret", ttlMs: 60_000 }),
    ).rejects.toThrow(AuthStoreError);
    for (const ttlMs of [0, 999, 1.5, Number.NaN, 366 * 86_400_000]) {
      await expect(createApiToken(t.db, { ...base, tokenHash: hash(), ttlMs })).rejects.toThrow(
        AuthStoreError,
      );
    }
    await createApiToken(t.db, { ...base, tokenHash: hash(), ttlMs: 365 * 86_400_000 });
  });

  test("two tokens never share a hash", async () => {
    const { tokenHash, userId } = await newToken();
    await expect(newToken({ userId, tokenHash })).rejects.toThrow();
  });

  test("goes away with its user", async () => {
    const { token, userId } = await newToken();
    await t.db.delete(users).where(eq(users.id, userId));
    expect(await t.db.select().from(apiTokens).where(eq(apiTokens.id, token.id))).toEqual([]);
  });
});

describe("useApiToken", () => {
  test("finds a live token with its owner and records the first use", async () => {
    const { token, tokenHash, userId } = await newToken();
    const found = await useApiToken(t.db, tokenHash);
    expect(found?.token.id).toBe(token.id);
    expect(found?.user.id).toBe(userId);
    const [row] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, token.id));
    expect(row?.lastUsedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("records a use at most once a minute", async () => {
    const { token, tokenHash } = await newToken();
    await useApiToken(t.db, tokenHash);
    const stamp = async () =>
      (await t.db.select().from(apiTokens).where(eq(apiTokens.id, token.id)))[0];
    const first = (await stamp())?.lastUsedAt;
    await useApiToken(t.db, tokenHash);
    expect((await stamp())?.lastUsedAt).toEqual(first);
    await t.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date(Date.now() - 120_000) })
      .where(eq(apiTokens.id, token.id));
    await useApiToken(t.db, tokenHash);
    expect((await stamp())?.lastUsedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("an unknown, expired or revoked token is nothing, and records no use", async () => {
    expect(await useApiToken(t.db, hash())).toBeUndefined();
    const expired = await newToken();
    await t.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, expired.token.id));
    expect(await useApiToken(t.db, expired.tokenHash)).toBeUndefined();
    const revoked = await newToken();
    await revokeApiToken(t.db, revoked.userId, revoked.token.id);
    expect(await useApiToken(t.db, revoked.tokenHash)).toBeUndefined();
    for (const { token } of [expired, revoked]) {
      const [row] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, token.id));
      expect(row?.lastUsedAt).toBeNull();
    }
  });

  test("only a digest is looked up", async () => {
    await expect(useApiToken(t.db, "orch_abcdefgh.secret")).rejects.toThrow(AuthStoreError);
  });
});

describe("revokeApiToken", () => {
  test("revokes the owner's token once", async () => {
    const { token, userId } = await newToken();
    const done = await revokeApiToken(t.db, userId, token.id);
    expect(done?.revokedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await revokeApiToken(t.db, userId, token.id)).toBeUndefined();
  });

  test("never someone else's, and not an unknown id", async () => {
    const { token, tokenHash } = await newToken();
    const other = await newUser();
    expect(await revokeApiToken(t.db, other.id, token.id)).toBeUndefined();
    expect(await revokeApiToken(t.db, other.id, crypto.randomUUID())).toBeUndefined();
    expect(await useApiToken(t.db, tokenHash)).toBeDefined();
  });
});

describe("listApiTokens", () => {
  test("lists the user's tokens only, revoked ones too, in pages", async () => {
    const userId = (await newUser()).id;
    const made = [];
    for (let i = 0; i < 3; i++) made.push((await newToken({ userId })).token);
    await newToken(); // someone else's
    await revokeApiToken(t.db, userId, made[1]?.id ?? "");
    const first = await listApiTokens(t.db, userId, { limit: 2 });
    const rest = await listApiTokens(t.db, userId, { limit: 2, after: first[1]?.id });
    expect([...first, ...rest].map((r) => r.id)).toEqual(made.map((r) => r.id));
    expect([...first, ...rest].map((r) => r.revokedAt !== null)).toEqual([false, true, false]);
  });
});
