import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuthStoreError, createSession, deleteSession, findSession, upsertUser } from "./auth";
import { sessions, users } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const hash = (c = "a") => c.repeat(64);
const gid = () => Math.floor(Math.random() * 1e9);
const newUser = (over: Partial<Parameters<typeof upsertUser>[1]> = {}) =>
  upsertUser(t.db, { gitlabId: gid(), username: "ada", name: "Ada", ...over });

describe("upsertUser", () => {
  test("creates the user once and refreshes name and login time on later sign-ins", async () => {
    const gitlabId = gid();
    const first = await newUser({ gitlabId });
    await t.db
      .update(users)
      .set({ lastLoginAt: new Date(0) })
      .where(eq(users.id, first.id));
    const again = await newUser({ gitlabId, username: "ada2", name: "Ada L" });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ gitlabId, username: "ada2", name: "Ada L" });
    expect(again.lastLoginAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await t.db.select().from(users).where(eq(users.gitlabId, gitlabId))).toHaveLength(1);
  });

  test("two people never share a row", async () => {
    expect((await newUser()).id).not.toBe((await newUser()).id);
  });
});

describe("sessions", () => {
  test("a live session finds its user; an unknown hash finds nothing", async () => {
    const user = await newUser();
    await createSession(t.db, { userId: user.id, tokenHash: hash("b"), ttlMs: 60_000 });
    const found = await findSession(t.db, hash("b"));
    expect(found?.user.id).toBe(user.id);
    expect(await findSession(t.db, hash("c"))).toBeUndefined();
  });

  test("an ended session finds nothing", async () => {
    const user = await newUser();
    await createSession(t.db, { userId: user.id, tokenHash: hash("d"), ttlMs: 60_000 });
    await t.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hash("d")));
    expect(await findSession(t.db, hash("d"))).toBeUndefined();
  });

  test("the end time comes from the database clock and ttl", async () => {
    const user = await newUser();
    await createSession(t.db, { userId: user.id, tokenHash: hash("e"), ttlMs: 3_600_000 });
    const [row] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hash("e")));
    const left = (row?.expiresAt.getTime() ?? 0) - Date.now();
    expect(Math.abs(left - 3_600_000)).toBeLessThan(60_000);
  });

  test("deleting ends it and says whose it was; a second delete finds nothing", async () => {
    const user = await newUser();
    await createSession(t.db, { userId: user.id, tokenHash: hash("f"), ttlMs: 60_000 });
    expect(await deleteSession(t.db, hash("f"))).toMatchObject({ userId: user.id });
    expect(await findSession(t.db, hash("f"))).toBeUndefined();
    expect(await deleteSession(t.db, hash("f"))).toBeUndefined();
  });

  test("deleting a user ends their sessions", async () => {
    const user = await newUser();
    await createSession(t.db, { userId: user.id, tokenHash: hash("1"), ttlMs: 60_000 });
    await t.db.delete(users).where(eq(users.id, user.id));
    expect(await findSession(t.db, hash("1"))).toBeUndefined();
  });

  test("a new session clears out sessions that ended over a day ago, and only those", async () => {
    const user = await newUser();
    await createSession(t.db, { userId: user.id, tokenHash: hash("2"), ttlMs: 60_000 });
    await createSession(t.db, { userId: user.id, tokenHash: hash("3"), ttlMs: 60_000 });
    const ended = (ms: number) => new Date(Date.now() - ms);
    await t.db
      .update(sessions)
      .set({ expiresAt: ended(2 * 86_400_000) })
      .where(eq(sessions.tokenHash, hash("2")));
    await t.db
      .update(sessions)
      .set({ expiresAt: ended(3_600_000) })
      .where(eq(sessions.tokenHash, hash("3")));
    await createSession(t.db, { userId: user.id, tokenHash: hash("4"), ttlMs: 60_000 });
    const left = (await t.db.select().from(sessions).where(eq(sessions.userId, user.id))).map(
      (r) => r.tokenHash,
    );
    expect(left.sort()).toEqual([hash("3"), hash("4")]);
  });

  test("anything but a SHA-256 digest is refused, without echoing it", async () => {
    const user = await newUser();
    const cookie = "plain-cookie-value-CANARY";
    for (const call of [
      () => createSession(t.db, { userId: user.id, tokenHash: cookie, ttlMs: 60_000 }),
      () => findSession(t.db, cookie),
      () => deleteSession(t.db, cookie),
    ]) {
      const e = await call().catch((x) => x);
      expect(e).toBeInstanceOf(AuthStoreError);
      expect(String(e)).not.toContain("CANARY");
    }
  });

  test("a ttl outside one second to 90 days is refused", async () => {
    const user = await newUser();
    for (const ttlMs of [0, 999, 1.5, 91 * 86_400_000, Number.NaN]) {
      await expect(
        createSession(t.db, { userId: user.id, tokenHash: hash("5"), ttlMs }),
      ).rejects.toThrow(AuthStoreError);
    }
  });
});
