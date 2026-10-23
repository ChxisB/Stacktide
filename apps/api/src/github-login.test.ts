import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLogger, DomainError, type Logger } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  importProject,
  sessions,
  userIdentities,
  users,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { githubForge } from "@orch/forge";
import { createGithubClient, githubOAuth } from "@orch/github";
import { createMockGithub, type MockGithub } from "@orch/github/mock";
import { eq, like } from "drizzle-orm";
import { createApp } from "./app";
import { githubRoles } from "./github-roles";
import { sessionPrincipal } from "./session";

// FRG-25: sign in with GitHub. The mock GitHub is the OAuth app, the API and the connection's repositories.

// A database per test: the mock numbers its accounts from the same start every time, and a GitHub id is a person.
let t: TestDb;
const mocks: MockGithub[] = [];
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  for (const m of mocks.splice(0)) m.stop();
  await t.drop();
});

const REDIRECT = "http://localhost/auth/github/callback";
const APP = { clientId: "Iv1.not-a-real-id", clientSecret: "gh-client-SECRET-CANARY-7731" };
const CONNECTION_TOKEN = "ghp_connection-SECRET-CANARY-5521";
const keys = envKeyProvider(`k1:${Buffer.alloc(32, 5).toString("base64")}`);
let n = 0;

interface Over {
  /** Which half of the sign-in the deployment configured: both by default. */
  configured?: "none" | "oauth-only";
  roles?: (githubId: number) => Promise<never> | never;
  secret?: string;
}

async function setup(over: Over = {}) {
  const mock = createMockGithub({ oauth: APP });
  mocks.push(mock);
  const lines: Record<string, unknown>[] = [];
  const logger: Logger = createLogger({ write: (l) => lines.push(JSON.parse(l)), level: "debug" });
  let clock = Date.now();

  // one repository linked to one project through a github.com connection, as the platform would hold it
  const org = await createOrganization(t.db, { slug: `acme-${++n}`, name: "Acme" });
  const connection = await createConnection(t.db, keys, {
    organizationId: org.id,
    type: "github",
    name: "hub",
    config: { baseUrl: "https://github.com" },
    token: CONNECTION_TOKEN,
  });
  const owner = `acme${n}`;
  const repo = mock.addRepo(owner, "web");
  const { project } = await importProject(t.db, {
    organizationId: org.id,
    connectionId: connection.id,
    gitlabProjectId: repo.id,
    name: "web",
    defaultBranch: "main",
    types: [],
  });
  const roles = githubRoles({
    db: t.db,
    keys,
    logger,
    forge: (_c, token) =>
      githubForge(
        createGithubClient({ baseUrl: mock.url, allowInsecureHttp: true, token, maxRetries: 0 }),
      ),
    now: () => clock,
  });
  const github = githubOAuth({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    clientId: APP.clientId,
    clientSecret: over.secret ?? APP.clientSecret,
    redirectUri: REDIRECT,
  });
  const auth = {
    ...(over.configured === "none" ? {} : { github }),
    ...(over.configured ? {} : { githubRoles: over.roles ?? roles }),
    now: () => clock,
  };
  const app = createApp({
    logger,
    db: t.db,
    principal: sessionPrincipal({ db: t.db, githubRoles: roles }),
    ready: async () => {},
    keys,
    auth,
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
    /** Starts, then plays GitHub: the person approves, and GitHub sends the browser back with a code. */
    const start = async (login: string, returnTo?: string) => {
      const res = await call(
        `/auth/github/login${returnTo === undefined ? "" : `?return_to=${encodeURIComponent(returnTo)}`}`,
      );
      const to = new URL(res.headers.get("location") ?? "http://none/");
      const code = mock.grant(login, to.searchParams.get("code_challenge") ?? undefined);
      const back = `/auth/github/callback?code=${code}&state=${to.searchParams.get("state")}`;
      return { res, to, code, back };
    };
    return { call, jar, start };
  }
  return {
    app,
    mock,
    roles,
    org,
    project,
    owner,
    lines,
    browser,
    advance: (ms: number) => (clock += ms),
    /** A GitHub account that collaborates on the repository. */
    collaborator(login: string, role = "write") {
      const who = mock.addUser(login);
      mock.addCollaborator(owner, "web", login, role);
      return who;
    },
  };
}

const githubIdentities = () =>
  t.db.select().from(userIdentities).where(eq(userIdentities.provider, "github"));

describe("starting a GitHub sign-in", () => {
  test("sends the browser to GitHub with the least scope, state and a PKCE challenge, and keeps the flow in a cookie", async () => {
    const s = await setup();
    const { res, to } = await s.browser().start("ada");
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(to.origin + to.pathname).toBe(`${s.mock.url}/login/oauth/authorize`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: APP.clientId,
      redirect_uri: REDIRECT,
      scope: "read:user",
      code_challenge_method: "S256",
    });
    expect(to.searchParams.get("state")?.length).toBeGreaterThan(20);
    expect(to.href).not.toContain(APP.clientSecret);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("orch_github="));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/auth");
    expect(cookie).toContain("Max-Age=600");
    // the verifier stays in the cookie: the challenge is all GitHub sees
    expect(to.href).not.toContain(
      JSON.parse(Buffer.from(cookie?.split(";")[0]?.split("=")[1] ?? "", "base64url").toString()).v,
    );
  });

  test("a return address that is not a path on this site becomes the front page", async () => {
    const s = await setup();
    s.collaborator("ada");
    for (const [asked, sent] of [
      ["/projects", "/projects"],
      ["//evil.example/x", "/"],
      ["https://evil.example/", "/"],
      ["/\\evil.example", "/"],
    ] as const) {
      const b = s.browser();
      const { back } = await b.start("ada", asked);
      expect((await b.call(back)).headers.get("location")).toBe(sent);
    }
  });

  test("answers 503 unless both the OAuth app and the roles source are configured", async () => {
    for (const configured of ["none", "oauth-only"] as const) {
      const s = await setup({ configured });
      const b = s.browser();
      for (const path of ["/auth/github/login", "/auth/github/callback?code=c&state=s"]) {
        const res = await b.call(path);
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ code: "login_unavailable" });
        expect(res.headers.getSetCookie()).toEqual([]);
      }
    }
  });
});

