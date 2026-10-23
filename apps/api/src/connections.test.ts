import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, DomainError, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  connections,
  createOrganization,
  createSession,
  openConnection,
  openWebhookSecret,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGithub, type MockGithub } from "@orch/github/mock";
import { createMockGitlab } from "@orch/gitlab/mock";
import { eq, sql } from "drizzle-orm";
import { createApp } from "./app";
import { forgeFor, openGitlabConnection } from "./connections";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const keys = envKeyProvider(`k2:${key(2)},k1:${key(1)}`);
const OTHER_KEYS = envKeyProvider(`k9:${key(9)}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol", { id: string; cookie: string }>;

const makeApp = (provider: typeof keys | undefined, loopbackConnections = true) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys: provider,
    loopbackConnections,
  });
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({
    scopes: ["read_api", "read_repository"],
    tokenExpiresAt: "2099-01-31",
  });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  let gitlabId = 800;
  for (const name of ["alice", "bob", "carol"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(801, { orgRoles: { [o1]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(802, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob
  app = makeApp(keys);
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

async function call(
  who: keyof typeof people | undefined,
  method: string,
  path: string,
  body?: unknown,
  application = app,
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await application.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const base = (org = o1) => `/organizations/${org}/connections`;
let n = 0;
const body = (over: object = {}) => ({
  type: "gitlab",
  name: `gl${++n}`,
  baseUrl: mock.url,
  token: mock.token,
  ...over,
});
const create = async (over: object = {}) => {
  const res = await call("alice", "POST", base(), body(over));
  expect(res.status).toBe(201);
  return res.json as { id: string; name: string; config: { baseUrl: string } };
};

describe("creating a connection", () => {
  test("tests the token, stores it sealed and answers without it", async () => {
    const res = await call("alice", "POST", base(), body({ name: "  main  " }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: o1,
      type: "gitlab",
      name: "main",
      config: { baseUrl: mock.url },
    });
    expect(Object.keys(res.json).sort()).toEqual([
      "config",
      "createdAt",
      "id",
      "name",
      "organizationId",
      "type",
      "updatedAt",
    ]);
    expect(mock.requests.some((r) => r.path === "/api/v4/user")).toBe(true);
    const [row] = await t.db.select().from(connections).where(eq(connections.id, res.json.id));
    expect(Buffer.from(row?.secretEnc ?? []).toString("utf8")).not.toContain(mock.token);
  });

  test("a token GitLab rejects is a 422 in fixed words, and nothing is stored", async () => {
    const before = await t.db.select().from(connections);
    const wrong = "glpat-wrong-token-0123456789";
    const res = await call("alice", "POST", base(), body({ token: wrong }));
    expect([res.status, res.json.code]).toEqual([422, "connection_test_failed"]);
    expect(res.json.detail ?? res.json.message ?? res.text).toContain("GitLab rejected the token");
    expect(res.text).not.toContain(wrong);
    expect(await t.db.select().from(connections)).toHaveLength(before.length);
    const events = await t.db.select().from(auditEvents);
    expect(JSON.stringify(events)).not.toContain(wrong);
  });

  test("refuses what is not a name, a URL or a token, without echoing the URL", async () => {
    const empty = await call("alice", "POST", base(), {});
    expect([empty.status, empty.json.code]).toEqual([422, "validation_failed"]);
    const bad = [
      { name: "" },
      { type: "bitbucket" },
      { baseUrl: "not a url" },
      { baseUrl: "http://gitlab.example.com" }, // plain http off loopback
      { baseUrl: "https://user:hunter2@gitlab.example.com" },
      { baseUrl: "ftp://gitlab.example.com" },
      { token: "" },
      { token: "short" },
      { token: "has a space in it 123456" },
      { token: "x".repeat(513) },
      { organizationId: o2 },
    ];
    for (const over of bad) {
      const sent = { ...body(), ...over };
      const res = await call("alice", "POST", base(), sent);
      expect([over, res.status, res.json.code]).toEqual([over, 422, "validation_failed"]);
      expect(res.text).not.toContain("hunter2");
    }
  });

  test("normalises the URL and answers 409 for a name taken in the org only", async () => {
    const first = await create({ name: "dup", baseUrl: `${mock.url}/?x=1#frag` });
    expect(first.config.baseUrl).toBe(mock.url);
    const again = await call("alice", "POST", base(), body({ name: "dup" }));
    expect([again.status, again.json.code]).toEqual([409, "name_taken"]);
  });

  test("an address nobody answers at fails the test, and nothing is stored", async () => {
    const dead = createMockGitlab();
    const url = dead.url;
    dead.stop();
    const before = await t.db.select().from(connections);
    const res = await call("alice", "POST", base(), body({ baseUrl: url }));
    expect([res.status, res.json.code]).toEqual([422, "connection_test_failed"]);
    expect(res.text).not.toContain(url);
    expect(await t.db.select().from(connections)).toHaveLength(before.length);
  });

  test("says so when no master key is configured, and stores nothing", async () => {
    const before = await t.db.select().from(connections);
    const res = await call("alice", "POST", base(), body(), makeApp(undefined));
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect(await t.db.select().from(connections)).toHaveLength(before.length);
  });

  test("a base URL that points at this machine is refused unless the app allows it", async () => {
    const before = [mock.requests.length, (await t.db.select().from(connections)).length];
    const strict = makeApp(keys, false);
    for (const baseUrl of [
      mock.url,
      "http://localhost:8080",
      "https://127.0.0.1",
      "https://127.1/gitlab",
      "http://[::1]:3000",
      "https://app.localhost",
      "https://0.0.0.0",
    ]) {
      const res = await call("alice", "POST", base(), body({ baseUrl }), strict);
      expect([baseUrl, res.status, res.json.code]).toEqual([baseUrl, 422, "base_url_refused"]);
    }
    expect([mock.requests.length, (await t.db.select().from(connections)).length]).toEqual(before);
  });

  test("a token without a scope that reads the API is refused", async () => {
    const narrow = createMockGitlab({ scopes: ["read_user"] });
    try {
      const res = await call(
        "alice",
        "POST",
        base(),
        body({ baseUrl: narrow.url, token: narrow.token }),
      );
      expect([res.status, res.json.code]).toEqual([422, "connection_test_failed"]);
      expect(res.text).toContain("read_api");
    } finally {
      narrow.stop();
    }
    const wide = createMockGitlab({ scopes: ["api"] });
    try {
      const ok = await call(
        "alice",
        "POST",
        base(),
        body({ baseUrl: wide.url, token: wide.token }),
      );
      expect(ok.status).toBe(201);
    } finally {
      wide.stop();
    }
  });

  test("a token whose account is not active is refused", async () => {
    const stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ id: 5, username: "gone", name: "Gone", state: "blocked" }),
    });
    try {
      const before = await t.db.select().from(connections);
      const res = await call(
        "alice",
        "POST",
        base(),
        body({ baseUrl: `http://127.0.0.1:${stub.port}` }),
      );
      expect([res.status, res.json.code]).toEqual([422, "connection_test_failed"]);
      expect(await t.db.select().from(connections)).toHaveLength(before.length);
    } finally {
      await stub.stop(true);
    }
  });

  test("an organization that does not exist is a 404", async () => {
    roleTable.set(801, {
      orgRoles: { [o1]: "admin", "00000000-0000-4000-8000-000000000000": "admin" },
      projectRoles: {},
    });
    try {
      const res = await call("alice", "POST", base("00000000-0000-4000-8000-000000000000"), body());
      expect(res.status).toBe(404);
    } finally {
      roleTable.set(801, { orgRoles: { [o1]: "admin" }, projectRoles: {} });
    }
  });
});

