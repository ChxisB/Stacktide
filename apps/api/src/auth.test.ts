import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { auditEvents, sessions, users } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { gitlabOAuth, pkceChallenge } from "@orch/gitlab";
import { createMockGitlab, type MockGitlab } from "@orch/gitlab/mock";
import { and, count, eq } from "drizzle-orm";
import { createApp } from "./app";
import { unauditedRoutes } from "./audit";
import { devPrincipal } from "./principal";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
const mocks: MockGitlab[] = [];
afterEach(() => {
  for (const m of mocks.splice(0)) m.stop();
});

const REDIRECT = "http://localhost/auth/callback";
const SECRET = "client-secret-CANARY-4417";
let nextGitlabId = 10_000;

function setup(over: { secure?: boolean; ttlMs?: number; configured?: boolean } = {}) {
  const oauthApp = { clientId: "app-id", clientSecret: SECRET, redirectUri: REDIRECT };
  const mock = createMockGitlab({ oauth: oauthApp });
  mocks.push(mock);
  const person = mock.addUser({ id: ++nextGitlabId, username: "ada", name: "Ada Lovelace" });
  mock.approveAs(person.id);
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ write: (l) => lines.push(JSON.parse(l)), level: "debug" });
  let clock = Date.now();
  const app = createApp({
    logger,
    db: t.db,
    principal: devPrincipal,
    ready: async () => {},
    auth: {
      oauth:
        over.configured === false ? undefined : gitlabOAuth({ baseUrl: mock.url, ...oauthApp }),
      secureCookies: over.secure,
      sessionTtlMs: over.ttlMs,
      now: () => clock,
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
    /** Login, then the visit to GitLab. Returns the path GitLab sent the browser back to. */
    const startLogin = async (returnTo?: string) => {
      const res = await call(
        `/auth/login${returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`}`,
      );
      const away = await fetch(res.headers.get("location") ?? "", { redirect: "manual" });
      const back = new URL(away.headers.get("location") ?? "");
      return {
        login: res,
        back: back.pathname + back.search,
        state: back.searchParams.get("state"),
      };
    };
    const signIn = async (returnTo?: string) => {
      const { back } = await startLogin(returnTo);
      return call(back);
    };
    return { call, jar, startLogin, signIn };
  }
  return { app, mock, lines, browser, person, advance: (ms: number) => (clock += ms) };
}

const sessionCount = async (userId: string) =>
  (await t.db.select({ n: count() }).from(sessions).where(eq(sessions.userId, userId)))[0]?.n ?? 0;
const userByGitlabId = async (id: number) =>
  (await t.db.select().from(users).where(eq(users.gitlabId, id)))[0];

describe("login", () => {
  test("sends the browser to GitLab with state and a PKCE challenge, and keeps the flow in a cookie", async () => {
    const { browser, mock } = setup();
    const b = browser();
    const res = await b.call("/auth/login");
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const to = new URL(res.headers.get("location") ?? "");
    expect(to.origin).toBe(mock.url);
    expect(to.pathname).toBe("/oauth/authorize");
    const flow = JSON.parse(Buffer.from(b.jar.get("orch_login") ?? "", "base64url").toString());
    expect(to.searchParams.get("state")).toBe(flow.s);
    expect(to.searchParams.get("code_challenge")).toBe(pkceChallenge(flow.v));
    expect(flow.s).not.toBe(flow.v);
    expect(to.search).not.toContain(SECRET);
    expect(to.search).not.toContain(flow.v); // the verifier never leaves the cookie
    const cookie = res.headers.getSetCookie()[0] ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/auth");
    expect(cookie).toContain("Max-Age=600");
  });

  test("each login gets its own state and verifier", async () => {
    const { browser } = setup();
    const [a, b] = [browser(), browser()];
    await a.call("/auth/login");
    await b.call("/auth/login");
    expect(a.jar.get("orch_login")).not.toBe(b.jar.get("orch_login"));
  });

  test("503 when GitLab sign-in is not configured", async () => {
    const { browser } = setup({ configured: false });
    const res = await browser().call("/auth/login");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "login_unavailable" });
  });
});

describe("callback", () => {
  test("signs the person in: user row, session cookie, audit row, back to where they were", async () => {
    const { browser, person, lines, mock } = setup();
    const b = browser();
    const res = await b.signIn("/projects?x=1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects?x=1");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("orch_session=")) ?? "";
    for (const part of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=43200"]) {
      expect(session).toContain(part);
    }
    expect(session).not.toContain("Secure");
    expect(cookies.some((c) => c.startsWith("orch_login=;") && c.includes("Max-Age=0"))).toBe(true);
    expect(b.jar.has("orch_login")).toBe(false);

    const user = await userByGitlabId(person.id);
    expect(user).toMatchObject({ username: "ada", name: "Ada Lovelace" });
    const me = await b.call("/auth/me");
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(await me.json()).toEqual({
      id: user?.id,
      gitlabId: person.id,
      username: "ada",
      name: "Ada Lovelace",
      platformAdmin: true, // these tests run as the development principal, which may do anything
    });

    const [event] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "auth.login"), eq(auditEvents.resourceId, user?.id ?? "")));
    expect(event).toMatchObject({ actorKind: "user", actorId: user?.id, resourceType: "user" });
    expect(event?.metadata).toEqual({ gitlabId: person.id });

    // Nothing that opens a door is stored or logged: not the cookie, the code, nor the access token.
    const token = b.jar.get("orch_session") ?? "";
    const stored = JSON.stringify(await t.db.select().from(sessions));
    const everything = JSON.stringify([lines, event, stored]);
    expect(stored).not.toContain(token);
    for (const secret of [token, SECRET, ...mock.issuedAccessTokens()]) {
      expect(everything).not.toContain(secret);
    }
    expect(mock.issuedAccessTokens()).toHaveLength(1);
  });

  test("the session cookie is Secure when the API is served over https", async () => {
    const { browser } = setup({ secure: true });
    const b = browser();
    const { login } = await b.startLogin();
    expect(login.headers.getSetCookie()[0]).toContain("Secure");
    const res = await b.signIn();
    expect(res.headers.getSetCookie().every((c) => c.includes("Secure"))).toBe(true);
  });

  test("a second sign-in is the same user with a new session; the old cookie stops working", async () => {
    const { browser, person } = setup();
    const b = browser();
    await b.signIn();
    const first = b.jar.get("orch_session") ?? "";
    await b.signIn();
    const second = b.jar.get("orch_session") ?? "";
    expect(second).not.toBe(first);
    const user = await userByGitlabId(person.id);
    expect(await sessionCount(user?.id ?? "")).toBe(1);
    const old = await browser().call("/auth/me", { headers: { cookie: `orch_session=${first}` } });
    expect(old.status).toBe(401);
    expect((await b.call("/auth/me")).status).toBe(200);
  });

  test("a cookie the browser arrives with is not adopted as the session", async () => {
    const { browser } = setup();
    const b = browser();
    b.jar.set("orch_session", "attacker-chosen-value");
    await b.signIn();
    expect(b.jar.get("orch_session")).not.toBe("attacker-chosen-value");
  });

  test("a wrong state is refused before GitLab is asked anything", async () => {
    const { browser, mock } = setup();
    const b = browser();
    const { back } = await b.startLogin();
    const forged = back.replace(/state=[^&]+/, "state=forged-state");
    const res = await b.call(forged);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_login_state" });
    expect(res.headers.getSetCookie().some((c) => c.startsWith("orch_session="))).toBe(false);
    expect(mock.requests.some((r) => r.path === "/oauth/token")).toBe(false);
  });

  test("no state at all, or no login cookie, is refused the same way", async () => {
    const { browser, mock } = setup();
    const b = browser();
    const { back } = await b.startLogin();
    expect((await b.call(back.replace(/&?state=[^&]+/, ""))).status).toBe(400);
    const stranger = browser(); // never visited /auth/login: no cookie to match
    expect((await stranger.call(back)).status).toBe(400);
    expect(mock.requests.some((r) => r.path === "/oauth/token")).toBe(false);
  });

  test("a login started in one browser cannot be finished in another (login CSRF)", async () => {
    const { browser } = setup();
    const [attacker, victim] = [browser(), browser()];
    const { back } = await attacker.startLogin(); // the attacker's own code and state
    await victim.call("/auth/login"); // the victim has a flow of their own
    const res = await victim.call(back);
    expect(res.status).toBe(400);
    expect((await victim.call("/auth/me")).status).toBe(401);
  });

  test("a flow older than ten minutes has expired", async () => {
    const { browser, advance } = setup();
    const b = browser();
    const { back } = await b.startLogin();
    advance(10 * 60_000 + 1000);
    const res = await b.call(back);
    expect(res.status).toBe(400);
  });

  test("a replayed callback fails: the cookie is spent, and GitLab will not honour the code twice", async () => {
    const { browser } = setup();
    const b = browser();
    const { back } = await b.startLogin();
    const flowCookie = b.jar.get("orch_login") ?? "";
    expect((await b.call(back)).status).toBe(302);
    expect((await b.call(back)).status).toBe(400); // cookie cleared
    // A browser that kept the cookie gets as far as GitLab, which refuses the used code.
    const replay = browser();
    replay.jar.set("orch_login", flowCookie);
    const res = await replay.call(back);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "login_failed" });
    expect(replay.jar.has("orch_session")).toBe(false);
  });

  test("a denied sign-in on GitLab ends without a session", async () => {
    const { browser, mock } = setup();
    mock.approveAs(undefined);
    const b = browser();
    const res = await b.signIn();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "login_denied" });
    expect(b.jar.has("orch_session")).toBe(false);
  });

  test("an error from GitLab wins over a code sent alongside it: no token is requested", async () => {
    const { browser, mock } = setup();
    const b = browser();
    const { back } = await b.startLogin();
    const res = await b.call(`${back}&error=access_denied`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "login_denied" });
    expect(mock.requests.some((r) => r.path === "/oauth/token")).toBe(false);
  });

  test("a GitLab account that is not active cannot sign in", async () => {
    const { browser, mock } = setup();
    const blocked = mock.addUser({
      id: ++nextGitlabId,
      username: "eve",
      name: "E",
      state: "blocked",
    });
    mock.approveAs(blocked.id);
    const b = browser();
    const res = await b.signIn();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "account_inactive" });
    expect(await userByGitlabId(blocked.id)).toBeUndefined();
  });

  test("GitLab being down is a 502 that says nothing of the inside", async () => {
    const { browser, mock, lines } = setup();
    mock.inject({ path: "/oauth/token", status: 500 });
    const b = browser();
    const res = await b.signIn();
    expect(res.status).toBe(502);
    const body = JSON.stringify(await res.json());
    expect(body).toContain("gitlab_unavailable");
    expect(body).not.toContain(mock.url);
    expect(lines.find((l) => l.msg === "gitlab sign-in failed")).toMatchObject({
      level: "warn",
      kind: "server",
    });
  });

  test("a rejected client secret is a 401 and the secret is nowhere", async () => {
    const mock = createMockGitlab({
      oauth: { clientId: "app-id", clientSecret: "the-real-secret-1", redirectUri: REDIRECT },
    });
    mocks.push(mock);
    const person = mock.addUser({ id: ++nextGitlabId, username: "ada", name: "A" });
    mock.approveAs(person.id);
    const lines: Record<string, unknown>[] = [];
    const app = createApp({
      logger: createLogger({ write: (l) => lines.push(JSON.parse(l)), level: "debug" }),
      db: t.db,
      principal: devPrincipal,
      ready: async () => {},
      auth: {
        oauth: gitlabOAuth({
          baseUrl: mock.url,
          clientId: "app-id",
          clientSecret: SECRET,
          redirectUri: REDIRECT,
        }),
      },
    });
    const start = await app.handle(new Request("http://localhost/auth/login"));
    const cookie = (start.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const away = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
    const back = new URL(away.headers.get("location") ?? "");
    const res = await app.handle(
      new Request(`http://localhost${back.pathname}${back.search}`, { headers: { cookie } }),
    );
    expect(res.status).toBe(401);
    expect(JSON.stringify([await res.text(), lines])).not.toContain(SECRET);
    expect(lines.find((l) => l.msg === "gitlab sign-in failed")).toMatchObject({
      level: "error",
      kind: "unauthorized",
    });
  });

  test("return_to can only name a path on this site", async () => {
    const { browser } = setup();
    for (const bad of [
      "//evil.example",
      "https://evil.example/x",
      "/\\evil.example",
      "javascript:alert(1)",
      "/a b",
      "",
    ]) {
      const res = await browser().signIn(bad);
      expect(res.headers.get("location"), bad).toBe("/");
    }
  });
});

