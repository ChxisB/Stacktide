import { describe, expect, test } from "bun:test";
import { runAdapterConformance } from "./conformance";
import { SyncError } from "./errors";
import { type FakeVaultOptions, fakeVault } from "./fake-vault";
import type { Fetch } from "./http";
import { ALL_SCOPES, type ItemInput } from "./types";
import type { VaultConfig } from "./vault";
import {
  ALL_SCOPES_NAME,
  MANAGED_KEY,
  PLAIN_PREFIX,
  parseVaultKvConfig,
  VAULT_KV,
  vaultKvAdapter,
} from "./vault-kv";

const ADDRESS = "https://vault.example.test:8200";
const SECRET_ID = "secret-id-CANARY-0123456789";
const LEAK = "vault-leak-CANARY-4c7d";
const VALUE = "value-CANARY-8e21";
const connection: VaultConfig = {
  address: ADDRESS,
  roleId: "role-id-1234",
  authMount: "approle",
  kvMount: "kv",
  prefix: "app/prod",
};
const target = { path: "web" };
/** The path the target manages, and what its secrets are marked with. */
const BASE = "app/prod/web";
const ALL = `${BASE}/${ALL_SCOPES_NAME}`;

const item = (key: string, value: string, scope = ALL_SCOPES, secret = false): ItemInput => ({
  key,
  scope,
  value,
  secret,
  file: false,
});

interface World {
  vault?: Partial<FakeVaultOptions>;
  wrap?: (inner: Fetch, vault: ReturnType<typeof fakeVault>) => Fetch;
  conn?: VaultConfig;
  cfg?: unknown;
  timeoutMs?: number;
}
/** A Vault with a KV v2 engine, an AppRole whose policy covers the prefix, and an adapter that reaches it the way the platform does. */
function world(w: World = {}) {
  const vault = fakeVault({
    address: ADDRESS,
    roleId: connection.roleId,
    secretId: SECRET_ID,
    prefix: "app/prod",
    leak: LEAK,
    ...w.vault,
  });
  const fetch = w.wrap ? w.wrap(vault.fetch, vault) : vault.fetch;
  const adapter = vaultKvAdapter(w.conn ?? connection, SECRET_ID, {
    fetch,
    timeoutMs: w.timeoutMs,
  });
  return { vault, adapter, remote: adapter.connect(adapter.validate(w.cfg ?? target)) };
}
type Vault = ReturnType<typeof fakeVault>;

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as SyncError;
  }
  throw new Error("expected an error");
};
const sent = (v: Vault) => v.calls.map((c) => `${c.method} ${c.path}`);
/** Runs `hook` once, just before the first request that `match` accepts is answered. */
const before =
  (match: (method: string, path: string) => boolean, hook: (v: Vault) => void) =>
  (inner: Fetch, vault: Vault): Fetch => {
    let done = false;
    return async (url, init) => {
      const path = new URL(url).pathname.slice(4);
      if (!done && match(String(init.method ?? "GET"), path)) {
        done = true;
        hook(vault);
      }
      return inner(url, init);
    };
  };
/** Answers `status` to the first request that `match` accepts, and passes the rest on. */
const failing =
  (match: (method: string, path: string) => boolean, status: number, body = "{}") =>
  (inner: Fetch): Fetch =>
  async (url, init) =>
    match(String(init.method ?? "GET"), new URL(url).pathname.slice(4))
      ? new Response(body, { status })
      : inner(url, init);

runAdapterConformance("vault-kv", async () => ({ adapter: world().adapter, config: target }), {
  refused: [
    { item: item("has space", VALUE), kind: "invalid" },
    { item: item("K", VALUE, "staging/*"), kind: "invalid" },
    { item: item("K", VALUE, ALL_SCOPES_NAME), kind: "invalid" },
    { item: item(".hidden", VALUE), kind: "invalid" },
    { item: item("K".repeat(101), VALUE), kind: "invalid" },
  ],
});

describe("the config", () => {
  test("a path under the prefix of the connection", () => {
    expect(parseVaultKvConfig({ path: "web" })).toEqual({ path: "web" });
    expect(parseVaultKvConfig({ path: "web/api", protected: true })).toEqual({
      path: "web/api",
      protected: true,
    });
    expect(parseVaultKvConfig({ path: "a.b_c-d/E1" })).toEqual({ path: "a.b_c-d/E1" });
  });

  test("anything else is refused, and never repeated", () => {
    const bad = [
      undefined,
      null,
      "web",
      {},
      { path: "" },
      { path: "/web" },
      { path: "web/" },
      { path: "web//api" },
      { path: "../web" },
      { path: "web/../api" },
      { path: "web/./api" },
      { path: ".web" },
      { path: "web/*" },
      { path: "a/b/c/d/e" },
      { path: "x".repeat(65) },
      { path: "web", protected: "yes" },
      { path: "web", token: VALUE },
      { path: "web", kvMount: "other" },
    ];
    for (const b of bad) {
      const w = world();
      const e = (() => {
        try {
          w.adapter.validate(b);
        } catch (err) {
          return err as SyncError;
        }
      })();
      expect([b, e?.kind]).toEqual([b, "invalid_config"]);
      expect(e?.message).not.toContain(VALUE);
    }
  });

  test("a path that makes the marker too long for Vault is refused, one that just fits is not", () => {
    const long: VaultConfig = { ...connection, prefix: Array(8).fill("p".repeat(60)).join("/") };
    const a = vaultKvAdapter(long, SECRET_ID, { fetch: fakeVault(fakeOptions()).fetch });
    const room = 512 - long.prefix.length - 1;
    const fits = { path: "q".repeat(room) };
    expect(a.validate(fits)).toEqual(fits);
    const over = { path: "q".repeat(room + 1) };
    for (const run of [() => a.validate(over), () => a.connect(over)]) {
      expect(run).toThrow(SyncError);
    }
  });

  test("a config that did not go through validate is taken apart again on connect", async () => {
    const w = world();
    for (const bad of [{ path: "../other" }, { path: "web", extra: 1 }, { path: "a b" }]) {
      expect(
        (() => {
          try {
            w.adapter.connect(bad);
          } catch (e) {
            return (e as SyncError).kind;
          }
        })(),
      ).toBe("invalid_config");
    }
    expect(w.vault.calls).toEqual([]);
  });

  test("what the target is", () => {
    const { adapter } = world();
    expect(adapter.type).toBe(VAULT_KV);
    expect(adapter.capabilities).toEqual({
      canReadValues: true,
      supportsMasking: true,
      supportsScopes: true,
      supportsFiles: false,
    });
  });
});

