import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { GitlabError } from "@orch/gitlab";
import { GITHUB_OIDC_ISSUER, githubKeys } from "./oidc";

const asked: { url: string; redirect?: string }[] = [];
const answer = (res: () => Response) =>
  spyOn(globalThis, "fetch").mockImplementation((async (
    input: URL | string,
    init?: RequestInit,
  ) => {
    asked.push({ url: String(input), redirect: init?.redirect });
    return res();
  }) as unknown as typeof fetch);

afterEach(() => {
  asked.length = 0;
  spyOn(globalThis, "fetch").mockRestore();
});

describe("GitHub's Actions keys", () => {
  test("are read from the issuer's own JWKS address, and only the RSA ones with an id are kept", async () => {
    answer(() =>
      Response.json({
        keys: [
          { kty: "RSA", kid: "a", n: "nn", e: "AQAB", use: "sig", x5c: ["ignored"] },
          { kty: "EC", kid: "b", crv: "P-256", x: "x", y: "y" },
          { kty: "RSA", n: "nn", e: "AQAB" },
        ],
      }),
    );
    expect(await githubKeys().jwks()).toEqual([{ kty: "RSA", kid: "a", n: "nn", e: "AQAB" }]);
    expect(asked).toEqual([{ url: `${GITHUB_OIDC_ISSUER}/.well-known/jwks`, redirect: "manual" }]);
  });

  test("a refusal, a redirect and a page that is not JSON are errors that name GitHub, not the address", async () => {
    for (const res of [
      () => new Response("no", { status: 500 }),
      () => new Response("", { status: 302, headers: { location: "https://evil.example/" } }),
      () => new Response("<html>", { status: 200 }),
    ]) {
      spyOn(globalThis, "fetch").mockRestore();
      answer(res);
      const error = await githubKeys()
        .jwks()
        .catch((e) => e);
      expect(error).toBeInstanceOf(GitlabError);
      expect(error.message).toStartWith("GitHub GET /.well-known/jwks");
      expect(error.message).not.toContain("http");
    }
  });
});