describe("sessions", () => {
  test("a session length the database would refuse is caught at start-up, not after a code is spent", () => {
    for (const ttlMs of [0, 999, 1500.5, 91 * 86_400_000]) {
      expect(() => setup({ ttlMs }), String(ttlMs)).toThrow("session ttl");
    }
  });

  test("logging out with a dead cookie still clears it", async () => {
    const { browser } = setup();
    const b = browser();
    b.jar.set("orch_session", "long-expired-token");
    const res = await b.call("/auth/logout", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()[0]).toContain("orch_session=;");
    expect(res.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(b.jar.has("orch_session")).toBe(false);
  });

  test("no cookie, or one nobody issued, is a 401 problem", async () => {
    const { browser } = setup();
    const none = await browser().call("/auth/me");
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toContain("problem+json");
    expect(await none.json()).toMatchObject({ code: "unauthenticated" });
    const odd = await browser().call("/auth/me", {
      headers: { cookie: "orch_session=made-up-CANARY" },
    });
    expect(odd.status).toBe(401);
  });

  test("a session past its end is a 401", async () => {
    const { browser, person } = setup();
    const b = browser();
    await b.signIn();
    expect((await b.call("/auth/me")).status).toBe(200);
    const user = await userByGitlabId(person.id);
    await t.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.userId, user?.id ?? ""));
    expect((await b.call("/auth/me")).status).toBe(401);
  });

  test("Max-Age is whole seconds even when the length is not", async () => {
    const { browser } = setup({ ttlMs: 90_500 });
    const res = await browser().signIn();
    expect(res.headers.getSetCookie().join()).toContain("Max-Age=90;");
  });

  test("the session lasts as long as configured", async () => {
    const { browser, person } = setup({ ttlMs: 2 * 3_600_000 });
    const b = browser();
    const res = await b.signIn();
    expect(res.headers.getSetCookie().join()).toContain("Max-Age=7200");
    const user = await userByGitlabId(person.id);
    const [row] = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user?.id ?? ""));
    expect(Math.abs((row?.expiresAt.getTime() ?? 0) - Date.now() - 7_200_000)).toBeLessThan(60_000);
  });

  test("logout ends the session, clears the cookie and is audited; doing it again is a 401", async () => {
    const { browser, person } = setup();
    const b = browser();
    await b.signIn();
    const user = await userByGitlabId(person.id);
    const stale = b.jar.get("orch_session") ?? "";
    const res = await b.call("/auth/logout", { method: "POST" });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(b.jar.has("orch_session")).toBe(false);
    expect(await sessionCount(user?.id ?? "")).toBe(0);
    const stolen = await browser().call("/auth/me", {
      headers: { cookie: `orch_session=${stale}` },
    });
    expect(stolen.status).toBe(401);
    const again = await b.call("/auth/logout", { method: "POST" });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ code: "unauthenticated" });
    const [event] = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "auth.logout"), eq(auditEvents.resourceId, user?.id ?? "")),
      );
    expect(event).toMatchObject({ actorKind: "user", actorId: user?.id });
  });

  test("each browser has its own session: one logout leaves the other signed in", async () => {
    const { browser } = setup();
    const [a, b] = [browser(), browser()];
    await a.signIn();
    await b.signIn(); // another device, same person
    expect((await a.call("/auth/logout", { method: "POST" })).status).toBe(204);
    expect((await a.call("/auth/me")).status).toBe(401);
    expect((await b.call("/auth/me")).status).toBe(200);
  });
});

describe("route coverage", () => {
  test("every mutating route, the new ones included, declares its audit", () => {
    expect(unauditedRoutes(setup().app)).toEqual([]);
  });
});