describe("listing and deleting", () => {
  test("lists the org's connections, paged, and never another org's", async () => {
    const a = await create();
    const b = await create();
    const first = await call("alice", "GET", `${base()}?limit=1`);
    expect(first.status).toBe(200);
    expect(first.json.items).toHaveLength(1);
    expect(first.json.nextCursor).toBeTruthy();
    const all = await call("alice", "GET", `${base()}?limit=100`);
    const ids = all.json.items.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(JSON.stringify(all.json)).not.toContain(mock.token);
    roleTable.set(801, { orgRoles: { [o1]: "admin", [o2]: "admin" }, projectRoles: {} });
    try {
      expect((await call("alice", "GET", base(o2))).json.items).toEqual([]);
      // A connection of one org does not exist in another.
      expect((await call("alice", "POST", `${base(o2)}/${a.id}/test`)).status).toBe(404);
      expect((await call("alice", "DELETE", `${base(o2)}/${a.id}`)).status).toBe(404);
    } finally {
      roleTable.set(801, { orgRoles: { [o1]: "admin" }, projectRoles: {} });
    }
  });

  test("delete removes it once, and is audited", async () => {
    const c = await create();
    expect((await call("alice", "DELETE", `${base()}/${c.id}`)).status).toBe(204);
    expect((await call("alice", "DELETE", `${base()}/${c.id}`)).status).toBe(404);
    expect((await call("alice", "POST", `${base()}/${c.id}/test`)).status).toBe(404);
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, c.id));
    expect(events.map((e) => e.action).sort()).toEqual(["connection.create", "connection.delete"]);
  });

  test("an organization with connections cannot be deleted until they are", async () => {
    const owned = (await createOrganization(t.db, { slug: "owned", name: "Owned" })).id;
    roleTable.set(801, { orgRoles: { [o1]: "admin", [owned]: "owner" }, projectRoles: {} });
    try {
      const c = await call("alice", "POST", base(owned), body());
      expect(c.status).toBe(201);
      const refused = await call("alice", "DELETE", `/organizations/${owned}`);
      expect([refused.status, refused.json.code]).toEqual([409, "organization_not_empty"]);
      expect((await call("alice", "DELETE", `${base(owned)}/${c.json.id}`)).status).toBe(204);
      expect((await call("alice", "DELETE", `/organizations/${owned}`)).status).toBe(204);
    } finally {
      roleTable.set(801, { orgRoles: { [o1]: "admin" }, projectRoles: {} });
    }
  });
});

