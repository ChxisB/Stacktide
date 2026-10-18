import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { runAdapterConformance } from "./conformance";
import { ALL_SCOPES, type ItemInput } from "./types";
import { checkVaultAppRole, type VaultConfig } from "./vault";
import { vaultKvAdapter } from "./vault-kv";

/**
 * The opt-in run against a real Vault or OpenBao (KV v2, an AppRole whose policy covers `prefix`: data
 * create/read/update and metadata create/update/list, nothing else). Setting VAULT_E2E_ADDRESS turns it
 * on. It writes new secrets under `<prefix>/e2e-<id>/` and never deletes or destroys one, so point it at
 * a development server or a mount of its own. Errors never echo the secret ID.
 */
const env = process.env;
const address = env.VAULT_E2E_ADDRESS?.trim().replace(/\/+$/, "");
const SECRET_ID = env.VAULT_E2E_SECRET_ID ?? "";

const item = (key: string, value: string, scope = ALL_SCOPES, secret = false): ItemInput => ({
  key,
  scope,
  value,
  secret,
  file: false,
});

if (!address) {
  test.skip("real Vault (set VAULT_E2E_ADDRESS to run it)", () => {});
} else {
  if (env.VAULT_E2E_ALLOW_WRITES !== "yes") {
    throw new Error(
      "The real-Vault run writes secrets under VAULT_E2E_PREFIX: set VAULT_E2E_ALLOW_WRITES=yes to confirm",
    );
  }
  const missing = [
    "VAULT_E2E_ROLE_ID",
    "VAULT_E2E_SECRET_ID",
    "VAULT_E2E_KV_MOUNT",
    "VAULT_E2E_PREFIX",
  ]
    .filter((k) => !env[k])
    .join(", ");
  if (missing) throw new Error(`VAULT_E2E_ADDRESS is set but ${missing} is missing`);

  const connection: VaultConfig = {
    address,
    roleId: env.VAULT_E2E_ROLE_ID ?? "",
    authMount: env.VAULT_E2E_AUTH_MOUNT || "approle",
    kvMount: env.VAULT_E2E_KV_MOUNT ?? "",
    prefix: env.VAULT_E2E_PREFIX ?? "",
  };
  const d = { fetch: globalThis.fetch as never };
  const fresh = () => {
    const path = `e2e-${randomUUID()}`;
    return { path, adapter: vaultKvAdapter(connection, SECRET_ID, d) };
  };

  runAdapterConformance(
    "vault-kv (real Vault)",
    async () => {
      const { path, adapter } = fresh();
      return { adapter, config: { path } };
    },
    {
      refused: [
        { item: item("has space", "v"), kind: "invalid" },
        { item: item("K", "v", "staging/*"), kind: "invalid" },
        { item: item("K", "v", "_"), kind: "invalid" },
      ],
    },
  );

  test("the connection test passes with the policy this adapter needs", async () => {
    const checked = await checkVaultAppRole(connection, SECRET_ID, d);
    expect(checked.ok).toBe(true);
  });

  test("two creates of one field race: one wins, the other is told so", async () => {
    const { path, adapter } = fresh();
    const remote = adapter.connect({ path });
    const results = await Promise.allSettled([
      remote.create(item("RACE", "one")),
      remote.create(item("RACE", "two")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(["exists", "failed"]).toContain((lost as PromiseRejectedResult).reason.kind);
    const [read] = await remote.read();
    expect(read?.key).toBe("RACE");
    expect(["one", "two"]).toContain(read?.value ?? "");
  });

  test("the secret is marked, and what is plain is kept apart from what is secret", async () => {
    const { path, adapter } = fresh();
    const remote = adapter.connect({ path });
    await remote.create(item("PLAIN", "p", ALL_SCOPES, false));
    await remote.create(item("SECRET", "s", ALL_SCOPES, true));
    await remote.create(item("PROD", "x", "production", false));
    expect(await remote.read()).toEqual([
      { key: "PLAIN", scope: ALL_SCOPES, value: "p", secret: false, file: false },
      { key: "PROD", scope: "production", value: "x", secret: false, file: false },
      { key: "SECRET", scope: ALL_SCOPES, value: "s", secret: true, file: false },
    ]);
  });
}
