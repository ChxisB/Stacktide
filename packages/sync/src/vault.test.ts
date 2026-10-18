import { describe, expect, test } from "bun:test";
import type { Fetch } from "./http";
import { checkVaultAppRole, vaultConfigSchema, vaultSecretIdSchema } from "./vault";

const SECRET_ID = "secret-id-CANARY-0123456789";
const CLIENT_TOKEN = "hvs.client-token-CANARY-0123456789";
const config = {
  address: "https://vault.example.test:8200",
  roleId: "role-id-1234",
  authMount: "approle",
  kvMount: "kv",
  prefix: "app/prod",
};
const DATA = "kv/data/app/prod/orch-check";
const META = "kv/metadata/app/prod/";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Vault as far as the check uses it: AppRole login, capabilities-self and revoke-self. */
function fakeVault(
  opts: {
    caps?: Record<string, string[]>;
    login?: { status: number; body?: string };
    revoke?: number;
  } = {},
) {
  const seen: Seen[] = [];
  const revoked: string[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body ? JSON.parse(String(init.body)) : {};
    seen.push({ url, headers, body });
    const path = new URL(url).pathname;
    if (path === "/v1/auth/approle/login") {
      if (opts.login) {
        return new Response(opts.login.body ?? `{"errors":["leak ${SECRET_ID}"]}`, {
          status: opts.login.status,
        });
      }
      if (body.role_id !== config.roleId || body.secret_id !== SECRET_ID) {
        return Response.json({ errors: ["invalid role or secret ID"] }, { status: 400 });
      }
      return Response.json({ auth: { client_token: CLIENT_TOKEN, policies: ["default", "app"] } });
    }
    if (headers["x-vault-token"] !== CLIENT_TOKEN) {
      return Response.json({ errors: ["permission denied"] }, { status: 403 });
    }
    if (path === "/v1/sys/capabilities-self") {
      const table = opts.caps ?? {
        [DATA]: ["create", "read", "update"],
        [META]: ["create", "update", "list"],
      };
      const paths = body.paths as string[];
      const data = Object.fromEntries(paths.map((p) => [p, table[p] ?? ["deny"]]));
      return Response.json({ ...data, data });
    }
    if (path === "/v1/auth/token/revoke-self") {
      revoked.push(headers["x-vault-token"] ?? "");
      return new Response(null, { status: opts.revoke ?? 204 });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetch, seen, revoked };
}

describe("checkVaultAppRole", () => {
  test("logs in, asks what the token may do under the prefix, and lets the token go", async () => {
    const v = fakeVault();
    const r = await checkVaultAppRole(config, SECRET_ID, { fetch: v.fetch });
    expect(r).toEqual({
      ok: true,
      summary: "The AppRole may read and write secrets under kv/app/prod",
    });
    expect(v.seen.map((s) => new URL(s.url).pathname)).toEqual([
      "/v1/auth/approle/login",
      "/v1/sys/capabilities-self",
      "/v1/auth/token/revoke-self",
    ]);
    expect(v.seen[0]?.body).toEqual({ role_id: config.roleId, secret_id: SECRET_ID });
    expect(v.seen[1]?.body).toEqual({ paths: [DATA, META] });
    expect(v.revoked).toEqual([CLIENT_TOKEN]);
    const text = JSON.stringify(r);
    expect(text).not.toContain(SECRET_ID);
    expect(text).not.toContain(CLIENT_TOKEN);
  });

  test("an AppRole that may do less than it must is `forbidden`, with what it lacks", async () => {
    const v = fakeVault({ caps: { [DATA]: ["read"], [META]: [] } });
    const r = await checkVaultAppRole(config, SECRET_ID, { fetch: v.fetch });
    expect(r).toMatchObject({ ok: false, reason: "forbidden" });
    expect(r).toMatchObject({
      message: expect.stringContaining(
        "create, update on kv/data/app/prod/*; create, update, list on kv/metadata/app/prod/*",
      ),
    });
    expect(v.revoked).toEqual([CLIENT_TOKEN]);
  });

  test("`root` may do everything and `deny` nothing", async () => {
    const root = fakeVault({ caps: { [DATA]: ["root"], [META]: ["root"] } });
    expect(await checkVaultAppRole(config, SECRET_ID, { fetch: root.fetch })).toMatchObject({
      ok: true,
    });
    // `deny` beats every other capability on the path
    const deny = fakeVault({
      caps: { [DATA]: ["create", "read", "update", "deny"], [META]: ["create", "update", "list"] },
    });
    expect(await checkVaultAppRole(config, SECRET_ID, { fetch: deny.fetch })).toMatchObject({
      ok: false,
      reason: "forbidden",
      message: expect.stringContaining("create, read, update on kv/data/app/prod/*"),
    });
  });

  test("a wrong role or secret ID is `unauthorized` in fixed words", async () => {
    const r = await checkVaultAppRole(config, "another-secret-id-0000", {
      fetch: fakeVault().fetch,
    });
    expect(r).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(r).toMatchObject({ message: expect.stringContaining("role ID or secret ID") });
  });

  test("each other login failure is an answer, never Vault's text", async () => {
    for (const [status, reason] of [
      [403, "forbidden"],
      [404, "not_found"],
      [429, "rate_limited"],
      [503, "server"],
    ] as const) {
      const v = fakeVault({ login: { status } });
      const r = await checkVaultAppRole(config, SECRET_ID, { fetch: v.fetch });
      expect([status, r]).toMatchObject([status, { ok: false, reason }]);
      expect(JSON.stringify(r)).not.toContain("CANARY");
      expect(JSON.stringify(r)).not.toContain("vault.example.test");
      expect(v.revoked).toEqual([]);
    }
  });

  test("a login that answers without a token is not believed", async () => {
    const v = fakeVault({ login: { status: 200, body: `{"auth":{}}` } });
    expect(await checkVaultAppRole(config, SECRET_ID, { fetch: v.fetch })).toMatchObject({
      ok: false,
      reason: "unexpected",
    });
    const junk = fakeVault({ login: { status: 200, body: "<html>" } });
    expect(await checkVaultAppRole(config, SECRET_ID, { fetch: junk.fetch })).toMatchObject({
      ok: false,
      reason: "unexpected",
    });
  });

  test("a failed revoke changes nothing", async () => {
    const v = fakeVault({ revoke: 500 });
    expect(await checkVaultAppRole(config, SECRET_ID, { fetch: v.fetch })).toMatchObject({
      ok: true,
    });
  });

  test("the token is let go when the check itself fails", async () => {
    const base = fakeVault();
    const broken: Fetch = async (url, init) => {
      if (url.endsWith("/capabilities-self")) throw new Error(`boom ${CLIENT_TOKEN}`);
      return base.fetch(url, init);
    };
    const r = await checkVaultAppRole(config, SECRET_ID, { fetch: broken });
    expect(r).toMatchObject({ ok: false, reason: "network" });
    expect(JSON.stringify(r)).not.toContain("CANARY");
    expect(base.revoked).toEqual([CLIENT_TOKEN]);
  });

  test("an answer that names no capabilities for the paths is `unexpected`", async () => {
    const f: Fetch = async (url) =>
      url.endsWith("/login")
        ? Response.json({ auth: { client_token: CLIENT_TOKEN } })
        : Response.json({ nothing: true });
    expect(await checkVaultAppRole(config, SECRET_ID, { fetch: f })).toMatchObject({
      ok: false,
      reason: "unexpected",
    });
  });

  test("a different auth mount and KV mount are used as given", async () => {
    const v = fakeVault({
      caps: {
        "secrets/data/team/orch-check": ["create", "read", "update"],
        "secrets/metadata/team/": ["create", "update", "list"],
      },
    });
    const f: Fetch = (url, init) =>
      v.fetch(url.replace("/auth/ci-approle/", "/auth/approle/"), init);
    const r = await checkVaultAppRole(
      { ...config, authMount: "ci-approle", kvMount: "secrets", prefix: "team" },
      SECRET_ID,
      { fetch: f },
    );
    expect(r).toMatchObject({ ok: true });
    expect(v.seen[0]?.url).toBe("https://vault.example.test:8200/v1/auth/approle/login");
  });
});

describe("what a connection is allowed to say", () => {
  test("an https address, a role ID and the mounts and prefix the role is scoped to", () => {
    expect(vaultConfigSchema.parse(config)).toEqual(config);
    expect(
      vaultConfigSchema.parse({
        address: "https://vault.example.test/",
        roleId: "r",
        kvMount: "kv",
        prefix: "a",
      }),
    ).toEqual({
      address: "https://vault.example.test",
      roleId: "r",
      authMount: "approle",
      kvMount: "kv",
      prefix: "a",
    });
    const bad = [
      { ...config, address: "http://vault.example.test" },
      { ...config, address: "https://u:p@vault.example.test" },
      { ...config, address: "https://vault.example.test/v1" },
      { ...config, roleId: "" },
      { ...config, roleId: "has space" },
      { ...config, kvMount: "KV" },
      { ...config, kvMount: "kv/../sys" },
      { ...config, authMount: "../x" },
      { ...config, prefix: "" },
      { ...config, prefix: "/app" },
      { ...config, prefix: "app/" },
      { ...config, prefix: "app//prod" },
      { ...config, prefix: "app/../other" },
      { ...config, prefix: "app/./prod" },
      { ...config, prefix: "app/*" },
      { ...config, prefix: "a/b/c/d/e/f/g/h/i" },
      { ...config, secretId: SECRET_ID },
      { address: config.address },
    ];
    for (const b of bad) {
      expect([b, vaultConfigSchema.safeParse(b).success]).toEqual([b, false]);
    }
  });

  test("a secret ID is one printable word", () => {
    expect(vaultSecretIdSchema.safeParse(SECRET_ID).success).toBe(true);
    for (const bad of ["", "short", "has space in it 0123456789", "x".repeat(257)]) {
      expect(vaultSecretIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});