describe("testing a connection", () => {
  test("uses the stored token and reports who it is and what it may do", async () => {
    const c = await create();
    const seen = mock.requests.length;
    const res = await call("alice", "POST", `${base()}/${c.id}/test`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      ok: true,
      user: { gitlabId: mock.tokenUser.id, username: "mock-token-user", name: "Mock token user" },
      scopes: ["read_api", "read_repository"],
      expiresAt: "2099-01-31",
      version: "18.1.1-ee",
      capabilities: [
        {
          id: "hiddenVariables",
          label: "Hidden variables",
          state: "yes",
          needs: "GitLab 17.4 or later",
        },
        {
          id: "groupVariableScopes",
          label: "Environment scopes on group variables",
          state: "unknown",
          needs: "GitLab Premium or Ultimate",
        },
      ],
    });
    expect(mock.requests.length).toBeGreaterThan(seen);
  });

  test("an older Community Edition says which things it cannot do", async () => {
    const c = await create();
    mock.setVersion("17.3.2", false);
    try {
      const res = await call("alice", "POST", `${base()}/${c.id}/test`);
      expect(res.json).toMatchObject({ ok: true, version: "17.3.2" });
      expect(
        res.json.capabilities.map((x: { id: string; state: string }) => [x.id, x.state]),
      ).toEqual([
        ["hiddenVariables", "no"],
        ["groupVariableScopes", "no"],
      ]);
      expect(res.text).not.toContain(mock.token);
    } finally {
      mock.setVersion("18.1.1-ee", true);
    }
  });

  test("a GitLab that will not say its version still passes, with nothing claimed", async () => {
    const c = await create();
    mock.inject({ path: "/api/v4/version", status: 404 });
    const res = await call("alice", "POST", `${base()}/${c.id}/test`);
    expect(res.json).toMatchObject({ ok: true, version: null, capabilities: [] });
  });

  test("a token that has stopped working is an answer, not an error", async () => {
    const c = await create();
    mock.inject({ path: "/api/v4/user", status: 401 });
    const res = await call("alice", "POST", `${base()}/${c.id}/test`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(res.json.message).toContain("rejected the token");
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, c.id));
    const tested = events.find((e) => e.action === "connection.test");
    expect(tested?.metadata).toEqual({ ok: false, reason: "unauthorized" });
  });

  test("a GitLab that asks to wait half a minute is not waited for", async () => {
    const c = await create();
    mock.inject({ path: "/api/v4/user", status: 429, retryAfter: 30 });
    const started = Date.now();
    const res = await call("alice", "POST", `${base()}/${c.id}/test`);
    expect(res.json).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("scopes it cannot learn are null, the test still passes", async () => {
    const c = await create();
    mock.inject({ path: "/api/v4/personal_access_tokens/self", status: 404 });
    const res = await call("alice", "POST", `${base()}/${c.id}/test`);
    expect(res.json).toMatchObject({ ok: true, scopes: null, expiresAt: null });
  });

  test("without the master key it is a 503; with the wrong one, a 500 that names no secret", async () => {
    const c = await create();
    const none = await call(
      "alice",
      "POST",
      `${base()}/${c.id}/test`,
      undefined,
      makeApp(undefined),
    );
    expect([none.status, none.json.code]).toEqual([503, "secrets_unavailable"]);

    lines = [];
    const wrong = await call(
      "alice",
      "POST",
      `${base()}/${c.id}/test`,
      undefined,
      makeApp(OTHER_KEYS),
    );
    expect([wrong.status, wrong.json.code]).toEqual([500, "secret_unreadable"]);
    expect(wrong.text).not.toContain(mock.token);
    const logged = lines.join("\n");
    expect(logged).toContain("connection secret cannot be opened");
    expect(logged).toContain("unknown_key");
    expect(logged).not.toContain(mock.token);
  });
});

