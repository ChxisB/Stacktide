import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSession, sessions, upsertUser } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq } from "drizzle-orm";
import { sessionPrincipal } from "./session";
import { hashToken, randomToken } from "./tokens";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const ORG = crypto.randomUUID();
const PROJECT = crypto.randomUUID();

let next = 9000;
async function signIn(ttlMs = 60_000) {
  const user = await upsertUser(t.db, { gitlabId: next++, username: `u${next}`, name: "U" });
  const token = randomToken();
  await createSession(t.db, { userId: user.id, tokenHash: hashToken(token), ttlMs });
  return { user, token };
}
const request = (cookie?: string) =>
  new Request("http://localhost/x", { headers: cookie ? { cookie } : {} });

describe("sessionPrincipal", () => {
  test("a live session is a user principal with the roles the source gives", async () => {
    const { user, token } = await signIn();
    const seen: string[] = [];
    const resolve = sessionPrincipal({
      db: t.db,
      roles: (u) => {
        seen.push(u.id);
        return { orgRoles: { [ORG]: "admin" }, projectRoles: { [PROJECT]: "reporter" } };
      },
    });
    expect(await resolve(request(`orch_session=${token}`))).toEqual({
      id: user.id,
      kind: "user",
      subject: {
        kind: "user",
        platformAdmin: false,
        orgRoles: { [ORG]: "admin" },
        projectRoles: { [PROJECT]: "reporter" },
      },
    });
    expect(seen).toEqual([user.id]);
  });

  test("by default nobody has a role", async () => {
    const { token } = await signIn();
    const p = await sessionPrincipal({ db: t.db })(request(`orch_session=${token}`));
    expect(p).toMatchObject({ kind: "user", subject: { orgRoles: {}, projectRoles: {} } });
  });

  test("the token is found among other cookies", async () => {
    const { user, token } = await signIn();
    const p = await sessionPrincipal({ db: t.db })(
      request(`a=1; orch_session=${token}; orch_login=zzz`),
    );
    expect(p?.id).toBe(user.id);
  });

  test("no cookie, an empty one, an unknown token or the token's hash is anonymous", async () => {
    const resolve = sessionPrincipal({ db: t.db });
    const { token } = await signIn();
    expect(await resolve(request())).toBeUndefined();
    expect(await resolve(request("orch_session="))).toBeUndefined();
    expect(await resolve(request("other=1"))).toBeUndefined();
    expect(await resolve(request(`orch_session=${randomToken()}`))).toBeUndefined();
    // Only the token opens a session: its stored hash does not.
    expect(await resolve(request(`orch_session=${hashToken(token)}`))).toBeUndefined();
  });

  test("an ended or expired session is anonymous", async () => {
    const resolve = sessionPrincipal({ db: t.db });
    const { token } = await signIn();
    await t.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hashToken(token)));
    expect(await resolve(request(`orch_session=${token}`))).toBeUndefined();
  });

  test("platform admins are the configured GitLab ids, no one else", async () => {
    const [a, b] = [await signIn(), await signIn()];
    const resolve = sessionPrincipal({ db: t.db, platformAdmins: [a.user.gitlabId] });
    const pa = await resolve(request(`orch_session=${a.token}`));
    const pb = await resolve(request(`orch_session=${b.token}`));
    expect(pa).toMatchObject({ subject: { platformAdmin: true } });
    expect(pb).toMatchObject({ subject: { platformAdmin: false } });
  });

  test("a role source that fails fails the request: no session, no guess", async () => {
    const { token } = await signIn();
    const resolve = sessionPrincipal({
      db: t.db,
      roles: () => Promise.reject(new Error("gitlab down")),
    });
    await expect(resolve(request(`orch_session=${token}`))).rejects.toThrow("gitlab down");
  });
});
