import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type RoleRule, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createApiToken,
  createOrganization,
  createSession,
  createSsoProvider,
  sessions,
  ssoRolesOf,
  updateSsoProvider,
  upsertUser,
  userIdentities,
  users,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, eq, like, sql } from "drizzle-orm";
import { createApp } from "./app";
import { bearerPrincipal } from "./credentials";
import { type FakeIdp, fakeIdp } from "./fake-idp";
import { makeKey } from "./jwt-testing";
import { publicTarget } from "./oidc";
import { sessionPrincipal } from "./session";
import { hashToken, newApiToken, randomToken } from "./tokens";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
const idps: FakeIdp[] = [];
afterEach(() => {
  for (const i of idps.splice(0)) i.stop();
});

const REDIRECT = "http://localhost/auth/sso/callback";
const CLIENT_SECRET = "idp-client-SECRET-CANARY-5521";
const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);
let n = 0;

interface Over {
  enabled?: boolean;
  emailDomains?: string[];
  configured?: boolean;
  roleMap?: RoleRule[];
  /** The address rule. Default: the fake IdP's own address is allowed (it is on loopback), everything else must be public. */
  check?: (idp: FakeIdp) => (raw: string) => Promise<URL>;
  /** Leave the address rule as it ships. */
  realRule?: boolean;
}

async function setup(over: Over = {}) {
  const idp = await fakeIdp({
    clientId: "orch",
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT,
  });
  idps.push(idp);
  const org = await createOrganization(t.db, { slug: `acme-${++n}`, name: "Acme" });
  const provider = await createSsoProvider(t.db, keys, {
    organizationId: org.id,
    issuer: idp.issuer,
    clientId: "orch",
    clientSecret: CLIENT_SECRET,
    emailDomains: over.emailDomains ?? ["acme.example"],
    roleMap: over.roleMap ?? [
      { claim: "groups", value: "all", role: "viewer" },
      { claim: "groups", value: "platform", role: "admin" },
    ],
  });
  if (over.enabled !== false) await updateSsoProvider(t.db, keys, org.id, { enabled: true });
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ write: (l) => lines.push(JSON.parse(l)), level: "debug" });
  const fetched: string[] = [];
  let clock = Date.now();
  const allowIdp = (raw: string) =>
    new URL(raw).origin === idp.origin ? Promise.resolve(new URL(raw)) : publicTarget()(raw);
  const app = createApp({
    logger,
    db: t.db,
    principal: sessionPrincipal({ db: t.db }),
    ready: async () => {},
    keys,
    auth: {
      ...(over.configured === false ? {} : { ssoRedirectUri: REDIRECT }),
      now: () => clock,
      oidc: {
        ...(over.realRule ? {} : { check: over.check?.(idp) ?? allowIdp }),
        fetch: (url, init) => {
          fetched.push(url);
          return fetch(url, init);
        },
      },
    },
  });

  /** A browser: remembers cookies, never follows redirects on its own. */
  function browser() {
    const jar = new Map<string, string>();
    const call = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      const res = await app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
      for (const c of res.headers.getSetCookie()) {
        const [pair = ""] = c.split(";");
        const [k = "", ...v] = pair.split("=");
        if (/;\s*Max-Age=0/i.test(c)) jar.delete(k);
        else jar.set(k, v.join("="));
      }
      return res;
    };
    /** Login, then the visit to the provider. Returns the path the provider sent the browser back to. */
    const startLogin = async (slug = org.slug, returnTo?: string, link = false) => {
      const query = new URLSearchParams();
      if (returnTo !== undefined) query.set("return_to", returnTo);
      const rest = query.size ? `?${query}` : "";
      // a link is a POST that answers with where to go, a sign-in a GET that redirects there
      const login = link
        ? await call(`/auth/sso/${slug}/link${rest}`, { method: "POST" })
        : await call(`/auth/sso/${slug}/login${rest}`);
      const location =
        link && login.status === 200
          ? ((await login.clone().json()) as { location: string }).location
          : (login.headers.get("location") ?? "");
      const away = location ? await fetch(location, { redirect: "manual" }) : undefined;
      const back = new URL(away?.headers.get("location") ?? "http://none/");
      return {
        login,
        location,
        back: back.pathname + back.search,
        code: back.searchParams.get("code"),
      };
    };
    const signIn = async (returnTo?: string) => call((await startLogin(org.slug, returnTo)).back);
    return { call, jar, startLogin, signIn };
  }
  return {
    app,
    idp,
    org,
    provider,
    lines,
    fetched,
    browser,
    advance: (ms: number) => (clock += ms),
  };
}

