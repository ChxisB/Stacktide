import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  AuthStoreError,
  createApiToken,
  createCliLogin,
  revokeApiTokenById,
  takeCliLogin,
  upsertUser,
} from "./auth";
import { cliLogins, users } from "./schema";
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
const challenge = () => `${"A".repeat(42)}${n++ % 10}`;
const newUser = () => upsertUser(t.db, { gitlabId: 6_000_000 + ++n, username: `u${n}`, name: "U" });
const rows = () => t.db.select().from(cliLogins);

describe("the one-time code of a browser sign-in", () => {
  test("is taken once, by its hash, with the user and the challenge it was issued for", async () => {
    const user = await newUser();
    const [codeHash, c] = [hash(), challenge()];
    await createCliLogin(t.db, { userId: user.id, codeHash, challenge: c });
    expect(await takeCliLogin(t.db, codeHash)).toEqual({ userId: user.id, challenge: c });
    expect(await takeCliLogin(t.db, codeHash)).toBeUndefined();
  });

  test("a code still waiting is not touched by another one being issued", async () => {
    const user = await newUser();
    const [first, second] = [hash(), hash()];
    await createCliLogin(t.db, { userId: user.id, codeHash: first, challenge: challenge() });
    await createCliLogin(t.db, { userId: user.id, codeHash: second, challenge: challenge() });
    expect(await takeCliLogin(t.db, first)).toBeDefined();
    expect(await takeCliLogin(t.db, second)).toBeDefined();
  });

  test("an unknown code is nothing", async () => {
    expect(await takeCliLogin(t.db, hash())).toBeUndefined();
  });

  test("a code that has run out is nothing, and is not kept as a second chance", async () => {
    const user = await newUser();
    const codeHash = hash();
    await createCliLogin(t.db, { userId: user.id, codeHash, challenge: challenge() });
    await t.db
      .update(cliLogins)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(cliLogins.codeHash, codeHash));
    expect(await takeCliLogin(t.db, codeHash)).toBeUndefined();
  });

  test("lives two minutes on the database clock", async () => {
    const user = await newUser();
    const codeHash = hash();
    await createCliLogin(t.db, { userId: user.id, codeHash, challenge: challenge() });
    const [row] = await t.db
      .select({ seconds: sql<number>`extract(epoch from (${cliLogins.expiresAt} - now()))` })
      .from(cliLogins)
      .where(eq(cliLogins.codeHash, codeHash));
    const seconds = Number(row?.seconds);
    expect(seconds).toBeGreaterThan(110);
    expect(seconds).toBeLessThanOrEqual(120);
  });

  test("a new sign-in deletes the codes that ran out", async () => {
    const user = await newUser();
    const old = hash();
    await createCliLogin(t.db, { userId: user.id, codeHash: old, challenge: challenge() });
    await t.db
      .update(cliLogins)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(cliLogins.codeHash, old));
    const fresh = hash();
    await createCliLogin(t.db, { userId: user.id, codeHash: fresh, challenge: challenge() });
    const kept = (await rows()).map((r) => r.codeHash);
    expect(kept).toContain(fresh);
    expect(kept).not.toContain(old);
  });

  test("only a hash and a SHA-256 challenge are accepted, and a refusal does not echo the value", async () => {
    const user = await newUser();
    const code = "plain-code-0123456789";
    const bad = await createCliLogin(t.db, {
      userId: user.id,
      codeHash: code,
      challenge: challenge(),
    }).catch((e) => e);
    expect(bad).toBeInstanceOf(AuthStoreError);
    expect(bad.message).not.toContain(code);
    for (const c of ["", "short", "A".repeat(44), `${"A".repeat(42)}!`]) {
      const error = await createCliLogin(t.db, {
        userId: user.id,
        codeHash: hash(),
        challenge: c,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(AuthStoreError);
    }
    await expect(takeCliLogin(t.db, code)).rejects.toBeInstanceOf(AuthStoreError);
  });

  test("goes with the user", async () => {
    const user = await newUser();
    const codeHash = hash();
    await createCliLogin(t.db, { userId: user.id, codeHash, challenge: challenge() });
    await t.db.delete(users).where(eq(users.id, user.id));
    expect(await takeCliLogin(t.db, codeHash)).toBeUndefined();
  });
});

describe("revokeApiTokenById", () => {
  test("revokes a token once, whoever owns it", async () => {
    const user = await newUser();
    const token = await createApiToken(t.db, {
      userId: user.id,
      name: "cli",
      prefix: "orch_abcdefgh",
      tokenHash: hash(),
      scopes: ["*"],
      ttlMs: 60_000,
    });
    const first = await revokeApiTokenById(t.db, token.id);
    expect(first?.id).toBe(token.id);
    expect(first?.revokedAt).toBeInstanceOf(Date);
    expect(await revokeApiTokenById(t.db, token.id)).toBeUndefined();
    expect(await revokeApiTokenById(t.db, Bun.randomUUIDv7())).toBeUndefined();
  });
});
