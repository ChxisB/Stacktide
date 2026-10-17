import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitlabError } from "./errors";
import { createMockGitlab, type MockGitlab } from "./mock/server";
import { gitlabKeys } from "./oidc";

let mock: MockGitlab;
beforeEach(() => {
  mock = createMockGitlab();
});
afterEach(() => mock.stop());

const rsa = (kid: string) => ({ kty: "RSA", kid, n: "abc", e: "AQAB", use: "sig", alg: "RS256" });
const keys = () => gitlabKeys({ baseUrl: mock.url });
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e) => e as GitlabError,
  );

describe("gitlabKeys", () => {
  test("reads the published RSA keys, nothing else on them", async () => {
    mock.setJwks([rsa("k1"), rsa("k2")]);
    expect(await keys().jwks()).toEqual([
      { kty: "RSA", kid: "k1", n: "abc", e: "AQAB" },
      { kty: "RSA", kid: "k2", n: "abc", e: "AQAB" },
    ]);
    expect(mock.requests.at(-1)).toEqual({ method: "GET", path: "/oauth/discovery/keys" });
  });

  test("keys that cannot verify RS256 are left out, not an error", async () => {
    mock.setJwks([
      { kty: "EC", kid: "e", x: "1", y: "2" },
      { kty: "RSA", n: "a", e: "b" },
      "junk",
      rsa("ok"),
    ]);
    expect((await keys().jwks()).map((k) => k.kid)).toEqual(["ok"]);
  });

  test("an empty set is an empty list", async () => {
    expect(await keys().jwks()).toEqual([]);
  });

  test("a GitLab that fails, or answers nonsense, is a GitlabError", async () => {
    mock.inject({ path: "/oauth/discovery/keys", status: 500 });
    expect(await failure(keys().jwks())).toMatchObject({ kind: "server", status: 500 });
    mock.inject({ path: "/oauth/discovery/keys", status: 404 });
    expect(await failure(keys().jwks())).toMatchObject({ kind: "not_found" });

    const odd = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<html>") });
    try {
      const text = gitlabKeys({ baseUrl: `http://127.0.0.1:${odd.port}` });
      expect(await failure(text.jwks())).toMatchObject({ kind: "unexpected" });
    } finally {
      await odd.stop(true);
    }
    const shape = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ keys: 1 }),
    });
    try {
      expect(
        await failure(gitlabKeys({ baseUrl: `http://127.0.0.1:${shape.port}` }).jwks()),
      ).toMatchObject({
        kind: "unexpected",
      });
    } finally {
      await shape.stop(true);
    }
  });

  test("a GitLab that cannot be reached, or is too slow, is a GitlabError", async () => {
    const down = gitlabKeys({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    expect(await failure(down.jwks())).toMatchObject({ kind: "network" });
    const slow = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const err = await failure(
        gitlabKeys({ baseUrl: `http://127.0.0.1:${slow.port}`, timeoutMs: 100 }).jwks(),
      );
      expect(err).toMatchObject({ kind: "timeout" });
    } finally {
      await slow.stop(true);
    }
  });

  test("a redirect is not followed", async () => {
    const hop = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: `${mock.url}/oauth/discovery/keys` },
        }),
    });
    try {
      const err = await failure(gitlabKeys({ baseUrl: `http://127.0.0.1:${hop.port}` }).jwks());
      expect(err).toBeInstanceOf(GitlabError);
    } finally {
      await hop.stop(true);
    }
  });
});
