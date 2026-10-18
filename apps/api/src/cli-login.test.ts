import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { apiTokens, auditEvents, cliLogins, createSession, sessions, upsertUser } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { pkceChallenge } from "@orch/gitlab";
import { eq, sql } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, isApiToken, randomToken } from "./tokens";

let t: TestDb;
let app: ReturnType<typeof makeApp>;
let alice: { id: string; cookie: string };
const lines: string[] = [];

const makeApp = () =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: () => ({ orgRoles: {}, projectRoles: {} }),
    }),
    ready: async () => {},
    // these tests make far more sign-ins and tokens than a person does; the limits are tested in limits.test.ts
    hardening: { rateLimitScale: 100 },
  });

beforeAll(async () => {
  t = await createTestDb();
  const user = await upsertUser(t.db, { gitlabId: 801, username: "alice", name: "Alice" });
  const session = randomToken();
  await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
  alice = { id: user.id, cookie: `orch_session=${session}` };
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

type Auth = { cookie: string } | { bearer: string } | undefined;
async function call(auth: Auth, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (auth && "cookie" in auth) headers.cookie = auth.cookie;
  if (auth && "bearer" in auth) headers.authorization = `Bearer ${auth.bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const STATE = "s".repeat(16);
const query = (over: Record<string, string> = {}, verifier = randomToken()) =>
  new URLSearchParams({
    port: "51234",
    state: STATE,
    challenge: pkceChallenge(verifier),
    ...over,
  });

/** The browser step with a session: the code the CLI would be handed on its loopback port. */
async function browser(verifier: string, over: Record<string, string> = {}) {
  const res = await call(alice, "GET", `/auth/cli?${query(over, verifier)}`);
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("location") ?? "");
  return { code: to.searchParams.get("code") ?? "", to, res };
}

async function signIn(name = "orch cli") {
  const verifier = randomToken();
  const { code } = await browser(verifier);
  const res = await call(undefined, "POST", "/auth/cli/token", { code, verifier, name });
  expect(res.status).toBe(201);
  return res.json as { id: string; token: string; prefix: string };
}

const codes = () => t.db.select().from(cliLogins);

describe("GET /auth/cli", () => {
  test("without a session sends the browser to sign in and back here, nothing is minted", async () => {
    const before = (await codes()).length;
    const q = query();
    const res = await call(undefined, "GET", `/auth/cli?${q}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const to = new URL(res.headers.get("location") ?? "", "http://localhost");
    expect(to.pathname).toBe("/auth/login");
    const back = to.searchParams.get("return_to") ?? "";
    expect(new URL(back, "http://localhost").pathname).toBe("/auth/cli");
    expect(back).toBe(`/auth/cli?${q}`);
    expect(await codes()).toHaveLength(before);
  });

  test("an expired session is no session", async () => {
    const stale = randomToken();
    await createSession(t.db, { userId: alice.id, tokenHash: hashToken(stale), ttlMs: 60_000 });
    await t.db
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.tokenHash, hashToken(stale)));
    const res = await call({ cookie: `orch_session=${stale}` }, "GET", `/auth/cli?${query()}`);
    expect(new URL(res.headers.get("location") ?? "", "http://localhost").pathname).toBe(
      "/auth/login",
    );
  });

  test("with a session hands the CLI's own port a code and its state; only the code's hash and the challenge are kept", async () => {
    const verifier = randomToken();
    const { code, to, res } = await browser(verifier, { port: "40000" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(`${to.protocol}//${to.host}${to.pathname}`).toBe("http://127.0.0.1:40000/callback");
    expect(to.searchParams.get("state")).toBe(STATE);
    expect([...to.searchParams.keys()].sort()).toEqual(["code", "state"]);
    expect(code.length).toBeGreaterThanOrEqual(43);
    const [row] = await t.db
      .select()
      .from(cliLogins)
      .where(eq(cliLogins.codeHash, hashToken(code)));
    expect(row).toMatchObject({ userId: alice.id, challenge: pkceChallenge(verifier) });
    expect(JSON.stringify(await codes())).not.toContain(code);
  });

  test("two sign-ins get two different codes", async () => {
    const [a, b] = [await browser(randomToken()), await browser(randomToken())];
    expect(a.code).not.toBe(b.code);
  });

  test("answers only for a port, state and challenge of the right shape, and then nowhere else than 127.0.0.1", async () => {
    const before = (await codes()).length;
    const bad: Record<string, string>[] = [
      { port: "80" },
      { port: "1023" },
      { port: "65536" },
      { port: "0" },
      { port: "-1" },
      { port: "51234.5" },
      { port: "abc" },
      { port: "" },
      { port: "1e4" },
      { port: "0x1F90" },
      { port: " 8080" },
      { port: "08080 " },
      { port: "100000" },
      { port: "008080" },
      { state: "short" },
      { state: "x".repeat(129) },
      { state: `${"s".repeat(16)}&x=1` },
      { state: `${"s".repeat(15)}/` },
      { state: `${"s".repeat(15)} ` },
      { challenge: "A".repeat(42) },
      { challenge: "A".repeat(44) },
      { challenge: `${"A".repeat(42)}=` },
    ];
    for (const over of bad) {
      const res = await call(alice, "GET", `/auth/cli?${query(over)}`);
      expect([over, res.status, res.json?.code]).toEqual([over, 422, "validation_failed"]);
    }
    for (const missing of ["port", "state", "challenge"]) {
      const q = query();
      q.delete(missing);
      expect((await call(alice, "GET", `/auth/cli?${q}`)).status).toBe(422);
    }
    expect(await codes()).toHaveLength(before);
    for (const port of ["1024", "65535"]) {
      const { to } = await browser(randomToken(), { port });
      expect(to.hostname).toBe("127.0.0.1");
      expect(to.port).toBe(port);
    }
    expect((await browser(randomToken(), { port: "08080" })).to.port).toBe("8080");
  });
});

