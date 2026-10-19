import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createLogger, type RoleRule, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createOrganization,
  createSession,
  createSsoProvider,
  deleteSsoProvider,
  getSsoProvider,
  openSsoSecret,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, eq, like, type SQL } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { type FakeIdp, fakeIdp } from "./fake-idp";
import { hashToken, randomToken } from "./tokens";

const CLIENT_SECRET = "idp-client-SECRET-CANARY-7742";
const NEW_SECRET = "idp-client-SECRET-CANARY-NEW-9913";
const REDIRECT = "http://localhost/auth/sso/callback";
const keys = envKeyProvider(`k1:${Buffer.alloc(32, 9).toString("base64")}`);
const NO_ORG = "00000000-0000-4000-8000-000000000000";

let t: TestDb;
let idp: FakeIdp;
let o1: string;
let o2: string;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"owner" | "admin" | "member" | "viewer" | "boss", string>;
const lines: Record<string, unknown>[] = [];
const fetched: string[] = [];

const makeApp = (oidc: object, withKeys = true) =>
  createApp({
    logger: createLogger({ level: "debug", write: (l) => lines.push(JSON.parse(l)) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    ...(withKeys && { keys }),
    auth: { ssoRedirectUri: REDIRECT, oidc },
  });
let app: ReturnType<typeof makeApp>;
/** The address rule as it ships, apart from what names resolve to (a public address, or the private one in `resolves`). */
let strict: ReturnType<typeof makeApp>;
let noKeys: ReturnType<typeof makeApp>;
const resolves = { to: "93.184.216.34" };

beforeAll(async () => {
  t = await createTestDb();
  idp = await fakeIdp({ clientId: "orch", clientSecret: CLIENT_SECRET, redirectUri: REDIRECT });
  o1 = (await createOrganization(t.db, { slug: "sso-one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "sso-two", name: "Two" })).id;
  let gitlabId = 900;
  for (const [name, org, role] of [
    ["owner", o1, "owner"],
    ["admin", o1, "admin"],
    ["member", o1, "member"],
    ["viewer", o1, "viewer"],
    ["boss", o2, "owner"],
  ] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = `orch_session=${session}`;
    roleTable.set(gitlabId, { orgRoles: { [org]: role }, projectRoles: {} });
  }
  const spy = (url: string, init: RequestInit) => {
    fetched.push(url);
    return fetch(url, init);
  };
  // the fake provider is on loopback, which the rule refuses: its own address is let through, everything else is judged as shipped
  const allowIdp = (raw: string) =>
    new URL(raw).origin === idp.origin
      ? Promise.resolve(new URL(raw))
      : Promise.reject(new Error("the address rule was not asked"));
  app = makeApp({ check: allowIdp, fetch: spy });
  strict = makeApp({ resolve: async () => [resolves.to], fetch: spy });
  noKeys = makeApp({ check: allowIdp, fetch: spy }, false);
});
afterAll(async () => {
  idp.stop();
  await t.drop();
});
beforeEach(async () => {
  resolves.to = "93.184.216.34";
  for (const o of [o1, o2]) await deleteSsoProvider(t.db, o);
  older = new Set(
    (await t.db.select({ id: auditEvents.id }).from(auditEvents)).map((row) => row.id),
  );
  fetched.length = 0;
});
afterEach(() => {
  idp.discovery = {};
  idp.extraKeys = [];
});

async function call(
  who: keyof typeof people | undefined,
  method: string,
  path: string,
  body?: unknown,
  to: { handle: typeof app.handle } = app,
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who];
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await to.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const sso = (org = o1, rest = "") => `/organizations/${org}/sso${rest}`;
const RULES: RoleRule[] = [{ claim: "groups", value: "all", role: "viewer" }];
const valid = (over: Record<string, unknown> = {}) => ({
  issuer: idp.issuer,
  clientId: "orch",
  clientSecret: CLIENT_SECRET,
  emailDomains: ["acme.example"],
  roleMap: RULES,
  ...over,
});
const made = async (over: Record<string, unknown> = {}) => {
  const res = await call("owner", "PUT", sso(), valid(over));
  expect([res.status, res.text]).toEqual([201, res.text]);
  return res.json;
};
// the audit table cannot be emptied, so each test reads only the rows made since it began
let older = new Set<string>();
const sinceStart = async (where: SQL | undefined) =>
  (
    await t.db.select().from(auditEvents).where(where).orderBy(auditEvents.at, auditEvents.id)
  ).filter((row) => !older.has(row.id));
const auditsOf = (action: string) =>
  sinceStart(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, o1)));
const ssoAudits = async () => (await sinceStart(like(auditEvents.action, "sso.%"))).length;

describe("an organization's identity provider (SSO-5)", () => {
  test("none yet is 404, and an owner makes one: off, with no secret in the answer", async () => {
    for (const who of ["owner", "admin"] as const) {
      expect([who, (await call(who, "GET", sso())).status]).toEqual([who, 404]);
    }
    const body = valid({ emailDomains: ["ACME.example", "acme.example", "Corp.Acme.Example"] });
    const res = await call("owner", "PUT", sso(), body);
    expect(res.status).toBe(201);
    expect(res.json).toEqual({
      id: expect.any(String),
      organizationId: o1,
      issuer: idp.issuer,
      clientId: "orch",
      emailDomains: ["acme.example", "corp.acme.example"], // lower case, once each
      roleMap: RULES,
      enabled: false,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    for (const who of ["owner", "admin"] as const) {
      const read = await call(who, "GET", sso());
      expect([who, read.status, read.json]).toEqual([who, 200, res.json]);
    }
    // sealed, and the one place it opens again is the sign-in
    expect(await openSsoSecret(t.db, keys, res.json.id)).toBe(CLIENT_SECRET);
    const [row] = await auditsOf("sso.create");
    expect(row).toMatchObject({
      actorKind: "user",
      resourceType: "sso_provider",
      resourceId: res.json.id,
      metadata: {
        issuer: idp.issuer,
        clientId: "orch",
        emailDomains: ["acme.example", "corp.acme.example"],
        // the rules name groups, which an audit row does not hold: how many, and the roles they hand out
        roleRules: 1,
        roles: ["viewer"],
      },
    });
  });

  test("a second one is 409, and the first is as it was", async () => {
    const first = await made();
    const again = await call("owner", "PUT", sso(), valid({ clientId: "other" }));
    expect([again.status, again.json.code]).toEqual([409, "sso_exists"]);
    expect((await call("owner", "GET", sso())).json).toEqual(first);
    expect((await auditsOf("sso.create")).length).toBe(1);
  });

  test("only an owner changes it: an admin reads, a member or a viewer sees nothing, nothing is written", async () => {
    const provider = await made();
    const before = await ssoAudits();
    const writes: [string, string, unknown?][] = [
      ["PUT", sso(), valid()],
      ["PATCH", sso(), { clientId: "x" }],
      ["DELETE", sso()],
      ["POST", sso(o1, "/test")],
      ["POST", sso(o1, "/enable")],
      ["POST", sso(o1, "/disable")],
    ];
    for (const who of ["admin", "member", "viewer"] as const) {
      for (const [method, path, body] of writes) {
        const res = await call(who, method, path, body);
        expect([who, method, path, res.status]).toEqual([who, method, path, 403]);
      }
    }
    for (const who of ["member", "viewer"] as const) {
      expect([who, (await call(who, "GET", sso())).status]).toEqual([who, 403]);
    }
    expect((await call("admin", "GET", sso())).json).toEqual(provider);
    expect(await ssoAudits()).toBe(before);
    expect(fetched).toEqual([]);
  });

  test("another organization's owner sees 404 and changes nothing; no session is 401; no organization is 404", async () => {
    const provider = await made();
    const before = await ssoAudits();
    const all: [string, string, unknown?][] = [
      ["GET", sso()],
      ["PUT", sso(), valid()],
      ["PATCH", sso(), { clientId: "x" }],
      ["DELETE", sso()],
      ["POST", sso(o1, "/test")],
      ["POST", sso(o1, "/enable")],
      ["POST", sso(o1, "/disable")],
    ];
    for (const [method, path, body] of all) {
      expect([method, (await call("boss", method, path, body)).status]).toEqual([method, 404]);
      expect([method, (await call(undefined, method, path, body)).status]).toEqual([method, 401]);
      const none = path.replace(o1, NO_ORG);
      expect([method, (await call("owner", method, none, body)).status]).toEqual([method, 404]);
    }
    expect((await call("owner", "GET", sso())).json).toEqual(provider);
    expect(await ssoAudits()).toBe(before);
    expect(fetched).toEqual([]);
    // and its own organization is its own
    expect((await call("boss", "PUT", sso(o2), valid())).status).toBe(201);
    expect((await call("owner", "GET", sso())).json).toEqual(provider);
  });

  test("a provider that is not well formed is 422 and nothing is made", async () => {
    const bad: Record<string, unknown>[] = [
      { issuer: "not a url" },
      { issuer: "ftp://idp.example/realms/a" },
      { issuer: "https://user:pw@idp.example/realms/a" },
      { issuer: "https://user@idp.example/realms/a" },
      { issuer: "https://:pw@idp.example/realms/a" },
      { issuer: "https://idp.example/realms/a?x=1" },
      { issuer: "https://idp.example/realms/a#top" },
      { issuer: `https://idp.example/${"a".repeat(2000)}` },
      { clientId: "" },
      { clientId: "x".repeat(256) },
      { clientSecret: "" },
      { clientSecret: "x".repeat(1025) },
      { emailDomains: ["*.acme.example"] },
      { emailDomains: ["acme"] },
      { emailDomains: ["ada@acme.example"] },
      { emailDomains: ["acme.example/x"] },
      { emailDomains: [" "] },
      { emailDomains: Array.from({ length: 21 }, (_, i) => `d${i}.example`) },
      { roleMap: [{ claim: "groups", value: "all", role: "superuser" }] },
      { roleMap: [{ claim: "groups", value: "all", role: "viewer", extra: 1 }] },
      { roleMap: [{ claim: "", value: "all", role: "viewer" }] },
      { roleMap: Array.from({ length: 51 }, (_, i) => ({ ...RULES[0], value: `g${i}` })) },
      { enabled: true }, // a provider is made off; turning it on is its own step
      { organizationId: o2 },
    ];
    for (const over of bad) {
      const res = await call("owner", "PUT", sso(), valid(over));
      const shown = JSON.stringify(over).slice(0, 60);
      expect([shown, res.status]).toEqual([shown, 422]);
    }
    for (const missing of ["issuer", "clientId", "clientSecret"]) {
      const { [missing]: _gone, ...rest } = valid() as Record<string, unknown>;
      expect([missing, (await call("owner", "PUT", sso(), rest)).status]).toEqual([missing, 422]);
    }
    expect([400, 422]).toContain((await call("owner", "PUT", sso())).status);
    expect(await getSsoProvider(t.db, o1)).toBeUndefined();
    expect(await ssoAudits()).toBe(0);
  });

  test("the issuer's address is judged like a notification sink's: https, a public host", async () => {
    const at = (issuer: string) => call("owner", "PUT", sso(), valid({ issuer }), strict);
    expect((await at("https://idp.example/realms/a")).status).toBe(201);
    await deleteSsoProvider(t.db, o1);
    for (const issuer of [
      "http://idp.example/realms/a", // not https
      "https://169.254.169.254/latest", // an address of this network
      "https://127.0.0.1/realms/a",
      "https://[::1]/realms/a",
    ]) {
      const res = await at(issuer);
      expect([issuer, res.status, res.json.code]).toEqual([issuer, 422, "issuer_refused"]);
    }
    resolves.to = "10.0.0.5"; // a public-looking name that points inside
    const inside = await at("https://idp.internal.example/realms/a");
    expect([inside.status, inside.json.code]).toEqual([422, "issuer_refused"]);
    expect(await getSsoProvider(t.db, o1)).toBeUndefined();
    expect(fetched).toEqual([]);
  });

  test("a body at every limit is made, changed and recorded: the audit row holds whatever is valid", async () => {
    const domains = (c: string) =>
      Array.from({ length: 20 }, (_, i) => `${c.repeat(90)}${String(i).padStart(2, "0")}.com`);
    const rules: RoleRule[] = Array.from({ length: 50 }, (_, i) => ({
      claim: "c".repeat(100),
      value: String(i).padEnd(200, "v"),
      role: "owner",
    }));
    const made = await call(
      "owner",
      "PUT",
      sso(),
      valid({
        issuer: `https://idp.example/${"a".repeat(236)}`,
        clientId: "c".repeat(255),
        clientSecret: "s".repeat(1024),
        emailDomains: domains("a"),
        roleMap: rules,
      }),
      strict,
    );
    expect([made.status, made.json.issuer?.length]).toEqual([201, 256]);
    const changed = await call("owner", "PATCH", sso(), {
      clientId: "d".repeat(255),
      emailDomains: domains("b"),
      roleMap: rules,
    });
    expect(changed.status).toBe(200);
    expect((await auditsOf("sso.create")).length).toBe(1);
    expect((await auditsOf("sso.update")).length).toBe(1);
  });

  test("a change replaces what is named; the issuer is not among it; the secret is sealed again", async () => {
    const provider = await made();
    const res = await call("owner", "PATCH", sso(), {
      clientId: "orch-2",
      clientSecret: NEW_SECRET,
      emailDomains: ["Other.example", "other.example"], // once each
      roleMap: [{ claim: "groups", value: "ops", role: "admin" }],
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ...provider,
      clientId: "orch-2",
      emailDomains: ["other.example"],
      roleMap: [{ claim: "groups", value: "ops", role: "admin" }],
      updatedAt: expect.any(String),
    });
    expect(await openSsoSecret(t.db, keys, provider.id)).toBe(NEW_SECRET);
    // only what was named changes
    const one = await call("owner", "PATCH", sso(), { clientId: "orch-3" });
    expect(one.json).toEqual({ ...res.json, clientId: "orch-3", updatedAt: expect.any(String) });
    expect(await openSsoSecret(t.db, keys, provider.id)).toBe(NEW_SECRET);
    // the audit row says what was changed, and says that a secret was, not what it was
    const [first, second] = await auditsOf("sso.update");
    expect(first?.metadata).toEqual({
      fields: ["clientId", "clientSecret", "emailDomains", "roleMap"],
      clientId: "orch-2",
      emailDomains: ["other.example"],
      roleRules: 1,
      roles: ["admin"],
    });
    expect(second?.metadata).toEqual({ fields: ["clientId"], clientId: "orch-3" });
  });

  test("a change that names the issuer, nothing, or something unknown is 422; none to change is 404", async () => {
    const provider = await made();
    for (const body of [
      { issuer: "https://idp.example/realms/b" }, // identities are an issuer's: another one is another provider
      {},
      { enabled: true },
      { clientId: "" },
      { clientSecret: "" },
      { emailDomains: ["acme"] },
      { roleMap: [{ claim: "g", value: "v", role: "root" }] },
      { clientId: "x", extra: 1 },
    ]) {
      const res = await call("owner", "PATCH", sso(), body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    expect((await call("owner", "GET", sso())).json).toEqual(provider);
    expect((await auditsOf("sso.update")).length).toBe(0);
    await deleteSsoProvider(t.db, o1);
    expect((await call("owner", "PATCH", sso(), { clientId: "x" })).status).toBe(404);
  });

  test("it is enabled once it names a domain and a rule; a change cannot take them away while it is on", async () => {
    for (const over of [{ emailDomains: [] }, { roleMap: [] }]) {
      await deleteSsoProvider(t.db, o1);
      await made(over);
      const refused = await call("owner", "POST", sso(o1, "/enable"));
      expect([JSON.stringify(over), refused.status, refused.json.code]).toEqual([
        JSON.stringify(over),
        422,
        "sso_incomplete",
      ]);
      expect((await call("owner", "GET", sso())).json.enabled).toBe(false);
    }
    expect((await auditsOf("sso.enable")).length).toBe(0);

    // one that is ready: on, and again (the same answer), then off, and again
    await deleteSsoProvider(t.db, o1);
    await made();
    for (const [path, enabled, action] of [
      ["/enable", true, "sso.enable"],
      ["/enable", true, "sso.enable"],
      ["/disable", false, "sso.disable"],
      ["/disable", false, "sso.disable"],
    ] as const) {
      const res = await call("owner", "POST", sso(o1, path));
      expect([path, res.status, res.json.enabled]).toEqual([path, 200, enabled]);
      expect((await auditsOf(action)).at(-1)).toMatchObject({
        actorKind: "user",
        resourceType: "sso_provider",
        resourceId: res.json.id,
      });
    }
    expect((await auditsOf("sso.enable")).length).toBe(2);
    expect((await auditsOf("sso.disable")).length).toBe(2);

    // while it is on, neither list may be emptied; while off, they may
    await call("owner", "POST", sso(o1, "/enable"));
    for (const body of [{ emailDomains: [] }, { roleMap: [] }]) {
      const res = await call("owner", "PATCH", sso(), body);
      expect([JSON.stringify(body), res.status, res.json.code]).toEqual([
        JSON.stringify(body),
        422,
        "sso_incomplete",
      ]);
    }
    expect((await call("owner", "GET", sso())).json).toMatchObject({
      emailDomains: ["acme.example"],
      roleMap: RULES,
    });
    await call("owner", "POST", sso(o1, "/disable"));
    expect((await call("owner", "PATCH", sso(), { roleMap: [] })).status).toBe(200);
  });

  test("enabling and disabling decide whether anyone can start to sign in", async () => {
    await made();
    const login = () => call(undefined, "GET", "/auth/sso/sso-one/login");
    expect((await login()).status).toBe(404); // off
    await call("owner", "POST", sso(o1, "/enable"));
    const on = await call(undefined, "GET", "/auth/sso/sso-one/login");
    expect(on.status).toBe(302);
    await call("owner", "POST", sso(o1, "/disable"));
    expect((await login()).status).toBe(404);
  });

  test("the test asks the provider for its endpoints and keys, and says in fixed words what it found", async () => {
    await made();
    const ok = await call("owner", "POST", sso(o1, "/test"));
    expect([ok.status, ok.json]).toEqual([200, { ok: true, keys: 1 }]);
    // the keys it counts are the RSA ones, which are the ones a sign-in can be checked with
    idp.extraKeys = [
      { ...idp.signer.jwk, kid: "kc-2" },
      { kty: "EC", kid: "ec-1", crv: "P-256", x: "x", y: "y" },
    ];
    expect((await call("owner", "POST", sso(o1, "/test"))).json).toEqual({ ok: true, keys: 2 });
    idp.extraKeys = [];
    expect(idp.requests.slice(-2)).toEqual([
      "GET /realms/acme/.well-known/openid-configuration",
      "GET /realms/acme/protocol/openid-connect/certs",
    ]);
    expect((await auditsOf("sso.test")).at(-1)?.metadata).toEqual({ ok: true });

    // a document for another issuer cannot vouch for this one
    idp.discovery = { issuer: "https://elsewhere.example/realms/acme" };
    const no = await call("owner", "POST", sso(o1, "/test"));
    expect([no.status, no.json]).toEqual([
      200,
      { ok: false, message: "discovery document is for another issuer" },
    ]);
    expect((await auditsOf("sso.test")).at(-1)?.metadata).toEqual({
      ok: false,
      reason: "discovery document is for another issuer",
    });
    // asking changed nothing
    expect((await call("owner", "GET", sso())).json.enabled).toBe(false);
  });

  test("the test refuses an address of this network before it asks, and a provider that is gone is 404", async () => {
    // a provider whose address went bad after it was made (the row is made without the route's check)
    await createSsoProvider(t.db, keys, {
      organizationId: o1,
      issuer: "https://10.0.0.5/realms/acme",
      clientId: "orch",
      clientSecret: CLIENT_SECRET,
      emailDomains: ["acme.example"],
      roleMap: RULES,
    });
    const res = await call("owner", "POST", sso(o1, "/test"), undefined, strict);
    expect([res.status, res.json]).toEqual([
      200,
      { ok: false, message: "provider address is not allowed" },
    ]);
    expect(fetched).toEqual([]);
    await deleteSsoProvider(t.db, o1);
    expect((await call("owner", "POST", sso(o1, "/test"))).status).toBe(404);
  });

  test("deleting takes the provider and its secret; another can be made after", async () => {
    const provider = await made();
    const res = await call("owner", "DELETE", sso());
    expect(res.status).toBe(204);
    expect((await call("owner", "GET", sso())).status).toBe(404);
    expect(await openSsoSecret(t.db, keys, provider.id)).toBeUndefined();
    expect((await auditsOf("sso.delete")).at(-1)).toMatchObject({
      actorKind: "user",
      resourceType: "sso_provider",
      resourceId: provider.id,
      metadata: { issuer: idp.issuer },
    });
    expect((await call("owner", "DELETE", sso())).status).toBe(404);
    expect((await call("owner", "PUT", sso(), valid())).status).toBe(201);
  });

  test("without a master key it cannot store a secret, and makes nothing", async () => {
    const res = await call("owner", "PUT", sso(), valid(), noKeys);
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect(await getSsoProvider(t.db, o1)).toBeUndefined();
    await made();
    expect((await call("owner", "PATCH", sso(), { clientId: "x" }, noKeys)).status).toBe(503);
    // turning it off needs no key, so it can always be done
    await call("owner", "POST", sso(o1, "/enable"));
    const off = await call("owner", "POST", sso(o1, "/disable"), undefined, noKeys);
    expect([off.status, off.json.enabled]).toEqual([200, false]);
  });

  test("no answer, audit row or log line holds the client secret, old or new", async () => {
    const texts: string[] = [];
    const take = async (
      who: "owner" | "admin",
      method: string,
      path: string,
      body?: unknown,
      to = app,
    ) => texts.push((await call(who, method, path, body, to)).text);
    await take("owner", "PUT", sso(), valid());
    await take("owner", "PUT", sso(), valid()); // the refusal
    await take("admin", "GET", sso());
    await take("owner", "PATCH", sso(), { clientSecret: NEW_SECRET });
    await take("owner", "PATCH", sso(), { clientSecret: "" }); // the refusal
    await take("owner", "POST", sso(o1, "/test"));
    await take("owner", "POST", sso(o1, "/enable"));
    await take("owner", "GET", sso());
    await take("owner", "POST", sso(o1, "/disable"));
    await take("owner", "DELETE", sso());
    await take("owner", "PUT", sso(), valid(), strict); // refused for its address
    const rows = JSON.stringify(await t.db.select().from(auditEvents));
    const everything = [...texts, rows, JSON.stringify(lines)].join("\n");
    for (const canary of [CLIENT_SECRET, NEW_SECRET, "CANARY"]) {
      expect([canary, everything.includes(canary)]).toEqual([canary, false]);
    }
    expect(texts.length).toBe(11);
  });
});