describe("completing a GitHub sign-in", () => {
  test("a collaborator gets a session as a person with no GitLab id, the roles of the repository, and an audited login", async () => {
    const s = await setup();
    const who = s.collaborator("ada", "maintain");
    const b = s.browser();
    const { back } = await b.start("ada", "/projects");
    const done = await b.call(back);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe("/projects");
    expect(done.headers.get("cache-control")).toBe("no-store");
    const session = done.headers.getSetCookie().find((c) => c.startsWith("orch_session="));
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    // the flow cookie is spent
    expect(done.headers.getSetCookie().some((c) => /^orch_github=;.*Max-Age=0/.test(c))).toBe(true);

    const me = await b.call("/auth/me");
    expect(await me.json()).toMatchObject({
      gitlabId: null,
      username: "ada",
      platformAdmin: false,
    });
    const [identity] = await githubIdentities();
    expect(identity).toMatchObject({ subject: String(who.id), ssoProviderId: null, email: null });

    const [event] = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, identity?.userId ?? ""));
    expect(event).toMatchObject({
      action: "auth.login",
      actorKind: "user",
      actorId: identity?.userId,
      resourceType: "user",
    });
    expect(event?.metadata).toEqual({ provider: "github", githubId: who.id });

    // and the roles are those of the repository's permission
    const principal = await sessionPrincipal({ db: t.db, githubRoles: s.roles })(
      new Request("http://localhost/x", {
        headers: { cookie: `orch_session=${b.jar.get("orch_session")}` },
      }),
    );
    expect(principal).toMatchObject({
      subject: { orgRoles: {}, projectRoles: { [s.project.id]: "maintainer" } },
    });
  });

  test("the same account signs in as the same person, and the session it came with ends", async () => {
    const s = await setup();
    s.collaborator("ada");
    const b = s.browser();
    await b.call((await b.start("ada")).back);
    const first = b.jar.get("orch_session");
    const [before] = await t.db.select().from(users).where(eq(users.username, "ada"));
    await b.call((await b.start("ada")).back);
    expect(b.jar.get("orch_session")).not.toBe(first);
    expect(await githubIdentities()).toHaveLength(1);
    const live = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, before?.id ?? ""));
    expect(live).toHaveLength(1);
    expect(
      (await s.browser().call("/auth/me", { headers: { cookie: `orch_session=${first}` } })).status,
    ).toBe(401);
  });

  test("a GitHub account that holds no role in any linked repository is refused, and nothing is made", async () => {
    const s = await setup();
    const stranger = s.mock.addUser("stranger");
    const b = s.browser();
    const users0 = (await t.db.select().from(users)).length;
    const started = await b.start("stranger");
    const res = await b.call(started.back);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "no_access" });
    expect(res.headers.getSetCookie().some((c) => c.startsWith("orch_session="))).toBe(false);
    expect((await t.db.select().from(users)).length).toBe(users0);
    expect(await githubIdentities()).toHaveLength(0);
    expect(
      await t.db.select().from(auditEvents).where(like(auditEvents.action, "auth.login")),
    ).toHaveLength(0);
    const logged = s.lines.find((l) => l.msg === "github sign-in refused");
    expect(logged).toMatchObject({ github_id: stranger.id });
    // the refusal is logged without the code or the access token it was reached with
    const text = JSON.stringify(s.lines);
    for (const secret of [started.code, ...s.mock.issuedTokens()]) {
      expect(text).not.toContain(secret);
    }
  });

  test("the same state cannot be used twice, a different one, an expired flow or no cookie at all", async () => {
    const s = await setup();
    s.collaborator("ada");
    const b = s.browser();
    const { back } = await b.start("ada");
    const flowCookie = b.jar.get("orch_github") ?? "";
    expect((await b.call(back)).status).toBe(302);
    // replayed: the flow cookie was cleared by the first
    const replay = await b.call(back);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "invalid_login_state" });
    // a thief with both the address and the cookie still has a code GitHub has already spent
    const thief = s.browser();
    thief.jar.set("orch_github", flowCookie);
    const spent = await thief.call(back);
    expect(spent.status).toBe(401);
    expect(await spent.json()).toMatchObject({ code: "login_failed" });

    const c = s.browser();
    const started = await c.start("ada");
    const other = started.back.replace(/state=[^&]+/, "state=not-the-state");
    expect((await c.call(other)).status).toBe(400);
    // a state with the right value but no cookie (another browser)
    expect((await s.browser().call(started.back)).status).toBe(400);
    // expired
    s.advance(11 * 60_000);
    expect((await c.call(started.back)).status).toBe(400);
    expect(await githubIdentities()).toHaveLength(1);
  });

  test("a person who turned GitHub down is told so", async () => {
    const s = await setup();
    const b = s.browser();
    const { to } = await b.start("ada");
    const res = await b.call(
      `/auth/github/callback?error=access_denied&state=${to.searchParams.get("state")}`,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "login_denied" });
    const b2 = s.browser();
    const { to: to2 } = await b2.start("ada");
    const bare = await b2.call(`/auth/github/callback?state=${to2.searchParams.get("state")}`);
    expect(bare.status).toBe(401);
    expect(await bare.json()).toMatchObject({ code: "login_denied" });
  });

  test("an error from GitHub wins over a code that came with it: nobody is signed in", async () => {
    const s = await setup();
    s.collaborator("ada");
    const b = s.browser();
    const { to, code } = await b.start("ada");
    const res = await b.call(
      `/auth/github/callback?error=access_denied&code=${code}&state=${to.searchParams.get("state")}`,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "login_denied" });
    expect(await githubIdentities()).toHaveLength(0);
  });

  test("a code GitHub does not accept is a refused sign-in, not a crash", async () => {
    const s = await setup();
    const b = s.browser();
    const { to } = await b.start("ada");
    const res = await b.call(
      `/auth/github/callback?code=made-up&state=${to.searchParams.get("state")}`,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "login_failed" });
  });

  test("a client secret GitHub refuses is the deployment's fault: loud in the log, a plain refusal to the person", async () => {
    const s = await setup({ secret: "gh-WRONG-secret-0000" });
    s.collaborator("ada");
    const b = s.browser();
    const res = await b.call((await b.start("ada")).back);
    expect(res.status).toBe(401);
    expect(s.lines.some((l) => l.level === "error")).toBe(true);
    expect(JSON.stringify([s.lines, await res.clone().text()])).not.toContain("gh-WRONG");
  });

  test("GitHub being down is a 502, and the roles being unreadable is a 503: nobody is signed in on a guess", async () => {
    const down = await setup();
    down.collaborator("ada");
    const b = down.browser();
    const { back } = await b.start("ada");
    down.mock.stop();
    expect((await b.call(back)).status).toBe(502);

    const s = await setup({
      roles: () => {
        throw new DomainError(
          "membership_unavailable",
          503,
          "GitHub membership could not be checked",
        );
      },
    });
    s.collaborator("ada");
    const c = s.browser();
    const res = await c.call((await c.start("ada")).back);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "membership_unavailable" });
    expect(res.headers.getSetCookie().some((x) => x.startsWith("orch_session="))).toBe(false);
  });
});