function fakeOptions(): FakeVaultOptions {
  return {
    address: ADDRESS,
    roleId: connection.roleId,
    secretId: SECRET_ID,
    prefix: "app/prod",
  };
}

describe("what is sent", () => {
  test("one call is a login, the work and a revoke, and nothing outlives it", async () => {
    const w = world();
    await w.remote.create(item("API_URL", "https://api.example.test", ALL_SCOPES, false));
    expect(sent(w.vault)).toEqual([
      "POST auth/approle/login",
      `GET kv/data/${ALL}`,
      `POST kv/data/${ALL}`,
      `POST kv/metadata/${ALL}`,
      "POST auth/token/revoke-self",
    ]);
    const [login, get, data, meta, revoke] = w.vault.calls;
    expect(login?.body).toEqual({ role_id: connection.roleId, secret_id: SECRET_ID });
    expect(login?.token).toBeNull();
    expect(data?.body).toEqual({
      options: { cas: 0 },
      data: { API_URL: "https://api.example.test" },
    });
    expect(meta?.body).toEqual({
      custom_metadata: { [MANAGED_KEY]: BASE, [`${PLAIN_PREFIX}API_URL`]: "1" },
    });
    const token = get?.token;
    expect(token).toMatch(/^hvs\./);
    expect([get?.token, data?.token, meta?.token, revoke?.token]).toEqual([
      token,
      token,
      token,
      token,
    ]);
    expect(w.vault.live.size).toBe(0);
    // the secret ID travels in the login body only, the token in a header only
    for (const c of w.vault.calls.slice(1)) {
      expect(c.path + JSON.stringify(c.body ?? "")).not.toContain(SECRET_ID);
    }
    for (const c of w.vault.calls) {
      expect(c.path + JSON.stringify(c.body ?? "")).not.toContain(String(token));
    }
  });

  test("a read lists the path once and reads each secret once", async () => {
    const w = world();
    w.vault.seed(ALL, { A: "1" }, { [MANAGED_KEY]: BASE });
    w.vault.seed(`${BASE}/prod`, { B: "2" }, { [MANAGED_KEY]: BASE });
    await w.remote.read();
    expect(sent(w.vault)).toEqual([
      "POST auth/approle/login",
      `GET kv/metadata/${BASE}/?list=true`,
      `GET kv/data/${BASE}/_`,
      `GET kv/data/${BASE}/prod`,
      "POST auth/token/revoke-self",
    ]);
    expect(w.vault.live.size).toBe(0);
  });

  test("every request stays under the path of the target, and nothing is deleted or destroyed", async () => {
    const w = world();
    await w.remote.create(item("A", "1", ALL_SCOPES, true));
    await w.remote.create(item("B", "2", "production", false));
    await w.remote.update(item("A", "3", ALL_SCOPES, false));
    await w.remote.read();
    await w.remote.delete({ key: "A", scope: ALL_SCOPES });
    for (const c of w.vault.calls) {
      if (c.path.startsWith("auth/")) continue;
      expect(c.path).toMatch(/^kv\/(data|metadata)\/app\/prod\/web\//);
      expect(["GET", "POST"]).toContain(c.method);
    }
    expect(w.vault.calls.some((c) => c.path.includes("destroy") || c.path.includes("delete"))).toBe(
      false,
    );
  });

  test("a different auth mount, KV mount and prefix are used as given", async () => {
    const conn: VaultConfig = {
      ...connection,
      authMount: "ci-approle",
      kvMount: "secrets",
      prefix: "team",
    };
    const w = world({
      vault: { authMount: "ci-approle", kvMount: "secrets", prefix: "team" },
      conn,
    });
    await w.remote.create(item("A", "1"));
    expect(sent(w.vault)).toEqual([
      "POST auth/ci-approle/login",
      "GET secrets/data/team/web/_",
      "POST secrets/data/team/web/_",
      "POST secrets/metadata/team/web/_",
      "POST auth/token/revoke-self",
    ]);
  });

  test("redirects are not followed", async () => {
    const seen: (string | undefined)[] = [];
    const w = world({
      wrap: (inner) => async (url, init) => {
        seen.push(init.redirect);
        return inner(url, init);
      },
    });
    await w.remote.read();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["manual"]));
    const redirecting = world({
      wrap: (inner) => async (url, init) =>
        new URL(url).pathname.includes("/data/")
          ? new Response(null, {
              status: 307,
              headers: { location: "https://evil.example.test/x" },
            })
          : inner(url, init),
    });
    redirecting.vault.seed(ALL, { A: "1" }, { [MANAGED_KEY]: BASE });
    const e = await errorOf(redirecting.remote.read());
    expect(e.kind).toBe("failed");
    expect(e.message).not.toContain("evil.example.test");
  });

  test("an item is laid out as a field of the secret of its scope", async () => {
    const w = world();
    await w.remote.create(item("ALL_ENVS", "a", ALL_SCOPES, true));
    await w.remote.create(item("PROD_ONLY", "b", "production", false));
    await w.remote.create(item("OTHER", "c", "review.1", true));
    expect(w.vault.data(ALL)).toEqual({ ALL_ENVS: "a" });
    expect(w.vault.data(`${BASE}/production`)).toEqual({ PROD_ONLY: "b" });
    expect(w.vault.data(`${BASE}/review.1`)).toEqual({ OTHER: "c" });
    expect(w.vault.custom(ALL)).toEqual({ [MANAGED_KEY]: BASE });
    expect(w.vault.custom(`${BASE}/production`)).toEqual({
      [MANAGED_KEY]: BASE,
      [`${PLAIN_PREFIX}PROD_ONLY`]: "1",
    });
    expect(await w.remote.read()).toEqual([
      { key: "ALL_ENVS", scope: ALL_SCOPES, value: "a", secret: true, file: false },
      { key: "OTHER", scope: "review.1", value: "c", secret: true, file: false },
      { key: "PROD_ONLY", scope: "production", value: "b", secret: false, file: false },
    ]);
  });
});

