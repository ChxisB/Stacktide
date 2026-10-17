import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig } from "@orch/core";
import { z } from "zod";
import { authEnv, authFromEnv } from "./auth-config";

const SECRET = "client-secret-CANARY-8812";
const full = {
  GITLAB_URL: "https://gitlab.example.com",
  GITLAB_OAUTH_CLIENT_ID: "app-id",
  GITLAB_OAUTH_CLIENT_SECRET: SECRET,
  GITLAB_OAUTH_REDIRECT_URI: "https://orch.example.com/auth/callback",
};
const load = (env: Record<string, string>) => authFromEnv(loadConfig(authEnv, env));

describe("auth config", () => {
  test("nothing set: sign-in is simply off", () => {
    expect(load({})).toEqual({});
  });

  test("all four set: sign-in is on, and an https redirect makes cookies Secure", () => {
    const a = load(full);
    expect(a.oauth).toBeDefined();
    expect(a.secureCookies).toBe(true);
    const dev = load({ ...full, GITLAB_OAUTH_REDIRECT_URI: "http://localhost:3000/auth/callback" });
    expect(dev.secureCookies).toBe(false);
  });

  test("a partial setting names the missing keys, never a value", () => {
    const { GITLAB_OAUTH_REDIRECT_URI: _, ...partial } = full;
    try {
      load(partial);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).keys).toEqual(["GITLAB_OAUTH_REDIRECT_URI"]);
      expect((e as ConfigError).message).not.toContain(SECRET);
    }
  });

  test("a bad URL is refused by key, without echoing it", () => {
    try {
      load({ ...full, GITLAB_URL: "not a url" });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).keys).toEqual(["GITLAB_URL"]);
      expect((e as ConfigError).message).not.toContain("not a url");
    }
  });

  test("merges with the rest of the API's settings", () => {
    const base = z.object({ PORT: z.coerce.number().default(3000) });
    expect(loadConfig(base.and(authEnv), { PORT: "8080", ...full })).toMatchObject({
      PORT: 8080,
      GITLAB_URL: full.GITLAB_URL,
    });
  });
});
