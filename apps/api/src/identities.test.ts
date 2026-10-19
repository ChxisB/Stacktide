import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createApiToken,
  createOrganization,
  createSession,
  createSsoProvider,
  linkSsoIdentity,
  listIdentities,
  setSsoMembership,
  ssoRolesOf,
  updateSsoProvider,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { sessionPrincipal } from "./session";
import { hashToken, newApiToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);
const SUB = "idp-subject-CANARY-6611";

let t: TestDb;
let app: ReturnType<typeof createApp>;
let n = 0;
beforeAll(async () => {
  t = await createTestDb();
  app = createApp({
    logger: createLogger({ write: () => {} }),
    db: t.db,
    principal: sessionPrincipal({ db: t.db }),
    ready: async () => {},
    keys,
  });
});
afterAll(async () => {
  await t.drop();
});

/** A person who signs in with GitLab, with a session. */
async function person() {
  const user = await upsertUser(t.db, { gitlabId: 770_000 + ++n, username: `p${n}`, name: "P" });
  const token = randomToken();
  await createSession(t.db, { userId: user.id, tokenHash: hashToken(token), ttlMs: 60_000 });
  return { user, cookie: `orch_session=${token}` };
}
/** An organization with an enabled provider, and the person's identity at it, holding a role. */
async function linked(userId: string, role: "viewer" | "admin" = "admin") {
  const org = await createOrganization(t.db, { slug: `idn-${++n}`, name: `Org ${n}` });
  const p = await createSsoProvider(t.db, keys, {
    organizationId: org.id,
    issuer: "https://idp.example.com/realms/acme",
    clientId: "orch",
    clientSecret: "idp-client-SECRET-0001",
    emailDomains: ["acme.example"],
    roleMap: [{ claim: "groups", value: "all", role: "viewer" }],
  });
  await updateSsoProvider(t.db, keys, org.id, { enabled: true });
  await linkSsoIdentity(t.db, userId, p.id, { subject: SUB, email: "a@acme.example" });
  await setSsoMembership(t.db, userId, p.id, role, 3_600_000);
  return { org, provider: p };
}

async function call(method: string, path: string, headers: Record<string, string> = {}) {
  const res = await app.handle(new Request(`http://localhost${path}`, { method, headers }));
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}
const idOf = async (userId: string, kind: "gitlab" | "sso") =>
  (await listIdentities(t.db, userId)).find(
    (i) => (kind === "gitlab") === (i.ssoProviderId === null),
  )?.id ?? "";

describe("who may ask: only a person with a live session", () => {
  test("nobody, a dead cookie and an API token are all refused, for both routes", async () => {
    const me = await person();
    await linked(me.user.id);
    const { token, prefix, tokenHash } = newApiToken();
    await createApiToken(t.db, {
      userId: me.user.id,
      name: "cli",
      prefix,
      tokenHash,
      scopes: [],
      ttlMs: 60_000,
    });
    const id = await idOf(me.user.id, "sso");
    const refused: Record<string, string>[] = [
      {},
      { cookie: "orch_session=long-expired" },
      { authorization: `Bearer ${token}` },
    ];
    for (const headers of refused) {
      expect((await call("GET", "/auth/identities", headers)).status).toBe(401);
      expect((await call("DELETE", `/auth/identities/${id}`, headers)).status).toBe(401);
    }
    expect(await listIdentities(t.db, me.user.id)).toHaveLength(2);
  });
});

describe("GET /auth/identities", () => {
  test("lists the person's own ways to sign in with the organization of an SSO one, and never the subject", async () => {
    const me = await person();
    const l = await linked(me.user.id);
    const res = await call("GET", "/auth/identities", { cookie: me.cookie });
    expect(res.status).toBe(200);
    expect(res.json.map((i: { kind: string }) => i.kind)).toEqual(["gitlab", "sso"]);
    expect(res.json[1]).toMatchObject({
      kind: "sso",
      organizationSlug: l.org.slug,
      organizationName: l.org.name,
      email: "a@acme.example",
    });
    expect(res.json[0]).toMatchObject({ organizationSlug: null, organizationName: null });
    expect(res.text).not.toContain(SUB);
  });

  test("another person's identities are not in it", async () => {
    const [a, b] = [await person(), await person()];
    await linked(a.user.id);
    const res = await call("GET", "/auth/identities", { cookie: b.cookie });
    expect(res.json).toHaveLength(1);
    expect(res.text).not.toContain("a@acme.example");
  });
});