describe("a secret this platform did not make", () => {
  test("is never listed, written, emptied or marked", async () => {
    const w = world();
    w.vault.seed(ALL, { THEIRS: "by hand" });
    w.vault.seed(`${BASE}/prod`, { OTHER: "x" }, { [MANAGED_KEY]: "app/prod/another" });
    w.vault.seed(`${BASE}/dev`, { OTHER: "x" }, { team: "payments" });
    expect(await w.remote.read()).toEqual([]);
    for (const scope of [ALL_SCOPES, "prod", "dev"]) {
      const e = await errorOf(w.remote.create(item("NEW", VALUE, scope)));
      expect(e.kind).toBe("exists");
      expect(e.message).toContain(`${MANAGED_KEY}=${BASE}`);
      expect(e.message).not.toContain(VALUE);
      expect((await errorOf(w.remote.update(item("THEIRS", VALUE, scope)))).kind).toBe("not_found");
      expect((await errorOf(w.remote.delete({ key: "THEIRS", scope }))).kind).toBe("not_found");
    }
    expect(w.vault.data(ALL)).toEqual({ THEIRS: "by hand" });
    expect(w.vault.custom(ALL)).toBeNull();
    expect(w.vault.custom(`${BASE}/dev`)).toEqual({ team: "payments" });
    expect(w.vault.calls.filter((c) => c.method === "POST" && c.path.startsWith("kv/"))).toEqual(
      [],
    );
  });

  test("becomes managed when its custom metadata says so", async () => {
    const w = world();
    w.vault.seed(ALL, { THEIRS: "by hand" });
    expect((await errorOf(w.remote.create(item("NEW", VALUE)))).kind).toBe("exists");
    w.vault.seed(ALL, { THEIRS: "by hand" }, { [MANAGED_KEY]: BASE });
    await w.remote.create(item("NEW", VALUE));
    expect(w.vault.data(ALL)).toEqual({ THEIRS: "by hand", NEW: VALUE });
  });

  test("a path that only has metadata holds nothing yet, so a create makes the secret", async () => {
    const w = world();
    w.vault.seedMetadataOnly(ALL, { team: "payments" });
    expect(await w.remote.read()).toEqual([]);
    await w.remote.create(item("A", "1", ALL_SCOPES, true));
    expect(w.vault.data(ALL)).toEqual({ A: "1" });
    expect(w.vault.custom(ALL)).toEqual({ [MANAGED_KEY]: BASE });
  });

  test("a version that was deleted or destroyed is gone, and the marker on it still counts", async () => {
    for (const how of ["delete", "destroy"] as const) {
      const w = world();
      w.vault.seed(ALL, { OLD: "x" }, { [MANAGED_KEY]: BASE });
      w.vault.remove(ALL, how);
      expect(await w.remote.read()).toEqual([]);
      expect((await errorOf(w.remote.update(item("OLD", VALUE)))).kind).toBe("not_found");
      await w.remote.create(item("NEW", "1", ALL_SCOPES, true));
      expect(w.vault.data(ALL)).toEqual({ NEW: "1" });
      expect(w.vault.secrets.get(ALL)?.versions.length).toBe(2);
      expect(await w.remote.read()).toMatchObject([{ key: "NEW", value: "1" }]);

      const theirs = world();
      theirs.vault.seed(ALL, { OLD: "x" });
      theirs.vault.remove(ALL, how);
      expect((await errorOf(theirs.remote.create(item("NEW", VALUE)))).kind).toBe("exists");
      expect(theirs.vault.data(ALL)).toBeUndefined();
    }
  });

  test("a secret made between the read and the create is looked at again", async () => {
    // by someone else: it stays theirs
    const theirs = world({
      wrap: before(
        (m, p) => m === "POST" && p === `kv/data/${ALL}`,
        (v) => v.seed(ALL, { THEIRS: "x" }),
      ),
    });
    const e = await errorOf(theirs.remote.create(item("NEW", VALUE)));
    expect(e.kind).toBe("exists");
    expect(theirs.vault.data(ALL)).toEqual({ THEIRS: "x" });
    expect(theirs.vault.custom(ALL)).toBeNull();

    // by another run of this platform: it is ours, and the key goes in beside theirs
    const ours = world({
      wrap: before(
        (m, p) => m === "POST" && p === `kv/data/${ALL}`,
        (v) => v.seed(ALL, { EARLIER: "x" }, { [MANAGED_KEY]: BASE }),
      ),
    });
    await ours.remote.create(item("NEW", VALUE));
    expect(ours.vault.data(ALL)).toEqual({ EARLIER: "x", NEW: VALUE });
  });

  test("a create that wrote the data but could not mark it says how to finish", async () => {
    const w = world({
      wrap: failing((m, p) => m === "POST" && p === `kv/metadata/${ALL}`, 500),
    });
    const e = await errorOf(w.remote.create(item("NEW", VALUE)));
    expect(e.kind).toBe("failed");
    expect(e.message).toContain(`${MANAGED_KEY}=${BASE}`);
    expect(e.message).toContain(`kv/data/${ALL}`);
    expect(e.message).not.toContain(VALUE);
    expect(w.vault.live.size).toBe(0);
    // it is now a secret that is not ours: it is not listed, and it is not taken over
    const again = world();
    again.vault.seed(ALL, { NEW: VALUE });
    expect(await again.remote.read()).toEqual([]);
    expect((await errorOf(again.remote.create(item("NEW", VALUE)))).kind).toBe("exists");
  });
});