describe("a person who signed in with GitHub, in their settings", () => {
  test("the GitHub identity is listed and is the account's own: it cannot be given up", async () => {
    const s = await setup();
    s.collaborator("ada");
    const b = s.browser();
    await b.call((await b.start("ada")).back);
    const list = (await (await b.call("/auth/identities")).json()) as {
      id: string;
      kind: string;
    }[];
    expect(list).toMatchObject([{ kind: "github", organizationSlug: null, email: null }]);
    expect(JSON.stringify(list)).not.toContain(String((await githubIdentities())[0]?.subject));
    const del = await b.call(`/auth/identities/${list[0]?.id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({ code: "identity_not_removable" });
    expect(await githubIdentities()).toHaveLength(1);
  });
});

describe("what never shows", () => {
  test("no client secret, access token, code, verifier or connection token is in a response, a log line, an audit row or a table", async () => {
    const s = await setup();
    s.collaborator("ada");
    const b = s.browser();
    const { res, back, code } = await b.start("ada");
    const verifier = JSON.parse(
      Buffer.from(
        res.headers
          .getSetCookie()
          .find((c) => c.startsWith("orch_github="))
          ?.split(";")[0]
          ?.split("=")[1] ?? "",
        "base64url",
      ).toString(),
    ).v as string;
    const done = await b.call(back);
    const me = await (await b.call("/auth/me")).text();
    const list = await (await b.call("/auth/identities")).text();
    const accessTokens = s.mock.issuedTokens();
    expect(accessTokens.length).toBeGreaterThan(0);
    const everything = JSON.stringify([
      s.lines,
      await done.clone().text(),
      Object.fromEntries(done.headers.entries()),
      me,
      list,
      await t.db.select().from(auditEvents),
      await t.db.select().from(userIdentities),
      await t.db.select().from(users),
      await t.db.select().from(sessions),
    ]);
    for (const secret of [APP.clientSecret, CONNECTION_TOKEN, code, verifier, ...accessTokens]) {
      expect(everything).not.toContain(secret);
    }
    // the session cookie is the one secret the browser keeps; the database holds its hash only
    const sessionToken = b.jar.get("orch_session") ?? "";
    expect(JSON.stringify(await t.db.select().from(sessions))).not.toContain(sessionToken);
  });
});