describe("who may", () => {
  test("only org admins; everyone else is refused, strangers see nothing", async () => {
    const c = await create();
    const routes: [string, string][] = [
      ["GET", base()],
      ["POST", base()],
      ["POST", `${base()}/${c.id}/test`],
      ["DELETE", `${base()}/${c.id}`],
    ];
    for (const [method, path] of routes) {
      const send = body();
      const anon = await call(undefined, method, path, method === "POST" ? send : undefined);
      expect([method, path, anon.status]).toEqual([method, path, 401]);
      const member = await call("bob", method, path, method === "POST" ? send : undefined);
      expect([method, path, member.status]).toEqual([method, path, 403]);
      const stranger = await call("carol", method, path, method === "POST" ? send : undefined);
      expect([method, path, stranger.status]).toEqual([method, path, 404]);
    }
    // Nothing the refused calls did reached the connection.
    expect((await call("alice", "DELETE", `${base()}/${c.id}`)).status).toBe(204);
  });
});

describe("the token", () => {
  test("is in no response, log line or audit row", async () => {
    const secret = mock.token;
    lines = [];
    const sent = [await call("alice", "POST", base(), body())];
    const c = sent[0]?.json as { id: string };
    sent.push(
      await call("alice", "POST", `${base()}/${c.id}/test`),
      await call("alice", "GET", base()),
      await call("alice", "POST", base(), body({ token: `${secret}-wrong` })),
      await call("alice", "POST", base(), { ...body(), token: secret, extra: true }),
    );
    // A body that does not parse, and one of the wrong shape, hold the token too.
    for (const raw of [
      `{"token":"${secret}", oops`,
      JSON.stringify({ token: [secret], name: 1 }),
    ]) {
      const res = await app.handle(
        new Request(`http://localhost${base()}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: people.alice.cookie },
          body: raw,
        }),
      );
      const text = await res.text();
      expect(res.status).toBeGreaterThanOrEqual(400);
      sent.push({ status: res.status, text, json: undefined });
    }
    mock.inject({ path: "/api/v4/user", status: 500, times: 2 });
    sent.push(
      await call("alice", "POST", `${base()}/${c.id}/test`),
      await call("alice", "DELETE", `${base()}/${c.id}`),
    );

    const everything = JSON.stringify([
      sent.map((r) => r.text),
      await t.db.select().from(auditEvents),
      await t.db.execute(sql`SELECT * FROM connections`),
      lines,
    ]);
    expect(everything).not.toContain(secret);
    expect(lines.length).toBeGreaterThan(5); // the logs were really captured
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, c.id));
    expect(events.map((e) => e.action).sort()).toEqual([
      "connection.create",
      "connection.delete",
      "connection.test",
      "connection.test",
    ]);
  });

  test("is sent to GitLab as the private token, and only to the connection's URL", async () => {
    const other = createMockGitlab({ token: "other-token-0123456789" });
    try {
      const c = await create();
      await call("alice", "POST", `${base()}/${c.id}/test`);
      expect(other.requests).toHaveLength(0);
    } finally {
      other.stop();
    }
  });
});

describe("a GitHub connection", () => {
  const TOKEN = "github_pat_not-a-real-token-0123456789";
  const HOOK = "whsec_not-a-real-webhook-secret-42";
  let gh: MockGithub;
  const ghBody = (over: object = {}) => ({
    type: "github",
    name: `gh${++n}`,
    baseUrl: gh.url,
    token: TOKEN,
    ...over,
  });
  const ghCreate = async (over: object = {}) => {
    const res = await call("alice", "POST", base(), ghBody(over));
    expect(res.status).toBe(201);
    return res.json as { id: string; config: Record<string, unknown> };
  };
  beforeAll(() => {
    gh = createMockGithub({ token: TOKEN });
    gh.addRepo("acme", "api");
  });
  afterAll(() => gh.stop());

  test("tests the token, stores it sealed with no webhook secret, and answers without either", async () => {
    const res = await call("alice", "POST", base(), ghBody({ name: "  hub  " }));
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: o1,
      type: "github",
      name: "hub",
      config: { baseUrl: gh.url },
    });
    expect(gh.requests.some((r) => r.path === "/user" && r.authorized)).toBe(true);
    const [row] = await t.db.select().from(connections).where(eq(connections.id, res.json.id));
    expect(Buffer.from(row?.secretEnc ?? []).toString("utf8")).not.toContain(TOKEN);
    expect(row?.webhookSecretEnc).toBeNull();
    expect(row?.webhookSecretHash).toBeNull();
    expect((await openConnection(t.db, keys, o1, res.json.id))?.token).toBe(TOKEN);
    expect(await openWebhookSecret(t.db, keys, o1, res.json.id)).toBeUndefined();
  });

  test("a webhook secret is sealed with it, readable only through openWebhookSecret", async () => {
    const c = await ghCreate({ webhookSecret: HOOK });
    expect(c.config).toEqual({ baseUrl: gh.url });
    const [row] = await t.db.select().from(connections).where(eq(connections.id, c.id));
    expect(row?.webhookSecretEnc).not.toBeNull();
    expect(Buffer.from(row?.webhookSecretEnc ?? []).toString("utf8")).not.toContain(HOOK);
    expect(row?.webhookSecretHash).toBeNull(); // GitLab's way (a hash) is not used: HMAC needs the secret
    expect(await openWebhookSecret(t.db, keys, o1, c.id)).toBe(HOOK);
    expect(await openWebhookSecret(t.db, keys, o2, c.id)).toBeUndefined(); // another organization's
  });

  test("a trailing slash, query and fragment are dropped from the address", async () => {
    const c = await ghCreate({ baseUrl: `${gh.url}/?x=1#frag` });
    expect(c.config.baseUrl).toBe(gh.url);
  });

  test("a token GitHub rejects is a 422 in fixed words, and nothing is stored", async () => {
    const before = await t.db.select().from(connections);
    const wrong = "github_pat_wrong-token-0123456789";
    const res = await call("alice", "POST", base(), ghBody({ token: wrong, webhookSecret: HOOK }));
    expect([res.status, res.json.code]).toEqual([422, "connection_test_failed"]);
    expect(res.json.detail ?? res.json.message ?? res.text).toContain("GitHub rejected the token");
    expect(res.text).not.toContain(wrong);
    expect(await t.db.select().from(connections)).toHaveLength(before.length);
  });

  test("a token that cannot read the contents of its repositories is refused", async () => {
    const narrow = createMockGithub({ token: TOKEN, denied: ["/contents"] });
    narrow.addRepo("acme", "api");
    try {
      const res = await call("alice", "POST", base(), ghBody({ baseUrl: narrow.url }));
      expect([res.status, res.json.code]).toEqual([422, "connection_test_failed"]);
      expect(res.text).toContain("Contents");
      expect(res.text).not.toContain(narrow.url);
    } finally {
      narrow.stop();
    }
  });

  test("refuses what is not a name, an address, a token or a webhook secret", async () => {
    const before = await t.db.select().from(connections);
    const asked = gh.requests.length;
    for (const bad of [
      { baseUrl: undefined },
      { baseUrl: "ftp://github.example.com" },
      { baseUrl: "https://user:hunter2@github.example.com" },
      { baseUrl: "http://github.example.com" },
      { token: "short" },
      { token: "has a space in the token 123" },
      { webhookSecret: "short" },
      { webhookSecret: "has a space in the secret 123456" },
      { webhookSecret: 7 },
      { extra: true },
      { type: "bitbucket" },
    ]) {
      const res = await call("alice", "POST", base(), ghBody(bad));
      expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 422]);
      expect(res.text).not.toContain("hunter2");
    }
    expect(await t.db.select().from(connections)).toHaveLength(before.length);
    expect(gh.requests).toHaveLength(asked); // refused by the shape, before GitHub was asked
  });

  test("an address that points at this machine is refused unless the app allows it", async () => {
    const before = gh.requests.length;
    const res = await call("alice", "POST", base(), ghBody(), makeApp(keys, false));
    expect([res.status, res.json.code]).toEqual([422, "base_url_refused"]);
    expect(gh.requests).toHaveLength(before);
  });

  test("the test names who the token is and what it could and could not use", async () => {
    const partial = createMockGithub({ token: TOKEN, denied: ["/hooks", "/environments"] });
    partial.addRepo("acme", "api");
    try {
      const c = await ghCreate({ baseUrl: partial.url });
      const res = await call("alice", "POST", `${base()}/${c.id}/test`);
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.summary).toContain("mock-user");
      expect(res.json.summary).toContain("acme/api");
      expect(res.json.summary).toMatch(/Contents.*Pull requests.*Actions/);
      expect(res.json.summary).toMatch(/Not allowed: Environments, Webhooks/);
      expect(res.json.summary).toContain("Only reads were tried");
      expect(res.text).not.toContain(TOKEN);
    } finally {
      partial.stop();
    }
  });

  test("a permission GitHub answers oddly about is reported as not clear, not as missing", async () => {
    const c = await ghCreate();
    gh.inject({ method: "GET", path: "/repos/acme/api/pulls", status: 422, times: 1 });
    const res = await call("alice", "POST", `${base()}/${c.id}/test`);
    expect(res.json.ok).toBe(true);
    expect(res.json.summary).toContain("Not clear: Pull requests.");
    expect(res.json.summary).not.toContain("Not allowed");
  });

  test("a token that sees no repository passes, and says nothing was checked", async () => {
    const empty = createMockGithub({ token: TOKEN });
    try {
      const res = await call("alice", "POST", base(), ghBody({ baseUrl: empty.url }));
      expect(res.status).toBe(201);
      const tested = await call("alice", "POST", `${base()}/${res.json.id}/test`);
      expect(tested.json).toMatchObject({ ok: true });
      expect(tested.json.summary).toContain("no repository");
    } finally {
      empty.stop();
    }
  });

  test("a token that has stopped working is an answer, not an error", async () => {
    const c = await ghCreate();
    gh.inject({ method: "GET", path: "/user", status: 401, times: 1 });
    const res = await call("alice", "POST", `${base()}/${c.id}/test`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(res.json.message).toContain("GitHub rejected the token");
  });

  test("the token and the webhook secret are in no response, log line or audit row", async () => {
    lines = [];
    const sent = [await call("alice", "POST", base(), ghBody({ webhookSecret: HOOK }))];
    const c = sent[0]?.json as { id: string };
    sent.push(
      await call("alice", "POST", `${base()}/${c.id}/test`),
      await call("alice", "GET", base()),
      await call("alice", "POST", base(), ghBody({ token: `${TOKEN}-wrong`, webhookSecret: HOOK })),
      await call("alice", "POST", base(), { ...ghBody({ webhookSecret: HOOK }), extra: true }),
      await call("alice", "POST", base(), ghBody({ webhookSecret: [HOOK] })),
    );
    gh.inject({ method: "GET", path: "/user", status: 500, times: 2 }); // the test route tries twice
    sent.push(
      await call("alice", "POST", `${base()}/${c.id}/test`),
      await call("alice", "DELETE", `${base()}/${c.id}`),
    );
    const everything = JSON.stringify([
      sent.map((r) => r.text),
      await t.db.select().from(auditEvents),
      await t.db.execute(sql`SELECT * FROM connections`),
      lines,
    ]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(HOOK);
    expect(lines.length).toBeGreaterThan(5); // the logs were really captured
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, c.id));
    expect(events.map((e) => e.action).sort()).toEqual([
      "connection.create",
      "connection.delete",
      "connection.test",
      "connection.test",
    ]);
  });

  test("the token goes to the connection's address only", async () => {
    const other = createMockGithub();
    try {
      const c = await ghCreate();
      await call("alice", "POST", `${base()}/${c.id}/test`);
      expect(other.requests).toHaveLength(0);
    } finally {
      other.stop();
    }
  });

  test("a GitHub connection is not opened as a GitLab one: its token never goes to a GitLab", async () => {
    const c = await ghCreate();
    await expect(
      openGitlabConnection(
        { db: t.db, keys, logger: createLogger({ write: () => {} }) },
        o1,
        c.id,
        "",
      ),
    ).rejects.toMatchObject({ code: "connection_type", status: 422 });
  });
});