describe("fields that are not ours in a secret that is", () => {
  test("stay as they are, are listed as secrets, and are left to the unmanaged policy", async () => {
    const w = world();
    w.vault.seed(ALL, { MINE: "1", THEIRS: "by hand" }, { [MANAGED_KEY]: BASE, team: "payments" });
    await w.remote.update(item("MINE", "2", ALL_SCOPES, false));
    expect(w.vault.data(ALL)).toEqual({ MINE: "2", THEIRS: "by hand" });
    // custom metadata that people added stays too
    expect(w.vault.custom(ALL)).toEqual({
      [MANAGED_KEY]: BASE,
      team: "payments",
      [`${PLAIN_PREFIX}MINE`]: "1",
    });
    expect(await w.remote.read()).toEqual([
      { key: "MINE", scope: ALL_SCOPES, value: "2", secret: false, file: false },
      { key: "THEIRS", scope: ALL_SCOPES, value: "by hand", secret: true, file: false },
    ]);
    await w.remote.delete({ key: "THEIRS", scope: ALL_SCOPES });
    expect(w.vault.data(ALL)).toEqual({ MINE: "2" });
  });

  test("a field that is not text is not listed, is not replaced, and survives a write", async () => {
    const w = world();
    const odd = { NUM: 5, OBJ: { a: [1, { b: null }] }, NUL: null, LIST: [1, 2] };
    w.vault.seed(ALL, { ...odd, TEXT: "t" }, { [MANAGED_KEY]: BASE });
    expect((await w.remote.read()).map((i) => i.key)).toEqual(["TEXT"]);
    for (const key of Object.keys(odd)) {
      const e = await errorOf(w.remote.create(item(key, VALUE)));
      expect([key, e.kind]).toEqual([key, "exists"]);
      expect(e.message).toContain("does not hold text");
      expect(e.message).not.toContain(VALUE);
      expect((await errorOf(w.remote.update(item(key, VALUE)))).kind).toBe("not_found");
      expect((await errorOf(w.remote.delete({ key, scope: ALL_SCOPES }))).kind).toBe("not_found");
    }
    await w.remote.update(item("TEXT", "u"));
    await w.remote.create(item("MORE", "m"));
    expect(w.vault.data(ALL)).toEqual({ ...odd, TEXT: "u", MORE: "m" });
  });

  test("a field of a name this platform would never write is not listed", async () => {
    const w = world();
    w.vault.seed(
      ALL,
      { "has space": "x", "-lead": "y", "a/b": "z", FINE: "ok" },
      { [MANAGED_KEY]: BASE },
    );
    expect((await w.remote.read()).map((i) => i.key)).toEqual(["FINE"]);
  });

  test("a field called __proto__ is a field like any other", async () => {
    const w = world();
    await w.remote.create(item("__proto__", "p", ALL_SCOPES, true));
    await w.remote.create(item("OTHER", "o", ALL_SCOPES, true));
    expect(Object.keys(w.vault.data(ALL) ?? {}).sort()).toEqual(["OTHER", "__proto__"]);
    expect((await w.remote.read()).map((i) => [i.key, i.value])).toEqual([
      ["OTHER", "o"],
      ["__proto__", "p"],
    ]);
    await w.remote.update(item("__proto__", "q", ALL_SCOPES, true));
    expect(await w.remote.read()).toMatchObject([
      { key: "OTHER" },
      { key: "__proto__", value: "q" },
    ]);
    await w.remote.delete({ key: "__proto__", scope: ALL_SCOPES });
    expect((await w.remote.read()).map((i) => i.key)).toEqual(["OTHER"]);
  });

  test("a folder, an odd name and a secret of another shape beside them are left alone", async () => {
    const w = world();
    w.vault.seed(`${BASE}/prod`, { A: "1" }, { [MANAGED_KEY]: BASE });
    w.vault.seed(`${BASE}/prod/child`, { X: "1" }, { [MANAGED_KEY]: BASE });
    w.vault.seed(`${BASE}/-bad`, { X: "1" }, { [MANAGED_KEY]: BASE });
    w.vault.seed(`${BASE}/has space`, { X: "1" }, { [MANAGED_KEY]: BASE });
    expect((await w.remote.read()).map((i) => `${i.key}@${i.scope}`)).toEqual(["A@prod"]);
  });
});

