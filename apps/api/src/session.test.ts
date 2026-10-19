import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { OrgRole } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createOrganization,
  createSession,
  createSsoProvider,
  sessions,
  setSsoMembership,
  updateSsoProvider,
  upsertUser,
  users,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq, sql } from "drizzle-orm";
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
      userId: user.id, // who the person is, for the rule that nobody approves their own change request
      subject: {
        kind: "user",
        platformAdmin: false,
        orgRoles: { [ORG]: "admin" },
        projectRoles: { [PROJECT]: "reporter" },
      },
    });
    expect(seen).toEqual([user.id]);
  });

  test("a person with no GitLab id holds no GitLab roles, is no platform admin, and the source is not asked", async () => {
    const [user] = await t.db.insert(users).values({ username: "idp-only", name: "I" }).returning();
    const id = user?.id ?? "";
    const token = randomToken();
    await createSession(t.db, { userId: id, tokenHash: hashToken(token), ttlMs: 60_000 });
    let asked = 0;
    const p = await sessionPrincipal({
      db: t.db,
      roles: () => {
        asked++;
        return { orgRoles: { [ORG]: "owner" }, projectRoles: {} };
      },
      platformAdmins: [0, 1, 9000],
    })(request(`orch_session=${token}`));
    expect(p).toEqual({
      id,
      kind: "user",
      userId: id,
      subject: { kind: "user", platformAdmin: false, orgRoles: {}, projectRoles: {} },
    });
    expect(asked).toBe(0);
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

describe("a role through an identity provider and one through GitLab", () => {
  const keys = envKeyProvider(`k1:${Buffer.alloc(32, 3).toString("base64")}`);
  let n = 0;
  async function provider() {
    const org = await createOrganization(t.db, { slug: `sso-${++n}`, name: "O" });
    const made = await createSsoProvider(t.db, keys, {
      organizationId: org.id,
      issuer: "https://idp.example.com",
      clientId: "orch",
      clientSecret: "s",
      emailDomains: ["acme.example"],
      roleMap: [],
    });
    await updateSsoProvider(t.db, keys, org.id, { enabled: true });
    return { org, made };
  }
  const rolesOf = async (gitlab: Record<string, OrgRole>, memberships: [string, OrgRole][]) => {
    const { user, token } = await signIn();
    for (const [providerId, role] of memberships) {
      await t.db.execute(
        sql`INSERT INTO user_identities (user_id, provider, subject, sso_provider_id)
            VALUES (${user.id}, ${`sso:${providerId}`}, ${`sub-${n++}`}, ${providerId})`,
      );
      await setSsoMembership(t.db, user.id, providerId, role, 60_000);
    }
    const p = await sessionPrincipal({
      db: t.db,
      roles: () => ({ orgRoles: gitlab, projectRoles: {} }),
    })(request(`orch_session=${token}`));
    return (p as { subject: { orgRoles: Record<string, OrgRole> } }).subject.orgRoles;
  };

  test("the higher of the two holds in an organization, whichever it comes from", async () => {
    for (const [gitlab, sso, held] of [
      ["viewer", "admin", "admin"],
      ["owner", "viewer", "owner"],
      ["member", "member", "member"],
    ] as const) {
      const { org, made } = await provider();
      expect(await rolesOf({ [org.id]: gitlab }, [[made.id, sso]])).toEqual({ [org.id]: held });
    }
  });

  test("a provider's role is added to the GitLab ones, not swapped for them", async () => {
    const [a, b] = [await provider(), await provider()];
    expect(await rolesOf({ [a.org.id]: "member" }, [[b.made.id, "admin"]])).toEqual({
      [a.org.id]: "member",
      [b.org.id]: "admin",
    });
  });
});