const identities = (providerId: string) =>
  t.db
    .select()
    .from(userIdentities)
    .where(eq(userIdentities.provider, `sso:${providerId}`));

/** One answer for every refusal, and nothing was made or opened. */
async function refused(s: Awaited<ReturnType<typeof setup>>, res: Response) {
  expect(res.status).toBe(401);
  expect(await res.json()).toMatchObject({ code: "login_failed" });
  expect(res.headers.getSetCookie().some((c) => c.startsWith("orch_session="))).toBe(false);
  expect(await identities(s.provider.id)).toHaveLength(0);
}

describe("starting an SSO sign-in", () => {
  test("sends the browser to the provider with state, nonce and a PKCE challenge, and keeps the flow in a cookie", async () => {
    const s = await setup();
    const b = s.browser();
    const { login, location } = await b.startLogin();
    expect(login.status).toBe(302);
    expect(login.headers.get("cache-control")).toBe("no-store");
    const to = new URL(location);
    expect(to.origin + to.pathname).toBe(`${s.idp.issuer}/protocol/openid-connect/auth`);
    const q = to.searchParams;
    expect(q.get("client_id")).toBe("orch");
    expect(q.get("redirect_uri")).toBe(REDIRECT);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("code_challenge_method")).toBe("S256");
    const flow = JSON.parse(Buffer.from(b.jar.get("orch_sso") ?? "", "base64url").toString());
    expect(q.get("state")).toBe(flow.s);
    expect(q.get("nonce")).toBe(flow.n);
    expect(new Set([flow.s, flow.v, flow.n]).size).toBe(3);
    expect(location).not.toContain(CLIENT_SECRET);
    expect(location).not.toContain(flow.v); // the verifier never leaves the cookie
    const cookie = login.headers.getSetCookie()[0] ?? "";
    for (const part of ["HttpOnly", "SameSite=Lax", "Path=/auth", "Max-Age=600"]) {
      expect(cookie).toContain(part);
    }
  });

  test("an unknown organization, one with no provider and one with a disabled provider all answer the same 404, and the provider is never contacted", async () => {
    const off = await setup({ enabled: false });
    const none = await setup();
    const bare = await createOrganization(t.db, { slug: `bare-${++n}`, name: "Bare" });
    const answers = [
      await off.browser().call(`/auth/sso/${off.org.slug}/login`),
      await none.browser().call("/auth/sso/no-such-org/login"),
      await none.browser().call(`/auth/sso/${bare.slug}/login`),
    ];
    const bodies = await Promise.all(
      answers.map(async (r) => {
        expect(r.status).toBe(404);
        expect(r.headers.getSetCookie()).toEqual([]);
        const { request_id: _, ...rest } = (await r.json()) as Record<string, unknown>;
        return rest;
      }),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(off.idp.requests).toEqual([]);
  });

  test("503 when SSO has no redirect address configured", async () => {
    const s = await setup({ configured: false });
    const res = await s.browser().call(`/auth/sso/${s.org.slug}/login`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "login_unavailable" });
  });

  test("each start gets its own state, nonce and verifier", async () => {
    const s = await setup();
    const [a, b] = [s.browser(), s.browser()];
    await a.startLogin();
    await b.startLogin();
    expect(a.jar.get("orch_sso")).not.toBe(b.jar.get("orch_sso"));
  });

  test("return_to is a path on this site or it is dropped", async () => {
    const s = await setup();
    for (const [given, back] of [
      ["/projects?x=1", "/projects?x=1"],
      ["//evil.example/x", "/"],
      ["https://evil.example", "/"],
      ["/\\evil.example", "/"],
    ] as const) {
      const b = s.browser();
      const res = await b.signIn(given);
      expect(res.headers.get("location")).toBe(back);
    }
  });
});

describe("the provider's address is an outbound target like a notification sink's", () => {
  test("an issuer that is not a public https address is refused before any request is made", async () => {
    const s = await setup({ realRule: true }); // the fake IdP is http on loopback
    await refused(s, await s.browser().call(`/auth/sso/${s.org.slug}/login`));
    expect(s.idp.requests).toEqual([]);
    expect(s.fetched).toEqual([]);
  });

  test("an endpoint in the discovery document that points inside the network is refused, and never fetched", async () => {
    for (const token_endpoint of [
      "https://169.254.169.254/latest/token",
      "http://127.0.0.1:1/token",
      "https://localhost/token",
    ]) {
      const s = await setup();
      s.idp.discovery = { token_endpoint };
      await refused(s, await s.browser().call(`/auth/sso/${s.org.slug}/login`));
      expect(s.fetched.some((u) => !u.startsWith(s.idp.origin))).toBe(false);
    }
  });

  test("a discovery document for another issuer is refused", async () => {
    const s = await setup();
    s.idp.discovery = { issuer: "https://other.example.com/realms/acme" };
    await refused(s, await s.browser().call(`/auth/sso/${s.org.slug}/login`));
  });

  test("a redirect from the provider is not followed", async () => {
    const s = await setup();
    s.idp.redirectDiscovery = true;
    await refused(s, await s.browser().call(`/auth/sso/${s.org.slug}/login`));
    expect(s.idp.requests).toEqual(["GET /realms/acme/.well-known/openid-configuration"]);
  });

  test("a provider that cannot be reached is a 502, not a refusal", async () => {
    const s = await setup();
    s.idp.stop();
    const res = await s.browser().call(`/auth/sso/${s.org.slug}/login`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "idp_unavailable" });
  });
});

