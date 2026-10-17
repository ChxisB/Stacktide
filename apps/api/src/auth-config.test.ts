import { describe, expect, test } from "bun:test";
import { ConfigError, createLogger, loadConfig } from "@orch/core";
import { createOrganization, upsertUser } from "@orch/db";
import { createTestDb } from "@orch/db/testing";
import { createMockGitlab } from "@orch/gitlab/mock";
import { z } from "zod";
import { accessEnv, authEnv, authFromEnv, ciFromEnv, rolesFromEnv } from "./auth-config";

const SECRET = "client-secret-CANARY-8812";
const full = {
  GITLAB_URL: "https://gitlab.example.com",
  GITLAB_OAUTH_CLIENT_ID: "app-id",
  GITLAB_OAUTH_CLIENT_SECRET: SECRET,
  GITLAB_OAUTH_REDIRECT_URI: "https://orch.example.com/auth/callback",
};
const load = (env: Record<string, string>) => authFromEnv(loadConfig(authEnv, env));

describe("CI exchange config", () => {
  const ci = (env: Record<string, string>) => ciFromEnv(loadConfig(authEnv, env));

  test("without an audience the exchange is off", () => {
    expect(ci({})).toBeUndefined();
    expect(ci(full)).toBeUndefined();
  });

  test("the audience needs the GitLab settings it is checked against", () => {
    try {
      ci({ ORCH_CI_AUDIENCE: "orch.example.com" });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).keys).toEqual(["GITLAB_URL"]);
    }
    expect(() => ci({ ORCH_CI_AUDIENCE: "" })).toThrow(ConfigError);
  });

  test("the issuer is the instance URL without a trailing slash", () => {
    const env = { ...full, ORCH_CI_AUDIENCE: "orch.example.com" };
    expect(ci(env)).toMatchObject({
      issuer: "https://gitlab.example.com",
      audience: "orch.example.com",
    });
    expect(ci({ ...env, GITLAB_URL: "https://gitlab.example.com/gl/" })?.issuer).toBe(
      "https://gitlab.example.com/gl",
    );
  });
});

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

describe("access config", () => {
  const access = (env: Record<string, string>) => loadConfig(accessEnv, env);

  test("nothing set: no dev auth, no platform admins", () => {
    expect(access({})).toEqual({});
  });

  test("dev auth is the exact value 1; anything else is refused by key", () => {
    expect(access({ ORCH_DEV_AUTH: "1" }).ORCH_DEV_AUTH).toBe("1");
    for (const v of ["0", "true", "yes", ""]) {
      expect(() => access({ ORCH_DEV_AUTH: v })).toThrow(ConfigError);
    }
  });

  test("platform admins are a comma separated list of ids", () => {
    expect(access({ ORCH_PLATFORM_ADMIN_GITLAB_IDS: "12" }).ORCH_PLATFORM_ADMIN_GITLAB_IDS).toEqual(
      [12],
    );
    expect(
      access({ ORCH_PLATFORM_ADMIN_GITLAB_IDS: "12, 34 ,5" }).ORCH_PLATFORM_ADMIN_GITLAB_IDS,
    ).toEqual([12, 34, 5]);
    for (const v of ["12,", ",12", "12,abc", "alice", "-1", "1.5", " ", "9007199254740993"]) {
      expect(() => access({ ORCH_PLATFORM_ADMIN_GITLAB_IDS: v })).toThrow(ConfigError);
    }
    // An exported-but-empty variable means nobody, not a failed start.
    expect(access({ ORCH_PLATFORM_ADMIN_GITLAB_IDS: "" }).ORCH_PLATFORM_ADMIN_GITLAB_IDS).toEqual(
      [],
    );
  });
});

describe("membership token", () => {
  const TOKEN = "membership-token-CANARY-4417";
  const logger = createLogger({ write: () => {} });

  test("without a token, or without a GitLab, there is no role source", async () => {
    const t = await createTestDb();
    try {
      expect(rolesFromEnv(loadConfig(authEnv, {}), t.db, logger)).toBeUndefined();
      expect(rolesFromEnv(loadConfig(authEnv, full), t.db, logger)).toBeUndefined();
    } finally {
      await t.drop();
    }
  });

  test("a token without the sign-in settings is refused by key, without echoing it", () => {
    try {
      loadConfig(authEnv, { GITLAB_MEMBERSHIP_TOKEN: TOKEN });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).keys).toEqual(Object.keys(full));
      expect((e as ConfigError).message).not.toContain(TOKEN);
    }
    expect(loadConfig(authEnv, { ...full, GITLAB_MEMBERSHIP_TOKEN: TOKEN })).toMatchObject({
      GITLAB_MEMBERSHIP_TOKEN: TOKEN,
    });
    expect(() => loadConfig(authEnv, { ...full, GITLAB_MEMBERSHIP_TOKEN: "" })).toThrow(
      ConfigError,
    );
  });

  test("with a token, roles are read from that GitLab with it", async () => {
    const t = await createTestDb();
    const mock = createMockGitlab();
    try {
      const group = mock.addGroup("acme");
      const org = await createOrganization(t.db, {
        slug: "acme",
        name: "A",
        gitlabGroupId: group.id,
      });
      const user = await upsertUser(t.db, { gitlabId: 4242, username: "u", name: "U" });
      mock.addMember({ group: group.id }, user.gitlabId, 50);
      const roles = rolesFromEnv(
        loadConfig(authEnv, { ...full, GITLAB_URL: mock.url, GITLAB_MEMBERSHIP_TOKEN: mock.token }),
        t.db,
        logger,
      );
      expect((await roles?.(user))?.orgRoles).toEqual({ [org.id]: "owner" });
      const wrong = rolesFromEnv(
        loadConfig(authEnv, {
          ...full,
          GITLAB_URL: mock.url,
          GITLAB_MEMBERSHIP_TOKEN: "not-the-token-1234",
        }),
        t.db,
        logger,
      );
      await expect(wrong?.(user)).rejects.toMatchObject({ status: 503 });
    } finally {
      mock.stop();
      await t.drop();
    }
  });
});
