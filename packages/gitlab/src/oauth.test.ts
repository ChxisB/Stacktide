import { afterEach, describe, expect, test } from "bun:test";
import { GitlabError } from "./errors";
import { createMockGitlab, type MockGitlab } from "./mock/server";
import { gitlabOAuth, pkceChallenge } from "./oauth";

const REDIRECT = "http://localhost:3000/auth/callback";
const SECRET = "client-secret-CANARY-77";
const VERIFIER = "v".repeat(43);
const mocks: MockGitlab[] = [];
const servers: { stop: (force?: boolean) => unknown }[] = [];
afterEach(() => {
  for (const m of mocks.splice(0)) m.stop();
  for (const s of servers.splice(0)) s.stop(true);
});

function setup(app: { clientSecret?: string } = { clientSecret: SECRET }) {
  const oauthApp = { clientId: "app-id", redirectUri: REDIRECT, ...app };
  const mock = createMockGitlab({ oauth: { ...oauthApp, clientSecret: app.clientSecret } });
  mocks.push(mock);
  mock.addUser({ id: 7, username: "ada", name: "Ada Lovelace" });
  mock.approveAs(7);
  const oauth = gitlabOAuth({ baseUrl: mock.url, ...oauthApp });
  /** What the browser does: open the authorize URL, read where GitLab sends it back. */
  const authorize = async (state = "state-1", verifier = VERIFIER) => {
    const res = await fetch(oauth.authorizeUrl({ state, codeChallenge: pkceChallenge(verifier) }), {
      redirect: "manual",
    });
    return new URL(res.headers.get("location") ?? "");
  };
  return { mock, oauth, authorize, oauthApp };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof GitlabError) return e;
    throw e;
  }
  throw new Error("expected a GitlabError");
};