describe("completing an SSO sign-in", () => {
  test("signs the person in: a new person with no GitLab id, one identity, a session, an audit row, back to where they were", async () => {
    const s = await setup();
    const b = s.browser();
    const res = await b.signIn("/projects?x=1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects?x=1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("orch_session=")) ?? "";
    for (const part of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=43200"]) {
      expect(session).toContain(part);
    }
    expect(cookies.some((c) => c.startsWith("orch_sso=;") && c.includes("Max-Age=0"))).toBe(true);
    expect(b.jar.has("orch_sso")).toBe(false);

    const [identity] = await identities(s.provider.id);
    expect(identity).toMatchObject({
      subject: "kc-user-1",
      ssoProviderId: s.provider.id,
      email: "ada@acme.example",
    });
    const me = await b.call("/auth/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      id: identity?.userId,
      gitlabId: null,
      username: "ada",
      name: "Ada Lovelace",
      platformAdmin: false, // never from a provider
    });

    const [event] = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, identity?.userId ?? ""));
    expect(event).toMatchObject({
      action: "auth.login",
      actorKind: "user",
      actorId: identity?.userId,
      resourceType: "user",
      organizationId: s.org.id,
    });
    expect(event?.metadata).toEqual({
      provider: "sso",
      ssoProviderId: s.provider.id,
      role: "viewer",
    });
  });

  test("a second sign-in is the same person with a new session, and the old cookie stops working", async () => {
    const s = await setup();
    const b = s.browser();
    await b.signIn();
    const first = b.jar.get("orch_session") ?? "";
    await b.signIn();
    expect(b.jar.get("orch_session")).not.toBe(first);
    expect(await identities(s.provider.id)).toHaveLength(1);
    const old = await s
      .browser()
      .call("/auth/me", { headers: { cookie: `orch_session=${first}` } });
    expect(old.status).toBe(401);
    const live = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, (await identities(s.provider.id))[0]?.userId ?? ""));
    expect(live).toHaveLength(1);
  });

  test("the person is matched by the provider's sub, never by name or email: a changed email is the same person, a GitLab person with the same name is another", async () => {
    const s = await setup();
    const [gitlab] = await t.db
      .insert(users)
      .values({ gitlabId: 4_200_001, username: "ada", name: "Ada Lovelace" })
      .returning();
    const b = s.browser();
    await b.signIn();
    const [first] = await identities(s.provider.id);
    expect(first?.userId).not.toBe(gitlab?.id);
    s.idp.claims = { ...s.idp.claims, email: "ada.new@acme.example", name: "Ada L" };
    await b.signIn();
    const [after] = await identities(s.provider.id);
    expect(after).toMatchObject({ userId: first?.userId, email: "ada.new@acme.example" });
    expect(await b.call("/auth/me").then((r) => r.json())).toMatchObject({ name: "Ada L" });
    // a new sub is a new person even with the same email
    s.idp.claims = { ...s.idp.claims, sub: "kc-user-2" };
    await s.browser().signIn();
    expect(new Set((await identities(s.provider.id)).map((i) => i.userId)).size).toBe(2);
  });

  test("a person with no preferred_username or name gets them from the email", async () => {
    const s = await setup();
    s.idp.tamper = ({ preferred_username: _u, name: _n, ...c }) => c;
    const b = s.browser();
    await b.signIn();
    expect(await b.call("/auth/me").then((r) => r.json())).toMatchObject({
      username: "ada",
      name: "ada",
    });
  });

  const forged = (change: (c: Record<string, unknown>) => Record<string, unknown>) => ({
    tamper: change,
  });
  const now = () => Math.floor(Date.now() / 1000);
  const REFUSED: [string, Partial<FakeIdp> | ((idp: FakeIdp) => Promise<void>)][] = [
    [
      "a token from another issuer",
      forged((c) => ({ ...c, iss: "https://evil.example.com/realms/acme" })),
    ],
    ["a token for another client", forged((c) => ({ ...c, aud: "other-app" }))],
    ["two audiences and no azp", forged((c) => ({ ...c, aud: ["orch", "other-app"] }))],
    [
      "two audiences and another azp",
      forged((c) => ({ ...c, aud: ["orch", "other-app"], azp: "other-app" })),
    ],
    ["another nonce", forged((c) => ({ ...c, nonce: "not-the-one" }))],
    ["no nonce", forged(({ nonce: _n, ...c }) => c)],
    ["an expired token", forged((c) => ({ ...c, exp: now() - 3600 }))],
    ["a token with no sub", forged(({ sub: _s, ...c }) => c)],
    ["a sub longer than the standard allows", forged((c) => ({ ...c, sub: "x".repeat(256) }))],
    ["no email_verified", forged(({ email_verified: _v, ...c }) => c)],
    ["email_verified false", forged((c) => ({ ...c, email_verified: false }))],
    ["email_verified as a string", forged((c) => ({ ...c, email_verified: "true" }))],
    ["no email", forged(({ email: _e, ...c }) => c)],
    ["an email at another domain", forged((c) => ({ ...c, email: "ada@other.example" }))],
    ["a look-alike domain", forged((c) => ({ ...c, email: "ada@evil-acme.example" }))],
    ["a sub-domain of the allowed one", forged((c) => ({ ...c, email: "ada@sub.acme.example" }))],
    ["the domain as a prefix", forged((c) => ({ ...c, email: "ada@acme.example.evil.example" }))],
    ["two @ signs", forged((c) => ({ ...c, email: "ada@acme.example@evil.example" }))],
    ["no name before the @", forged((c) => ({ ...c, email: "@acme.example" }))],
    [
      "a signature from another key with the same kid",
      async (idp) => {
        idp.signer = await makeKey("kc-1");
      },
    ],
    [
      "a key that is not published",
      async (idp) => {
        idp.signer = await makeKey("kc-unknown");
      },
    ],
  ];
  for (const [what, bend] of REFUSED) {
    test(`refuses ${what}`, async () => {
      const s = await setup();
      if (typeof bend === "function") await bend(s.idp);
      else Object.assign(s.idp, bend);
      const b = s.browser();
      await refused(s, await b.signIn());
      expect(b.jar.has("orch_session")).toBe(false);
    });
  }

  test("a domain is matched whole and in any case", async () => {
    const s = await setup({ emailDomains: ["Acme.Example"] });
    s.idp.claims = { ...s.idp.claims, email: "Ada@ACME.example" };
    const res = await s.browser().signIn();
    expect(res.status).toBe(302);
  });

  test("a code works once: replayed with the same cookie, the provider refuses it", async () => {
    const s = await setup();
    const b = s.browser();
    const { back } = await b.startLogin();
    const cookie = `orch_sso=${b.jar.get("orch_sso")}`;
    expect((await b.call(back)).status).toBe(302);
    // An attacker who copied the callback URL and the flow cookie replays them.
    const again = await s.browser().call(back, { headers: { cookie } });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ code: "login_failed" });
    expect(again.headers.getSetCookie().some((c) => c.startsWith("orch_session="))).toBe(false);
    expect(await identities(s.provider.id)).toHaveLength(1);
  });

  test("a callback without the flow cookie, with another state, after it ran out, or after the provider said no, is refused", async () => {
    const s = await setup();
    const { back } = await s.browser().startLogin();
    const bare = await s.browser().call(back);
    expect(bare.status).toBe(400);
    expect(await bare.json()).toMatchObject({ code: "invalid_login_state" });

    const b = s.browser();
    const started = await b.startLogin();
    const wrong = new URL(`http://x${started.back}`);
    wrong.searchParams.set("state", "another-state");
    expect((await b.call(wrong.pathname + wrong.search)).status).toBe(400);

    const late = s.browser();
    const l = await late.startLogin();
    s.advance(11 * 60_000);
    expect((await late.call(l.back)).status).toBe(400);

    const denied = s.browser();
    const d = await denied.startLogin();
    const url = new URL(`http://x${d.back}`);
    url.searchParams.delete("code");
    url.searchParams.set("error", "access_denied");
    const res = await denied.call(url.pathname + url.search);
    expect(res.status).toBe(401);
    expect(await identities(s.provider.id)).toHaveLength(0);
  });

  test("a provider disabled or deleted while the person was at the provider signs nobody in", async () => {
    const s = await setup();
    const b = s.browser();
    const { back } = await b.startLogin();
    await updateSsoProvider(t.db, keys, s.org.id, { enabled: false });
    const res = await b.call(back);
    expect(res.status).toBe(404);
    expect(await identities(s.provider.id)).toHaveLength(0);
  });

  test("a forged flow cookie naming another provider gains nothing: the token must still be that provider's", async () => {
    const s = await setup();
    const other = await setup();
    const b = s.browser();
    const { back } = await b.startLogin();
    const flow = JSON.parse(Buffer.from(b.jar.get("orch_sso") ?? "", "base64url").toString());
    const forgedFlow = Buffer.from(JSON.stringify({ ...flow, p: other.provider.id })).toString(
      "base64url",
    );
    const res = await other.browser().call(back, { headers: { cookie: `orch_sso=${forgedFlow}` } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await identities(other.provider.id)).toHaveLength(0);
  });

  test("no code, token, verifier or client secret reaches a log, an audit row or the database in the clear", async () => {
    const s = await setup();
    const ok = s.browser();
    const started = await ok.startLogin();
    const verifier = JSON.parse(
      Buffer.from(ok.jar.get("orch_sso") ?? "", "base64url").toString(),
    ).v;
    await ok.call(started.back);
    s.idp.tamper = (c) => ({ ...c, nonce: "wrong" });
    const bad = s.browser();
    const failed = await bad.startLogin();
    await bad.call(failed.back);

    const audit = JSON.stringify(
      await t.db.select().from(auditEvents).where(like(auditEvents.action, "auth.%")),
    );
    const everything = JSON.stringify([
      s.lines,
      audit,
      await t.db.select().from(userIdentities),
      await t.db.select().from(sessions),
    ]);
    const sessionToken = ok.jar.get("orch_session") ?? "";
    expect(sessionToken).not.toBe("");
    for (const secret of [
      CLIENT_SECRET,
      verifier,
      sessionToken,
      started.code ?? "",
      failed.code ?? "",
      ...s.idp.issued,
    ]) {
      expect(secret).not.toBe("");
      expect(everything).not.toContain(secret);
    }
    expect(s.idp.issued.length).toBeGreaterThan(2);
    // the refusal is logged with a reason, so an operator can see why
    expect(s.lines.some((l) => l.msg === "sso sign-in refused")).toBe(true);
  });
});