describe("which fields are not secret", () => {
  test("a field is a secret unless the metadata says it is plain", async () => {
    const w = world();
    w.vault.seed(
      ALL,
      { SECRET: "s", PLAIN: "p", ZERO: "z", STALE: "t" },
      {
        [MANAGED_KEY]: BASE,
        [`${PLAIN_PREFIX}PLAIN`]: "1",
        [`${PLAIN_PREFIX}ZERO`]: "0",
        [`${PLAIN_PREFIX}GONE`]: "1",
        "orch-plainer": "1",
      },
    );
    expect((await w.remote.read()).map((i) => [i.key, i.secret])).toEqual([
      ["PLAIN", false],
      ["SECRET", true],
      ["STALE", true],
      ["ZERO", true],
    ]);
  });

  test("the flag moves with the value, and only when it changes", async () => {
    const w = world();
    await w.remote.create(item("K", "1", ALL_SCOPES, true));
    expect(w.vault.custom(ALL)).toEqual({ [MANAGED_KEY]: BASE });
    await w.remote.update(item("K", "2", ALL_SCOPES, false));
    expect(w.vault.custom(ALL)).toEqual({ [MANAGED_KEY]: BASE, [`${PLAIN_PREFIX}K`]: "1" });
    const writes = () =>
      w.vault.calls.filter((c) => c.method === "POST" && c.path.startsWith("kv/metadata")).length;
    const before = writes();
    await w.remote.update(item("K", "3", ALL_SCOPES, false));
    expect(writes()).toBe(before);
    await w.remote.update(item("K", "4", ALL_SCOPES, true));
    expect(w.vault.custom(ALL)).toEqual({ [MANAGED_KEY]: BASE });
    expect(await w.remote.read()).toMatchObject([{ key: "K", value: "4", secret: true }]);
  });

  test("a flag that comes goes in after the value, one that goes is taken away before it", async () => {
    const order = (v: Vault) =>
      v.calls
        .filter((c) => c.method === "POST" && c.path.startsWith("kv/"))
        .map((c) => c.path.split("/")[1]);
    const toPlain = world();
    toPlain.vault.seed(ALL, { K: "1" }, { [MANAGED_KEY]: BASE });
    await toPlain.remote.update(item("K", "2", ALL_SCOPES, false));
    expect(order(toPlain.vault)).toEqual(["data", "metadata"]);

    const toSecret = world();
    toSecret.vault.seed(ALL, { K: "1" }, { [MANAGED_KEY]: BASE, [`${PLAIN_PREFIX}K`]: "1" });
    await toSecret.remote.update(item("K", "2", ALL_SCOPES, true));
    expect(order(toSecret.vault)).toEqual(["metadata", "data"]);

    const gone = world();
    gone.vault.seed(ALL, { K: "1" }, { [MANAGED_KEY]: BASE, [`${PLAIN_PREFIX}K`]: "1" });
    await gone.remote.delete({ key: "K", scope: ALL_SCOPES });
    expect(order(gone.vault)).toEqual(["metadata", "data"]);
  });

  test("a write that stops between the two leaves the field flagged as a secret", async () => {
    const toPlain = world({
      wrap: failing((m, p) => m === "POST" && p === `kv/metadata/${ALL}`, 500),
    });
    toPlain.vault.seed(ALL, { K: "1" }, { [MANAGED_KEY]: BASE });
    expect((await errorOf(toPlain.remote.update(item("K", "2", ALL_SCOPES, false)))).kind).toBe(
      "failed",
    );
    expect(await toPlain.remote.read()).toMatchObject([{ key: "K", value: "2", secret: true }]);

    const toSecret = world({
      wrap: failing((m, p) => m === "POST" && p === `kv/data/${ALL}`, 500),
    });
    toSecret.vault.seed(ALL, { K: "1" }, { [MANAGED_KEY]: BASE, [`${PLAIN_PREFIX}K`]: "1" });
    expect((await errorOf(toSecret.remote.update(item("K", "2", ALL_SCOPES, true)))).kind).toBe(
      "failed",
    );
    expect(await toSecret.remote.read()).toMatchObject([{ key: "K", value: "1", secret: true }]);
  });

  test("a flag left behind by a field that went by hand is dropped at the next flag change, and is not counted", async () => {
    const w = world();
    const stale = Object.fromEntries(
      Array.from({ length: 48 }, (_, i) => [`${PLAIN_PREFIX}GONE${i}`, "1"]),
    );
    w.vault.seed(ALL, { A: "1" }, { [MANAGED_KEY]: BASE, [`${PLAIN_PREFIX}A`]: "1", ...stale });
    // a plain key would be the 50th: it is only the 2nd, since the 48 point at nothing
    await w.remote.create(item("B", "2", ALL_SCOPES, false));
    expect(w.vault.custom(ALL)).toEqual({
      [MANAGED_KEY]: BASE,
      [`${PLAIN_PREFIX}A`]: "1",
      [`${PLAIN_PREFIX}B`]: "1",
    });
    expect(await w.remote.read()).toMatchObject([
      { key: "A", secret: false },
      { key: "B", secret: false },
    ]);
  });

  test("entries that people added under the flag prefix are not flags and stay", async () => {
    const w = world();
    w.vault.seed(
      ALL,
      { A: "1" },
      {
        [MANAGED_KEY]: BASE,
        [`${PLAIN_PREFIX}NOTE`]: "docs",
        [`${PLAIN_PREFIX}ZERO`]: "0",
        [`${PLAIN_PREFIX}A`]: "1",
      },
    );
    await w.remote.update(item("A", "2", ALL_SCOPES, true));
    expect(w.vault.custom(ALL)).toEqual({
      [MANAGED_KEY]: BASE,
      [`${PLAIN_PREFIX}NOTE`]: "docs",
      [`${PLAIN_PREFIX}ZERO`]: "0",
    });
  });

  test("a delete takes the flag with the field", async () => {
    const w = world();
    await w.remote.create(item("A", "1", ALL_SCOPES, false));
    await w.remote.create(item("B", "2", ALL_SCOPES, false));
    await w.remote.delete({ key: "A", scope: ALL_SCOPES });
    expect(w.vault.custom(ALL)).toEqual({ [MANAGED_KEY]: BASE, [`${PLAIN_PREFIX}B`]: "1" });
    // a field made again as a secret is not mistaken for the plain one that was
    await w.remote.create(item("A", "3", ALL_SCOPES, true));
    expect(await w.remote.read()).toMatchObject([
      { key: "A", secret: true },
      { key: "B", secret: false },
    ]);
  });
});