describe("POST /auth/cli/token", () => {
  test("gives the CLI a token for the person who signed in, once, and audits it", async () => {
    const verifier = randomToken();
    const { code } = await browser(verifier);
    const res = await call(undefined, "POST", "/auth/cli/token", { code, verifier });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { token, ...shown } = res.json;
    expect(isApiToken(token)).toBe(true);
    expect(shown).toMatchObject({
      name: "orch cli",
      prefix: token.split(".")[0],
      scopes: ["*"],
      lastUsedAt: null,
      revokedAt: null,
    });
    const days = (Date.parse(shown.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    const [row] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, shown.id));
    expect(row).toMatchObject({ userId: alice.id, tokenHash: hashToken(token) });
    const events = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, shown.id));
    expect(events.map((e) => [e.action, e.actorKind, e.actorId])).toEqual([
      ["token.create", "user", alice.id],
    ]);
    expect(events[0]?.metadata).toMatchObject({ scopes: ["*"], via: "cli_login" });
  });

  test("a name can be given", async () => {
    expect((await signIn("laptop")).prefix).toMatch(/^orch_/);
    const names = (await t.db.select().from(apiTokens)).map((r) => r.name);
    expect(names).toContain("laptop");
  });

  test("a code works once", async () => {
    const verifier = randomToken();
    const { code } = await browser(verifier);
    expect((await call(undefined, "POST", "/auth/cli/token", { code, verifier })).status).toBe(201);
    const again = await call(undefined, "POST", "/auth/cli/token", { code, verifier });
    expect([again.status, again.json.code]).toEqual([400, "invalid_login_code"]);
  });

  test("a wrong verifier is refused and burns the code", async () => {
    const verifier = randomToken();
    const { code } = await browser(verifier);
    const wrong = await call(undefined, "POST", "/auth/cli/token", {
      code,
      verifier: randomToken(),
    });
    expect([wrong.status, wrong.json.code]).toEqual([400, "invalid_login_code"]);
    const right = await call(undefined, "POST", "/auth/cli/token", { code, verifier });
    expect([right.status, right.json.code]).toEqual([400, "invalid_login_code"]);
  });

  test("the challenge itself is not the verifier", async () => {
    const verifier = randomToken();
    const { code } = await browser(verifier);
    const res = await call(undefined, "POST", "/auth/cli/token", {
      code,
      verifier: pkceChallenge(verifier),
    });
    expect(res.status).toBe(400);
  });

  test("an unknown or expired code is refused", async () => {
    const verifier = randomToken();
    const unknown = await call(undefined, "POST", "/auth/cli/token", {
      code: randomToken(),
      verifier,
    });
    expect([unknown.status, unknown.json.code]).toEqual([400, "invalid_login_code"]);
    const { code } = await browser(verifier);
    await t.db
      .update(cliLogins)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(cliLogins.codeHash, hashToken(code)));
    const late = await call(undefined, "POST", "/auth/cli/token", { code, verifier });
    expect([late.status, late.json.code]).toEqual([400, "invalid_login_code"]);
  });

  test("refuses a body of the wrong shape, and no token is made", async () => {
    const before = (await t.db.select().from(apiTokens)).length;
    const verifier = randomToken();
    const { code } = await browser(verifier);
    const bad = [
      {},
      { code },
      { verifier },
      { code, verifier: "short" },
      { code, verifier: `${"v".repeat(42)}!` },
      { code: "short", verifier },
      { code, verifier, name: "" },
      { code, verifier, scopes: ["*"] },
      { code, verifier, userId: alice.id },
    ];
    for (const body of bad) {
      const res = await call(undefined, "POST", "/auth/cli/token", body);
      expect([body, res.status, res.json.code]).toEqual([body, 422, "validation_failed"]);
    }
    expect(await t.db.select().from(apiTokens)).toHaveLength(before);
    // none of that used the code up
    expect((await call(undefined, "POST", "/auth/cli/token", { code, verifier })).status).toBe(201);
  });

  test("nobody's session or token is needed, and a bad one is not looked at", async () => {
    const verifier = randomToken();
    const { code } = await browser(verifier);
    const res = await call({ bearer: "orch_AAAAAAAA.bad" }, "POST", "/auth/cli/token", {
      code,
      verifier,
    });
    expect(res.status).toBe(201);
  });
});