describe("the forge of a connection", () => {
  test("a GitLab connection is the GitLab adapter, at its address, with its token", async () => {
    const forge = forgeFor({ type: "gitlab", config: { baseUrl: mock.url } }, mock.token);
    expect(forge.kind).toBe("gitlab");
    expect((await forge.users.current()).username).toBe("mock-token-user");
  });

  test("a GitHub connection is the GitHub adapter, at its address, with its token", async () => {
    const token = "github_pat_not-a-real-token-forge-0123";
    const hub = createMockGithub({ token });
    try {
      hub.addRepo("acme", "api");
      const forge = forgeFor({ type: "github", config: { baseUrl: hub.url } }, token);
      expect(forge.kind).toBe("github");
      expect((await forge.projects.get("acme/api")).path).toBe("acme/api");
      expect(hub.requests.every((r) => r.authorized)).toBe(true);
      // a stored config without an address is a 422, not a request to github.com
      expect(() => forgeFor({ type: "github", config: {} }, token)).toThrow(DomainError);
    } finally {
      hub.stop();
    }
  });

  test("a type that is no forge, or unknown, is refused", () => {
    for (const type of ["aws_assume_role", "kubernetes", "vault_approle", "bitbucket"]) {
      expect(() => forgeFor({ type, config: {} }, "x")).toThrow(DomainError);
    }
  });
});