describe("keys, scopes and sizes", () => {
  test("a key and a scope are names, and `_` is the scope `*`", async () => {
    const w = world();
    for (const [key, scope] of [
      ["a", "*"],
      ["A_1.b-c", "production"],
      ["x".repeat(100), "y".repeat(100)],
      ["_LEAD", "_lead"],
      ["9", "v1.2"],
    ] as const) {
      w.adapter.check(item(key, "v", scope));
    }
    for (const [key, scope] of [
      ["has space", "*"],
      ["K", "has space"],
      ["K", "a/b"],
      ["K", "staging/*"],
      ["K", "_"],
      ["K", ".."],
      ["K", "."],
      ["K", "-x"],
      ["-K", "*"],
      ["K.", "*"] as const,
      ["x".repeat(101), "*"],
      ["K", "y".repeat(101)],
      ["é", "*"],
      ["K*", "*"],
    ] as const) {
      const e = (() => {
        try {
          w.adapter.check(item(key, "v", scope));
        } catch (err) {
          return err as SyncError;
        }
      })();
      // "K." and "." in the middle are fine: the rule is on the first character
      if (key === "K.") expect(e).toBeUndefined();
      else expect([key, scope, e?.kind]).toEqual([key, scope, "invalid"]);
    }
  });

  test("a delete of what cannot be named is not there, and asks nothing", async () => {
    const w = world();
    for (const ref of [
      { key: "has space", scope: ALL_SCOPES },
      { key: "K", scope: "a/b" },
      { key: "K", scope: ALL_SCOPES_NAME },
      { key: "K", scope: ".." },
    ]) {
      expect((await errorOf(w.remote.delete(ref))).kind).toBe("not_found");
    }
    expect(w.vault.calls).toEqual([]);
  });

  test("an empty scope is invalid for every call, and asks nothing", async () => {
    const w = world();
    for (const run of [
      () => w.remote.create(item("K", VALUE, "")),
      () => w.remote.update(item("K", VALUE, "")),
      () => w.remote.delete({ key: "K", scope: "" }),
    ]) {
      expect((await errorOf(run())).kind).toBe("invalid");
    }
    expect(w.vault.calls).toEqual([]);
  });

  test("a secret's data is held to 256 KiB as Vault will store it, to the byte", async () => {
    // {"A":"…"} is 8 bytes more than the value
    const exact = 256 * 1024 - 8;
    const fits = world();
    await fits.remote.create(item("A", "x".repeat(exact)));
    expect(Object.values(fits.vault.data(ALL) ?? {})).toEqual(["x".repeat(exact)]);
    const over = world();
    expect((await errorOf(over.remote.create(item("A", "x".repeat(exact + 1))))).kind).toBe(
      "invalid",
    );
    expect(over.vault.data(ALL)).toBeUndefined();
  });

  test("a value goes up to 256 KiB, in one secret or all of them", async () => {
    const w = world();
    const big = "x".repeat(256 * 1024);
    w.adapter.check(item("BIG", big));
    const e = await errorOf(w.remote.create(item("BIG", `${big}y`)));
    expect(e.kind).toBe("invalid");
    expect(e.message).not.toContain("xxxx");
    expect(w.vault.calls).toEqual([]);

    await w.remote.create(item("A", "x".repeat(200 * 1024)));
    const over = await errorOf(w.remote.create(item("B", "x".repeat(100 * 1024))));
    expect(over.kind).toBe("invalid");
    expect(over.message).toContain("262144");
    expect(w.vault.data(ALL)).toEqual({ A: "x".repeat(200 * 1024) });
    // another scope has a secret of its own
    await w.remote.create(item("B", "x".repeat(100 * 1024), "production"));
  });

  test("a secret holds 48 plain keys, and as many secrets as fit", async () => {
    const w = world();
    for (let i = 0; i < 48; i++) await w.remote.create(item(`P${i}`, "1", ALL_SCOPES, false));
    const e = await errorOf(w.remote.create(item("P48", VALUE, ALL_SCOPES, false)));
    expect(e.kind).toBe("invalid");
    expect(e.message).toContain("48");
    expect(w.vault.data(ALL)).not.toHaveProperty("P48");
    // a secret needs no flag, and a plain key that becomes one frees its place
    for (let i = 0; i < 20; i++) await w.remote.create(item(`S${i}`, "1", ALL_SCOPES, true));
    await w.remote.update(item("P0", "1", ALL_SCOPES, true));
    await w.remote.create(item("P48", "1", ALL_SCOPES, false));
    expect(Object.keys(w.vault.custom(ALL) ?? {})).toHaveLength(49);
  });

  test("custom metadata that people added counts against Vault's 64", async () => {
    const w = world();
    const many = Object.fromEntries(Array.from({ length: 63 }, (_, i) => [`note${i}`, "x"]));
    w.vault.seed(ALL, { A: "1" }, { [MANAGED_KEY]: BASE, ...many });
    const e = await errorOf(w.remote.update(item("A", "2", ALL_SCOPES, false)));
    expect(e.kind).toBe("invalid");
    expect(w.vault.data(ALL)).toEqual({ A: "1" });
  });

  test("more than 200 secrets under the path is not a path to manage", async () => {
    const w = world();
    for (let i = 0; i < 201; i++)
      w.vault.seed(`${BASE}/s${i}`, { A: "1" }, { [MANAGED_KEY]: BASE });
    const e = await errorOf(w.remote.read());
    expect(e.kind).toBe("failed");
    expect(e.message).toContain("200");
  });
});