describe("DELETE /auth/identities/:id", () => {
  test("gives up an SSO identity and the role it gave, audits it, and leaves the rest", async () => {
    const me = await person();
    const [one, two] = [await linked(me.user.id), await linked(me.user.id, "viewer")];
    const res = await call("DELETE", `/auth/identities/${await idOf(me.user.id, "sso")}`, {
      cookie: me.cookie,
    });
    expect(res.status).toBe(204);
    const left = await listIdentities(t.db, me.user.id);
    expect(left).toHaveLength(2);
    const gone = [one, two].find((x) => !left.some((i) => i.ssoProviderId === x.provider.id));
    expect(gone).toBeDefined();
    const roles = await ssoRolesOf(t.db, me.user.id);
    expect(Object.keys(roles)).toHaveLength(1);
    expect(roles[gone?.org.id ?? ""]).toBeUndefined();
    const [event] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "identity.unlink"), eq(auditEvents.actorId, me.user.id)));
    expect(event).toMatchObject({
      actorKind: "user",
      resourceType: "user",
      resourceId: me.user.id,
      organizationId: gone?.org.id,
    });
    expect(event?.metadata).toEqual({ ssoProviderId: gone?.provider.id });
  });

  test("the last way to sign in stays: 409, and its role with it", async () => {
    // a person who only ever signed in through a provider
    const org = await createOrganization(t.db, { slug: `idn-${++n}`, name: "Solo" });
    const p = await createSsoProvider(t.db, keys, {
      organizationId: org.id,
      issuer: "https://idp.example.com/realms/solo",
      clientId: "orch",
      clientSecret: "idp-client-SECRET-0002",
      emailDomains: ["acme.example"],
      roleMap: [{ claim: "groups", value: "all", role: "viewer" }],
    });
    await updateSsoProvider(t.db, keys, org.id, { enabled: true });
    const { signInSso } = await import("@orch/db");
    const solo = await signInSso(t.db, p.id, {
      subject: "solo",
      email: "s@acme.example",
      username: "solo",
      name: "Solo",
    });
    await setSsoMembership(t.db, solo.id, p.id, "member", 3_600_000);
    const token = randomToken();
    await createSession(t.db, { userId: solo.id, tokenHash: hashToken(token), ttlMs: 60_000 });
    const res = await call("DELETE", `/auth/identities/${await idOf(solo.id, "sso")}`, {
      cookie: `orch_session=${token}`,
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "last_identity" });
    expect(await ssoRolesOf(t.db, solo.id)).toEqual({ [org.id]: "member" });
  });

  test("the GitLab identity is the account's own: 409, and it stays", async () => {
    const me = await person();
    await linked(me.user.id);
    const res = await call("DELETE", `/auth/identities/${await idOf(me.user.id, "gitlab")}`, {
      cookie: me.cookie,
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "identity_not_removable" });
    expect(await listIdentities(t.db, me.user.id)).toHaveLength(2);
  });

  test("another person's identity, one that is not there and one that is not an id are not found", async () => {
    const [me, other] = [await person(), await person()];
    await linked(other.user.id);
    const theirs = await idOf(other.user.id, "sso");
    const stolen = await call("DELETE", `/auth/identities/${theirs}`, { cookie: me.cookie });
    expect(stolen.status).toBe(404);
    expect(
      (await call("DELETE", `/auth/identities/${crypto.randomUUID()}`, { cookie: me.cookie }))
        .status,
    ).toBe(404);
    expect((await call("DELETE", "/auth/identities/not-an-id", { cookie: me.cookie })).status).toBe(
      422,
    );
    expect(await listIdentities(t.db, other.user.id)).toHaveLength(2);
    expect(Object.keys(await ssoRolesOf(t.db, other.user.id))).toHaveLength(1);
  });
});