describe("the role a sign-in gets", () => {
  const subjectIn = (p: unknown) => (p as { subject?: Subject } | undefined)?.subject;
  /** What the request would be allowed, as the browser's session cookie says it. */
  const subjectOf = async (jar: Map<string, string>) =>
    subjectIn(
      await sessionPrincipal({ db: t.db })(
        new Request("http://localhost/x", {
          headers: { cookie: `orch_session=${jar.get("orch_session") ?? ""}` },
        }),
      ),
    );
  const memberships = async (userId: string) =>
    (await t.db.execute(
      sql`SELECT role, expires_at FROM sso_memberships WHERE user_id = ${userId}`,
    )) as unknown as { role: string; expires_at: Date }[];
  const personOf = async (providerId: string) => (await identities(providerId))[0]?.userId ?? "";

  test("the first sign-in gives the highest role the claims earn, until the session ends; never platform admin", async () => {
    const s = await setup();
    const b = s.browser();
    s.idp.claims = { ...s.idp.claims, groups: ["all", "platform"] };
    expect((await b.signIn()).status).toBe(302);
    const subject = await subjectOf(b.jar);
    expect(subject?.orgRoles).toEqual({ [s.org.id]: "admin" });
    expect(subject?.projectRoles).toEqual({});
    expect(subject?.platformAdmin).toBe(false);
    const [row] = await memberships(await personOf(s.provider.id));
    expect(row?.role).toBe("admin");
    // the membership ends when the session does: the database writes both from the same moment
    const [session] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, await personOf(s.provider.id)));
    expect(row?.expires_at).toEqual(session?.expiresAt);
    // the organization shows in the list of what they may see, and no other does
    const other = await createOrganization(t.db, { slug: `other-${++n}`, name: "Other" });
    const listed = await b.call("/organizations");
    expect(((await listed.json()) as { items: { id: string }[] }).items.map((o) => o.id)).toEqual([
      s.org.id,
    ]);
    expect((await b.call(`/organizations/${other.id}`)).status).toBe(404);
  });

  test("a changed role shows at the next sign-in, in either direction", async () => {
    const s = await setup();
    const b = s.browser();
    await b.signIn();
    expect((await subjectOf(b.jar))?.orgRoles).toEqual({ [s.org.id]: "viewer" });
    s.idp.claims = { ...s.idp.claims, groups: ["all", "platform"] };
    await b.signIn();
    expect((await subjectOf(b.jar))?.orgRoles).toEqual({ [s.org.id]: "admin" });
    s.idp.claims = { ...s.idp.claims, groups: ["all"] };
    await b.signIn();
    expect((await subjectOf(b.jar))?.orgRoles).toEqual({ [s.org.id]: "viewer" });
    expect(await memberships(await personOf(s.provider.id))).toHaveLength(1);
  });

  test("a person who has left every group is refused, and loses the role they held, session and all", async () => {
    const s = await setup();
    const b = s.browser();
    await b.signIn();
    const userId = await personOf(s.provider.id);
    expect((await subjectOf(b.jar))?.orgRoles).toEqual({ [s.org.id]: "viewer" });

    s.idp.claims = { ...s.idp.claims, groups: ["left"] };
    const res = await b.signIn();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("login_failed");
    // the old session is still theirs, but holds nothing; the table holds nothing
    expect((await subjectOf(b.jar))?.orgRoles).toEqual({});
    expect(await memberships(userId)).toEqual([]);
    const [ended] = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "sso.membership.end"));
    expect(ended).toMatchObject({
      actorKind: "user",
      actorId: userId,
      resourceId: userId,
      organizationId: s.org.id,
    });
    expect(s.lines.some((l) => l.reason === "id_token has no role in this organization")).toBe(
      true,
    );
    // and when they are in a group again, the next sign-in gives it back
    s.idp.claims = { ...s.idp.claims, groups: ["all"] };
    expect((await b.signIn()).status).toBe(302);
    expect((await subjectOf(b.jar))?.orgRoles).toEqual({ [s.org.id]: "viewer" });
  });

  test("a first sign-in no rule gives a role is refused and leaves no person, identity, session, membership or audit row", async () => {
    const s = await setup();
    const b = s.browser();
    s.idp.claims = { ...s.idp.claims, groups: ["somebody-else"] };
    const before = await t.db.$count(users);
    const res = await b.signIn();
    expect(res.status).toBe(401);
    expect(b.jar.has("orch_session")).toBe(false);
    expect(await identities(s.provider.id)).toEqual([]);
    expect(await t.db.$count(users)).toBe(before);
    const events = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, s.org.id));
    expect(events).toEqual([]);
    const rows = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM sso_memberships WHERE sso_provider_id = ${s.provider.id}`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  test("an organization whose provider has no rules signs nobody in", async () => {
    const s = await setup({ roleMap: [] });
    const res = await s.browser().signIn();
    expect(res.status).toBe(401);
    expect(await identities(s.provider.id)).toEqual([]);
  });

  test("claims that say owner, admin or a role the map does not list grant nothing beyond the map", async () => {
    const s = await setup();
    const b = s.browser();
    s.idp.claims = {
      ...s.idp.claims,
      groups: ["all", "owner", "admin", "platform-admins"],
      role: "owner",
      roles: ["owner", "admin"],
      org_role: "owner",
      admin: true,
      is_platform_admin: true,
      realm_access: { roles: ["owner"] },
    };
    await b.signIn();
    const subject = await subjectOf(b.jar);
    expect(subject?.orgRoles).toEqual({ [s.org.id]: "viewer" });
    expect(subject?.platformAdmin).toBe(false);
  });

  test("a provider turned off takes its roles away at once, and turned on gives them back", async () => {
    const s = await setup();
    const b = s.browser();
    await b.signIn();
    expect((await subjectOf(b.jar))?.orgRoles).toEqual({ [s.org.id]: "viewer" });
    await updateSsoProvider(t.db, keys, s.org.id, { enabled: false });
    expect((await subjectOf(b.jar))?.orgRoles).toEqual({});
    expect((await b.call("/auth/me")).status).toBe(200); // the session itself is not what ended
    await updateSsoProvider(t.db, keys, s.org.id, { enabled: true });
    expect((await subjectOf(b.jar))?.orgRoles).toEqual({ [s.org.id]: "viewer" });
  });

  test("a membership past its time holds nothing, though the session is still there", async () => {
    const s = await setup();
    const b = s.browser();
    await b.signIn();
    await t.db.execute(
      sql`UPDATE sso_memberships SET expires_at = now() - interval '1 second' WHERE user_id = ${await personOf(s.provider.id)}`,
    );
    expect((await subjectOf(b.jar))?.orgRoles).toEqual({});
    expect((await b.call("/auth/me")).status).toBe(200);
    expect((await b.call("/organizations")).status).toBe(200);
    expect(((await (await b.call("/organizations")).json()) as { items: unknown[] }).items).toEqual(
      [],
    );
  });

  test("an API token of a person who signs in this way holds the same roles, and loses them the same way", async () => {
    const s = await setup();
    const b = s.browser();
    await b.signIn();
    const userId = await personOf(s.provider.id);
    const { token, prefix, tokenHash } = newApiToken();
    await createApiToken(t.db, {
      userId,
      name: "cli",
      prefix,
      tokenHash,
      scopes: [],
      ttlMs: 3_600_000,
    });
    const ask = async () =>
      subjectIn(
        await bearerPrincipal({ db: t.db })(
          new Request("http://localhost/x", { headers: { authorization: `Bearer ${token}` } }),
        ),
      );
    expect((await ask())?.orgRoles).toEqual({ [s.org.id]: "viewer" });
    await updateSsoProvider(t.db, keys, s.org.id, { enabled: false });
    expect((await ask())?.orgRoles).toEqual({});
  });
});

describe("linking an identity to the person who is signed in", () => {
  let gitlabId = 880_000;
  /** A person who signed in with GitLab, and a browser that holds their session. */
  async function holder(b: ReturnType<Awaited<ReturnType<typeof setup>>["browser"]>) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: "gl", name: "GL" });
    const token = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(token), ttlMs: 3_600_000 });
    b.jar.set("orch_session", token);
    return { user, token };
  }
  const link = async (s: Awaited<ReturnType<typeof setup>>, b: ReturnType<typeof s.browser>) =>
    b.call((await b.startLogin(s.org.slug, "/#/settings", true)).back);
  const audits = (action: string, userId: string) =>
    t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, action), eq(auditEvents.actorId, userId)));

  test("a link can only be started by someone signed in: nobody else begins a flow, and the provider is not contacted", async () => {
    const s = await setup();
    const none = s.browser();
    for (const b of [
      none,
      (() => {
        const x = s.browser();
        x.jar.set("orch_session", "long-expired");
        return x;
      })(),
    ]) {
      const res = await b.call(`/auth/sso/${s.org.slug}/link`, { method: "POST" });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "unauthenticated" });
      expect(res.headers.getSetCookie().some((c) => c.startsWith("orch_sso="))).toBe(false);
    }
    expect(s.fetched).toEqual([]);
    expect(s.idp.requests).toEqual([]);
  });

  // A GET is what another site can make a signed-in person's browser send (the session cookie is Lax), so no GET starts a link.
  test("a link is never started by a GET: the parameter is ignored and the flow it starts is a plain sign-in", async () => {
    const s = await setup();
    const b = s.browser();
    await holder(b);
    const res = await b.call(`/auth/sso/${s.org.slug}/login?link=1`);
    expect(res.status).toBe(302);
    const flow = res.headers.getSetCookie().find((c) => c.startsWith("orch_sso=")) ?? "";
    const value = flow.split(";")[0]?.slice("orch_sso=".length) ?? "";
    expect(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))).not.toHaveProperty("l");
  });

  test("started by a POST from someone signed in, it answers where to go, and the flow is theirs", async () => {
    const s = await setup();
    const b = s.browser();
    const me = await holder(b);
    const res = await b.call(`/auth/sso/${s.org.slug}/link?return_to=%2F%23%2Fsettings`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { location } = (await res.json()) as { location: string };
    expect(location.startsWith(`${s.idp.issuer}/protocol/openid-connect/auth?`)).toBe(true);
    const flow = res.headers.getSetCookie().find((c) => c.startsWith("orch_sso=")) ?? "";
    const value = flow.split(";")[0]?.slice("orch_sso=".length) ?? "";
    expect(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))).toMatchObject({
      l: me.user.id,
      r: "/#/settings",
    });
    expect(flow).toContain("HttpOnly");
    expect(flow).toContain("SameSite=Lax");
  });

  test("a link through an organization with no provider, or one turned off, is not found", async () => {
    const s = await setup();
    const b = s.browser();
    await holder(b);
    expect((await b.call("/auth/sso/nobody-here/link", { method: "POST" })).status).toBe(404);
    await updateSsoProvider(t.db, keys, s.org.id, { enabled: false });
    expect((await b.call(`/auth/sso/${s.org.slug}/link`, { method: "POST" })).status).toBe(404);
  });

  test("it adds the identity to that person, not to a new one: their session stays, the role comes, it is audited", async () => {
    const s = await setup();
    const b = s.browser();
    const me = await holder(b);
    const people = (await t.db.select().from(users)).length;
    const res = await link(s, b);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#/settings");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("orch_session="))).toBe(false);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("orch_sso=;"))).toBe(true);
    expect(b.jar.get("orch_session")).toBe(me.token);
    expect((await t.db.select().from(users)).length).toBe(people);
    expect(await identities(s.provider.id)).toMatchObject([
      { userId: me.user.id, subject: "kc-user-1", email: "ada@acme.example" },
    ]);
    expect(await ssoRolesOf(t.db, me.user.id)).toEqual({ [s.org.id]: "viewer" });
    expect(((await (await b.call("/auth/me")).json()) as { id: string }).id).toBe(me.user.id);
    const [event] = await audits("identity.link", me.user.id);
    expect(event).toMatchObject({
      resourceType: "user",
      resourceId: me.user.id,
      organizationId: s.org.id,
    });
    expect(event?.metadata).toEqual({ ssoProviderId: s.provider.id, role: "viewer" });
  });

  test("linking again changes nothing and says nothing wrong", async () => {
    const s = await setup();
    const b = s.browser();
    await holder(b);
    expect((await link(s, b)).status).toBe(302);
    expect((await link(s, b)).status).toBe(302);
    expect(await identities(s.provider.id)).toHaveLength(1);
  });

  test("an identity another person holds is not taken: 409, and neither person changes", async () => {
    const s = await setup();
    const first = s.browser();
    await first.signIn(); // the provider's person, signed in on their own
    const [held] = await identities(s.provider.id);
    const b = s.browser();
    const me = await holder(b);
    const res = await link(s, b);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "identity_taken" });
    expect(await identities(s.provider.id)).toMatchObject([{ userId: held?.userId }]);
    expect(await ssoRolesOf(t.db, me.user.id)).toEqual({});
    expect(await audits("identity.link", me.user.id)).toHaveLength(0);
    expect(b.jar.get("orch_session")).toBe(me.token);
  });

  test("an email is never a link: a provider asserting a GitLab person's address makes a separate person and touches nothing of theirs", async () => {
    const s = await setup();
    const b = s.browser();
    const me = await holder(b);
    // the browser holds the GitLab person's session, and signs in through the provider without asking to link
    const res = await b.signIn();
    expect(res.status).toBe(302);
    const [made] = await identities(s.provider.id);
    expect(made?.userId).not.toBe(me.user.id);
    expect(await ssoRolesOf(t.db, me.user.id)).toEqual({});
    expect(await ssoRolesOf(t.db, made?.userId ?? "")).toEqual({ [s.org.id]: "viewer" });
    expect(
      await t.db.select().from(userIdentities).where(eq(userIdentities.userId, me.user.id)),
    ).toHaveLength(1);
    expect(((await (await b.call("/auth/me")).json()) as { id: string }).id).toBe(
      made?.userId ?? "",
    );
  });

  test("a link whose session changed or ended before the provider answered links nothing", async () => {
    const s = await setup();
    const b = s.browser();
    const me = await holder(b);
    const started = await b.startLogin(s.org.slug, undefined, true);
    const other = await holder(b); // someone else signs in on this browser meanwhile
    const swapped = await b.call(started.back);
    expect(swapped.status).toBe(400);
    expect(await swapped.json()).toMatchObject({ code: "invalid_login_state" });

    const again = await b.startLogin(s.org.slug, undefined, true);
    b.jar.delete("orch_session"); // the session ended meanwhile
    const ended = await b.call(again.back);
    expect(ended.status).toBe(400);
    expect(await identities(s.provider.id)).toHaveLength(0);
    expect(await ssoRolesOf(t.db, me.user.id)).toEqual({});
    expect(await ssoRolesOf(t.db, other.user.id)).toEqual({});
  });

  test("a sign-in no rule gives a role to links nothing", async () => {
    const s = await setup();
    const b = s.browser();
    const me = await holder(b);
    s.idp.claims = { ...s.idp.claims, groups: [] };
    const res = await link(s, b);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "login_failed" });
    expect(await identities(s.provider.id)).toHaveLength(0);
    expect(await audits("identity.link", me.user.id)).toHaveLength(0);
  });

  test("logging out of a person who signed in this way ends the session and nothing else is asked of the provider", async () => {
    const s = await setup();
    const b = s.browser();
    await b.signIn();
    const stale = b.jar.get("orch_session") ?? "";
    const before = s.idp.requests.length;
    const res = await b.call("/auth/logout", { method: "POST" });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(b.jar.has("orch_session")).toBe(false);
    expect(
      (await s.browser().call("/auth/me", { headers: { cookie: `orch_session=${stale}` } })).status,
    ).toBe(401);
    expect(s.idp.requests.length).toBe(before); // no sign-out at the provider (ADR-0016)
  });
});