describe("a token made by signing in", () => {
  test("works as its owner, says who it is, and cannot make tokens", async () => {
    const { id, token } = await signIn();
    const me = await call({ bearer: token }, "GET", "/auth/whoami");
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(me.json).toEqual({ kind: "token", id, scopes: ["*"], environmentId: null });
    expect((await call({ bearer: token }, "GET", "/organizations")).status).toBe(200);
    const mint = await call({ bearer: token }, "POST", "/tokens", { name: "x", scopes: ["*"] });
    expect([mint.status, mint.json.code]).toEqual([403, "forbidden"]);
  });

  test("the plaintext is in the one response that made it, and the code is in none of the records", async () => {
    const verifier = randomToken();
    const { code } = await browser(verifier);
    const res = await call(undefined, "POST", "/auth/cli/token", { code, verifier });
    const { token } = res.json;
    await call({ bearer: token }, "GET", "/auth/whoami");
    await call({ bearer: token }, "POST", "/auth/cli/logout");
    await call(undefined, "POST", "/auth/cli/token", { code, verifier });
    const everything = JSON.stringify([
      await t.db.select().from(apiTokens),
      await t.db.select().from(auditEvents),
      await codes(),
      lines,
    ]);
    for (const secret of [token, token.split(".")[1] ?? "", code, verifier])
      expect(everything).not.toContain(secret);
    expect(lines.length).toBeGreaterThan(5);
  });
});

describe("GET /whoami", () => {
  test("needs a caller", async () => {
    const res = await call(undefined, "GET", "/auth/whoami");
    expect([res.status, res.json.code]).toEqual([401, "unauthenticated"]);
    expect((await call({ bearer: "orch_AAAAAAAA.bad" }, "GET", "/auth/whoami")).status).toBe(401);
  });

  test("a session is a user with no scope limit", async () => {
    const res = await call(alice, "GET", "/auth/whoami");
    expect(res.json).toEqual({ kind: "user", id: alice.id, scopes: null, environmentId: null });
  });

  test("a limited token shows its limits", async () => {
    const made = await call(alice, "POST", "/tokens", {
      name: "ro",
      scopes: ["organization.read", "project.*"],
    });
    const res = await call({ bearer: made.json.token }, "GET", "/auth/whoami");
    expect(res.json).toEqual({
      kind: "token",
      id: made.json.id,
      scopes: ["organization.read", "project.*"],
      environmentId: null,
    });
  });
});

describe("POST /auth/cli/logout", () => {
  test("revokes the token it was called with, audited, and the token stops working", async () => {
    const { id, token } = await signIn();
    const res = await call({ bearer: token }, "POST", "/auth/cli/logout");
    expect(res.status).toBe(204);
    expect((await call({ bearer: token }, "GET", "/auth/whoami")).status).toBe(401);
    const [row] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, id));
    expect(row?.revokedAt).toBeInstanceOf(Date);
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, id));
    expect(events.map((e) => [e.action, e.actorKind, e.actorId])).toEqual([
      ["token.create", "user", alice.id],
      ["token.revoke", "token", id],
    ]);
    expect(events[1]?.metadata).toMatchObject({ via: "cli_logout" });
    expect((await call({ bearer: token }, "POST", "/auth/cli/logout")).status).toBe(401);
  });

  test("ends only the token it was called with", async () => {
    const [a, b] = [await signIn(), await signIn()];
    expect((await call({ bearer: a.token }, "POST", "/auth/cli/logout")).status).toBe(204);
    expect((await call({ bearer: b.token }, "GET", "/auth/whoami")).status).toBe(200);
  });

  test("is not for a session, and not for nobody", async () => {
    const session = await call(alice, "POST", "/auth/cli/logout");
    expect([session.status, session.json.code]).toEqual([403, "forbidden"]);
    expect((await call(alice, "GET", "/auth/whoami")).status).toBe(200);
    expect((await call(undefined, "POST", "/auth/cli/logout")).status).toBe(401);
  });
});