describe("a delete", () => {
  test("writes a new version without the field, and keeps the secret", async () => {
    const w = world();
    await w.remote.create(item("A", "1", ALL_SCOPES, true));
    await w.remote.create(item("B", "2", ALL_SCOPES, true));
    await w.remote.delete({ key: "A", scope: ALL_SCOPES });
    expect(w.vault.data(ALL)).toEqual({ B: "2" });
    await w.remote.delete({ key: "B", scope: ALL_SCOPES });
    expect(w.vault.data(ALL)).toEqual({});
    expect(w.vault.custom(ALL)).toEqual({ [MANAGED_KEY]: BASE });
    expect(await w.remote.read()).toEqual([]);
    // the earlier versions are Vault's to keep: nothing here deletes or destroys one
    expect(w.vault.secrets.get(ALL)?.versions.map((v) => v.deleted || v.destroyed)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // and the field can be made again
    await w.remote.create(item("A", "9", ALL_SCOPES, true));
    expect(w.vault.data(ALL)).toEqual({ A: "9" });
  });

  test("of a field that is not there, or of a secret that is not there, is not_found", async () => {
    const w = world();
    expect((await errorOf(w.remote.delete({ key: "A", scope: ALL_SCOPES }))).kind).toBe(
      "not_found",
    );
    w.vault.seed(ALL, { B: "1" }, { [MANAGED_KEY]: BASE });
    expect((await errorOf(w.remote.delete({ key: "A", scope: ALL_SCOPES }))).kind).toBe(
      "not_found",
    );
    expect(w.vault.live.size).toBe(0);
  });
});

describe("a write that races another", () => {
  test("is refused by Vault, and says to try again", async () => {
    for (const mode of ["update", "delete"] as const) {
      const w = world({
        wrap: before(
          (m, p) => m === "POST" && p === `kv/data/${ALL}`,
          (v) => v.seed(ALL, { A: "1", THEIRS: "new" }, { [MANAGED_KEY]: BASE }),
        ),
      });
      w.vault.seed(ALL, { A: "1" }, { [MANAGED_KEY]: BASE });
      const e = await errorOf(
        mode === "update"
          ? w.remote.update(item("A", VALUE))
          : w.remote.delete({ key: "A", scope: ALL_SCOPES }),
      );
      expect([mode, e.kind]).toEqual([mode, "failed"]);
      expect(e.message).toContain("try again");
      expect(e.message).not.toContain(VALUE);
      expect(e.message).not.toContain(LEAK);
      // what the other writer put there is still there
      expect(w.vault.data(ALL)).toEqual({ A: "1", THEIRS: "new" });
      expect(w.vault.live.size).toBe(0);
    }
  });

  test("a retry after it sees what the other writer wrote", async () => {
    const w = world({
      wrap: before(
        (m, p) => m === "POST" && p === `kv/data/${ALL}`,
        (v) => v.seed(ALL, { A: "1", THEIRS: "new" }, { [MANAGED_KEY]: BASE }),
      ),
    });
    w.vault.seed(ALL, { A: "1" }, { [MANAGED_KEY]: BASE });
    await errorOf(w.remote.update(item("A", "2")));
    await w.remote.update(item("A", "2"));
    expect(w.vault.data(ALL)).toEqual({ A: "2", THEIRS: "new" });
  });

  test("a create that loses the race twice says the secret is there", async () => {
    // the read never sees the secret, so each try is a create at version 0, which Vault refuses
    const w = world({
      wrap: failing((m, p) => m === "GET" && p === `kv/data/${ALL}`, 404, "{}"),
    });
    w.vault.seed(ALL, { THEIRS: "1" }, { [MANAGED_KEY]: BASE });
    const e = await errorOf(w.remote.create(item("A", VALUE)));
    expect(e.kind).toBe("exists");
    expect(
      w.vault.calls.filter((c) => c.method === "POST" && c.path === `kv/data/${ALL}`),
    ).toHaveLength(2);
    expect(w.vault.data(ALL)).toEqual({ THEIRS: "1" });
  });

  test("an answer that is not a 400 is not taken for a check-and-set", async () => {
    const w = world({
      wrap: failing(
        (m, p) => m === "POST" && p === `kv/data/${ALL}`,
        500,
        JSON.stringify({ errors: ["check-and-set parameter did not match"] }),
      ),
    });
    w.vault.seed(ALL, { A: "1" }, { [MANAGED_KEY]: BASE });
    const e = await errorOf(w.remote.update(item("A", VALUE)));
    expect(e.kind).toBe("failed");
    expect(e.message).toContain("(500)");
    expect(e.message).not.toContain("try again");
  });

  test("a 400 that is not a check-and-set is not taken for one", async () => {
    const w = world({
      wrap: failing(
        (m, p) => m === "POST" && p === `kv/data/${ALL}`,
        400,
        JSON.stringify({ errors: [`invalid request ${LEAK}`] }),
      ),
    });
    w.vault.seed(ALL, { A: "1" }, { [MANAGED_KEY]: BASE });
    const e = await errorOf(w.remote.update(item("A", VALUE)));
    expect(e.kind).toBe("failed");
    expect(e.message).toContain("invalid (400)");
    expect(e.message).not.toContain("try again");
    expect(e.message).not.toContain(LEAK);
  });
});

describe("when Vault does not answer as it should", () => {
  const calls: [string, (w: ReturnType<typeof world>) => Promise<unknown>][] = [
    ["read", (w) => w.remote.read()],
    ["create", (w) => w.remote.create(item("K", VALUE))],
    ["update", (w) => w.remote.update(item("K", VALUE))],
    ["delete", (w) => w.remote.delete({ key: "K", scope: ALL_SCOPES })],
  ];

  test("a login that is refused says why in fixed words, and nothing is asked after it", async () => {
    for (const [status, words] of [
      [400, "role ID or secret ID"],
      [403, "refused the AppRole login"],
      [404, "no AppRole auth method"],
      [429, "rate limiting"],
      [503, "server error"],
    ] as const) {
      for (const [name, run] of calls) {
        const w = world({
          wrap: failing(
            (_m, p) => p === "auth/approle/login",
            status,
            `{"errors":["${LEAK} ${SECRET_ID}"]}`,
          ),
        });
        w.vault.seed(ALL, { K: "1" }, { [MANAGED_KEY]: BASE });
        const e = await errorOf(run(w));
        expect([status, name, e.kind]).toEqual([status, name, "failed"]);
        expect(e.message).toContain(words);
        expect(e.message).not.toContain(LEAK);
        expect(e.message).not.toContain(SECRET_ID);
        // the refusal is answered before the fake sees it: nothing else got through to Vault
        expect(w.vault.calls).toEqual([]);
      }
    }
  });

  test("a wrong secret ID is a failed login", async () => {
    const w = world();
    const wrong = vaultKvAdapter(connection, "another-secret-id-0000", { fetch: w.vault.fetch });
    const e = await errorOf(wrong.connect(target).read());
    expect(e.kind).toBe("failed");
    expect(e.message).toContain("role ID or secret ID");
    expect(e.message).not.toContain("another-secret-id-0000");
  });

  test("an answer that is refused is a failure with the status, never Vault's words", async () => {
    for (const status of [403, 500, 503, 429, 418]) {
      for (const [name, run] of calls) {
        const w = world({
          wrap: failing(
            (_m, p) => p.startsWith("kv/"),
            status,
            JSON.stringify({ errors: [`${LEAK} ${SECRET_ID} ${VALUE}`] }),
          ),
        });
        w.vault.seed(ALL, { K: "1" }, { [MANAGED_KEY]: BASE });
        const e = await errorOf(run(w));
        expect([name, e.kind]).toEqual([name, "failed"]);
        expect(e.message).toContain(`(${status})`);
        for (const secret of [LEAK, SECRET_ID, VALUE, "hvs."])
          expect(e.message).not.toContain(secret);
        // the token is let go
        expect(w.vault.live.size).toBe(0);
        expect(w.vault.calls.at(-1)?.path).toBe("auth/token/revoke-self");
      }
    }
  });

  test("an answer that is not what Vault says is `unexpected`", async () => {
    for (const body of ["<html>", "{}", `{"data":{"keys":"no"}}`, "[]"]) {
      const w = world({
        wrap: failing((m, p) => p.startsWith("kv/metadata") && m === "GET", 200, body),
      });
      const e = await errorOf(w.remote.read());
      expect([body, e.kind]).toEqual([body, "failed"]);
      expect(e.message).toContain("unexpected");
    }
    const w = world({
      wrap: failing(
        (m, p) => p === `kv/data/${ALL}` && m === "GET",
        200,
        `{"data":{"data":[1],"metadata":{"version":1,"custom_metadata":null}}}`,
      ),
    });
    const e = await errorOf(w.remote.update(item("K", VALUE)));
    expect(e.kind).toBe("failed");
    expect(e.message).toContain("unexpected");
    const text = world({
      wrap: failing(
        (m, p) => p === `kv/data/${ALL}` && m === "GET",
        200,
        `{"data":{"data":{},"metadata":{"version":1,"custom_metadata":{"a":1}}}}`,
      ),
    });
    expect((await errorOf(text.remote.update(item("K", VALUE)))).message).toContain("unexpected");
  });

  test("a path with nothing under it reads as nothing", async () => {
    const w = world();
    expect(await w.remote.read()).toEqual([]);
    expect(sent(w.vault)).toContain(`GET kv/metadata/${BASE}/?list=true`);
  });

  test("a network failure and a timeout are failures that name neither the address nor the token", async () => {
    const boom = world({
      wrap: (inner) => async (url, init) => {
        if (new URL(url).pathname.startsWith("/v1/kv/"))
          throw new Error(`boom ${ADDRESS} ${SECRET_ID}`);
        return inner(url, init);
      },
    });
    const e = await errorOf(boom.remote.read());
    expect(e.kind).toBe("failed");
    expect(e.message).toContain("network");
    expect(e.message).not.toContain("vault.example.test");
    expect(e.message).not.toContain(SECRET_ID);
    expect(boom.vault.live.size).toBe(0);

    const slow = world({
      timeoutMs: 20,
      wrap: (inner) => async (url, init) => {
        if (new URL(url).pathname.startsWith("/v1/kv/")) {
          await new Promise((_, reject) =>
            init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          );
        }
        return inner(url, init);
      },
    });
    const t = await errorOf(slow.remote.read());
    expect(t.kind).toBe("failed");
    expect(t.message).toContain("timeout");
  });

  test("a revoke that fails changes nothing", async () => {
    const w = world({ wrap: failing((_m, p) => p === "auth/token/revoke-self", 500) });
    await w.remote.create(item("K", "1"));
    expect(await w.remote.read()).toMatchObject([{ key: "K", value: "1" }]);
  });

  test("a policy that covers another path is a failure, not a write somewhere else", async () => {
    const w = world({ vault: { prefix: "app/other" } });
    const e = await errorOf(w.remote.create(item("K", VALUE)));
    expect(e.kind).toBe("failed");
    expect(e.message).toContain("forbidden (403)");
    expect(w.vault.secrets.size).toBe(0);
  });

  test("no failure carries a value, a token or the secret ID", async () => {
    const w = world();
    w.vault.seed(ALL, { K: "1" }, { [MANAGED_KEY]: BASE });
    const errors = [
      await errorOf(w.remote.create(item("K", VALUE))),
      await errorOf(w.remote.update(item("NOPE", VALUE))),
      await errorOf(w.remote.create(item("bad key", VALUE))),
      await errorOf(w.remote.create(item("K", "x".repeat(300_000)))),
    ];
    for (const e of errors) {
      for (const s of [VALUE, SECRET_ID, LEAK, "hvs.", "xxxxxxxx"])
        expect(e.message).not.toContain(s);
    }
  });
});
