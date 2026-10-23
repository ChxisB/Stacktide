import { afterEach, describe, expect, test } from "bun:test";
import { GitlabError, pkceChallenge } from "@orch/gitlab";
import { createMockGithub } from "./mock/server";
import { githubOAuth } from "./oauth";

// FRG-25: authorization code + PKCE against GitHub's OAuth app, with the mock standing in for GitHub.

const APP = { clientId: "Iv1.not-a-real-id", clientSecret: "SEKRIT-client-secret-1234" };
const REDIRECT = "https://orch.example.com/auth/github/callback";

let mock: ReturnType<typeof createMockGithub>;
afterEach(() => mock?.stop());

function setup(over: Partial<Parameters<typeof githubOAuth>[0]> = {}) {
  mock?.stop();
  mock = createMockGithub({ oauth: APP });
  const oauth = githubOAuth({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    ...APP,
    redirectUri: REDIRECT,
    ...over,
  });
  return { oauth, verifier: "v".repeat(43) };
}

describe("the address that sends a person to GitHub", () => {
  test("asks for the least scope, with state and a PKCE challenge, and never the client secret", () => {
    const { oauth } = setup();
    const url = new URL(oauth.authorizeUrl({ state: "st4te", codeChallenge: "chal" }));
    expect(`${url.origin}${url.pathname}`).toBe(`${mock.url}/login/oauth/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP.clientId,
      redirect_uri: REDIRECT,
      scope: "read:user",
      state: "st4te",
      code_challenge: "chal",
      code_challenge_method: "S256",
    });
    expect(url.href).not.toContain(APP.clientSecret);
  });

  test("github.com is the default home", () => {
    const oauth = githubOAuth({ ...APP, redirectUri: REDIRECT });
    expect(oauth.authorizeUrl({ state: "s", codeChallenge: "c" })).toStartWith(
      "https://github.com/login/oauth/authorize?",
    );
  });

  test("an address that is not a URL, or a missing client id, is refused when the app is made", () => {
    expect(() => githubOAuth({ ...APP, redirectUri: "nope" })).toThrow(TypeError);
    expect(() => githubOAuth({ ...APP, clientId: "", redirectUri: REDIRECT })).toThrow(TypeError);
    expect(() => githubOAuth({ ...APP, clientSecret: "", redirectUri: REDIRECT })).toThrow(
      TypeError,
    );
  });
});

describe("the code a person comes back with", () => {
  test("is traded for a token that says who they are", async () => {
    const { oauth, verifier } = setup();
    const ada = mock.addUser("ada");
    const code = mock.grant("ada", pkceChallenge(verifier));
    const token = await oauth.exchangeCode({ code, codeVerifier: verifier });
    // no public name set: the login is what we show
    expect(await oauth.currentUser(token)).toEqual({
      githubId: ada.id,
      login: "ada",
      name: "ada",
    });
  });

  test("works once", async () => {
    const { oauth, verifier } = setup();
    mock.addUser("ada");
    const code = mock.grant("ada", pkceChallenge(verifier));
    await oauth.exchangeCode({ code, codeVerifier: verifier });
    const again = await oauth.exchangeCode({ code, codeVerifier: verifier }).catch((e) => e);
    expect(again).toBeInstanceOf(GitlabError);
    expect(again.kind).toBe("invalid");
  });

  test("is refused when the verifier is not the one the challenge came from, or none comes", async () => {
    const { oauth, verifier } = setup();
    mock.addUser("ada");
    for (const wrong of ["w".repeat(43), ""]) {
      const code = mock.grant("ada", pkceChallenge(verifier));
      const error = await oauth.exchangeCode({ code, codeVerifier: wrong }).catch((e) => e);
      expect([wrong.length, error.kind]).toEqual([wrong.length, "invalid"]);
    }
  });

  test("GitHub says 200 with an error in the body, and that is a failure that names only its code", async () => {
    const { oauth, verifier } = setup();
    const error = await oauth
      .exchangeCode({ code: "not-a-code", codeVerifier: verifier })
      .catch((e) => e);
    expect(error).toBeInstanceOf(GitlabError);
    expect(error.kind).toBe("invalid");
    expect(error.message).toContain("bad_verification_code");
    expect(error.message).not.toContain("not-a-code");
    expect(error.message).not.toContain(verifier);
  });

  test("a wrong client secret is the deployment's fault: unauthorized, and the secret is not in the message", async () => {
    const { oauth, verifier } = setup({ clientSecret: "SEKRIT-wrong-secret-9999" });
    mock.addUser("ada");
    const code = mock.grant("ada", pkceChallenge(verifier));
    const error = await oauth.exchangeCode({ code, codeVerifier: verifier }).catch((e) => e);
    expect(error.kind).toBe("unauthorized");
    expect(error.message).not.toContain("SEKRIT");
  });

  test("an answer that is no token is an unexpected one", async () => {
    const verifier = "v".repeat(43);
    const odd = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({}) });
    try {
      const other = githubOAuth({
        baseUrl: `http://127.0.0.1:${odd.port}`,
        allowInsecureHttp: true,
        ...APP,
        redirectUri: REDIRECT,
      });
      const error = await other.exchangeCode({ code: "c", codeVerifier: verifier }).catch((e) => e);
      expect(error.kind).toBe("unexpected");
    } finally {
      await odd.stop(true);
    }
  });

  test("a token GitHub does not know is unauthorized when asking who it is", async () => {
    mock?.stop();
    mock = createMockGithub({ oauth: APP, token: "ghp_only-this-one-1234" });
    const same = githubOAuth({
      baseUrl: mock.url,
      allowInsecureHttp: true,
      ...APP,
      redirectUri: REDIRECT,
    });
    const error = await same.currentUser("gho_unknown-token-123").catch((e) => e);
    expect(error.kind).toBe("unauthorized");
  });
});