describe("authorizeUrl", () => {
  test("asks for a code with PKCE S256, state and the narrowest scope", () => {
    const { oauth } = setup();
    const u = new URL(oauth.authorizeUrl({ state: "st", codeChallenge: "ch" }));
    expect(u.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "app-id",
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "read_user",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
    expect(u.search).not.toContain(SECRET);
  });

  test("keeps a URL root path of the instance", () => {
    const oauth = gitlabOAuth({
      baseUrl: "https://example.com/gitlab/",
      clientId: "a",
      redirectUri: REDIRECT,
    });
    expect(oauth.authorizeUrl({ state: "s", codeChallenge: "c" })).toStartWith(
      "https://example.com/gitlab/oauth/authorize?",
    );
  });

  test("pkceChallenge is the RFC 7636 S256 transform", () => {
    // The example from RFC 7636, appendix B.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("sign in against the mock", () => {
  test("code, token and user: the happy path", async () => {
    const { oauth, authorize } = setup();
    const back = await authorize("st-1");
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    const code = back.searchParams.get("code") ?? "";
    const token = await oauth.exchangeCode({ code, codeVerifier: VERIFIER });
    expect(await oauth.currentUser(token)).toEqual({
      gitlabId: 7,
      username: "ada",
      name: "Ada Lovelace",
      active: true,
    });
  });

  test("a user GitLab does not call active is reported as such", async () => {
    const { oauth, authorize, mock } = setup();
    mock.addUser({ id: 8, username: "blocked", name: "B", state: "blocked" });
    mock.approveAs(8);
    const code = (await authorize()).searchParams.get("code") ?? "";
    const token = await oauth.exchangeCode({ code, codeVerifier: VERIFIER });
    expect((await oauth.currentUser(token)).active).toBe(false);
  });

  test("a denied sign-in comes back as an error and no code", async () => {
    const { authorize, mock } = setup();
    mock.approveAs(undefined);
    const back = await authorize("st-2");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("state")).toBe("st-2");
  });

  test("a code works once: the replay fails as invalid_grant", async () => {
    const { oauth, authorize } = setup();
    const code = (await authorize()).searchParams.get("code") ?? "";
    await oauth.exchangeCode({ code, codeVerifier: VERIFIER });
    const e = await failure(oauth.exchangeCode({ code, codeVerifier: VERIFIER }));
    expect(e.kind).toBe("invalid");
    expect(e.message).toBe("GitLab POST /oauth/token failed (400): invalid_grant");
  });

  test("the verifier must be the one the challenge came from", async () => {
    const { oauth, authorize } = setup();
    const code = (await authorize()).searchParams.get("code") ?? "";
    const e = await failure(oauth.exchangeCode({ code, codeVerifier: "w".repeat(43) }));
    expect(e.message).toContain("invalid_grant");
    expect(e.message).not.toContain("www");
  });

  test("a wrong client secret is unauthorized and the message does not contain it", async () => {
    const { mock, authorize, oauthApp } = setup();
    const wrong = gitlabOAuth({
      baseUrl: mock.url,
      ...oauthApp,
      clientSecret: "not-the-secret-99",
    });
    const code = (await authorize()).searchParams.get("code") ?? "";
    const e = await failure(wrong.exchangeCode({ code, codeVerifier: VERIFIER }));
    expect(e.kind).toBe("unauthorized");
    expect(e.message).toBe("GitLab POST /oauth/token failed (401): invalid_client");
  });

  test("a public application (no secret) works with PKCE alone", async () => {
    const { oauth, authorize } = setup({});
    const code = (await authorize()).searchParams.get("code") ?? "";
    expect(await oauth.exchangeCode({ code, codeVerifier: VERIFIER })).toHaveLength(64);
  });

  test("the access token only reaches the user endpoint", async () => {
    const { mock, oauth, authorize } = setup();
    const code = (await authorize()).searchParams.get("code") ?? "";
    const token = await oauth.exchangeCode({ code, codeVerifier: VERIFIER });
    expect(mock.issuedAccessTokens()).toEqual([token]);
    const res = await fetch(`${mock.url}/api/v4/projects`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("failures", () => {
  test("an unreachable instance is a network error without the request in it", async () => {
    const oauth = gitlabOAuth({
      baseUrl: "http://127.0.0.1:1",
      clientId: "a",
      clientSecret: SECRET,
      redirectUri: REDIRECT,
    });
    const e = await failure(
      oauth.exchangeCode({ code: "the-code-CANARY", codeVerifier: VERIFIER }),
    );
    expect(e.kind).toBe("network");
    expect(e.message).toBe("GitLab POST /oauth/token request failed");
  });

  test("a slow instance times out", async () => {
    const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise(() => {}) });
    servers.push(slow);
    const oauth = gitlabOAuth({
      baseUrl: `http://127.0.0.1:${slow.port}`,
      clientId: "a",
      redirectUri: REDIRECT,
      timeoutMs: 50,
    });
    const e = await failure(oauth.exchangeCode({ code: "c", codeVerifier: VERIFIER }));
    expect(e.kind).toBe("timeout");
  });

  test("a reply that is not a token names the fields, not the values", async () => {
    const odd = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ access_token: 5, secret: SECRET }),
    });
    servers.push(odd);
    const oauth = gitlabOAuth({
      baseUrl: `http://127.0.0.1:${odd.port}`,
      clientId: "a",
      redirectUri: REDIRECT,
    });
    const e = await failure(oauth.exchangeCode({ code: "c", codeVerifier: VERIFIER }));
    expect(e.kind).toBe("unexpected");
    expect(e.message).toContain("access_token");
    expect(e.message).not.toContain(SECRET);
  });

  test("an error body that is not an OAuth error code is not repeated", async () => {
    const odd = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ error: `Bad ${SECRET} <html>` }, { status: 400 }),
    });
    servers.push(odd);
    const oauth = gitlabOAuth({
      baseUrl: `http://127.0.0.1:${odd.port}`,
      clientId: "a",
      redirectUri: REDIRECT,
    });
    const e = await failure(oauth.exchangeCode({ code: "c", codeVerifier: VERIFIER }));
    expect(e.message).toBe("GitLab POST /oauth/token failed (400)");
  });

  test("the user lookup fails as a GitlabError for a token GitLab does not know", async () => {
    const { oauth } = setup();
    const e = await failure(oauth.currentUser("an-unknown-access-token"));
    expect(e.kind).toBe("unauthorized");
  });

  test("bad configuration is refused without echoing it", () => {
    const base = { clientId: "a", redirectUri: REDIRECT };
    expect(() => gitlabOAuth({ ...base, baseUrl: `https://u:${SECRET}@x.com` })).toThrow(TypeError);
    expect(() => gitlabOAuth({ ...base, baseUrl: "http://gitlab.example.com" })).toThrow(TypeError);
    expect(() => gitlabOAuth({ ...base, baseUrl: "https://x.com", clientId: "" })).toThrow(
      TypeError,
    );
    expect(() => gitlabOAuth({ ...base, baseUrl: "https://x.com", redirectUri: "nope" })).toThrow(
      TypeError,
    );
    try {
      gitlabOAuth({ ...base, baseUrl: `https://u:${SECRET}@x.com` });
    } catch (e) {
      expect(String(e)).not.toContain(SECRET);
    }
  });
});
