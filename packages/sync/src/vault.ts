import { z } from "zod";
import { type Check, CloudError, type Fetch, failure, httpsOrigin, reasonOf, send } from "./http";

/** The connection type, as `connections.type` stores it. */
export const VAULT_APPROLE = "vault_approle";

const mount = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "must be a mount name");
const segment = "[A-Za-z0-9_][A-Za-z0-9_.-]*";

/**
 * What a connection of type `vault_approle` says in the open: the server, the AppRole's ID (an
 * identifier, like a user name; the secret ID is the secret), the auth mount it logs in at, and the
 * KV v2 mount and path prefix the role's policy is scoped to. The adapter keeps every path under the
 * prefix.
 *
 * shortcut: no Vault Enterprise namespace and no nested mount paths; add them when a server needs them.
 */
export const vaultConfigSchema = z.strictObject({
  address: httpsOrigin,
  roleId: z.string().regex(/^[!-~]{1,256}$/, "must be an AppRole role ID"),
  authMount: mount.default("approle"),
  kvMount: mount,
  prefix: z
    .string()
    .regex(
      new RegExp(`^${segment}(/${segment}){0,7}$`),
      "must be a path of up to 8 names of letters, digits, _ . - that do not start with a dot",
    ),
  /** Lets variables point at secrets under the prefix (`vault://<name>/…`); off unless set (EXT-6). */
  references: z.boolean().optional(),
});
export type VaultConfig = z.infer<typeof vaultConfigSchema>;

/** The secret of the connection: the AppRole's secret ID, one printable word, so it can travel in a JSON string and a log it must never reach. */
export const vaultSecretIdSchema = z
  .string()
  .regex(/^[!-~]{8,256}$/, "must be an AppRole secret ID");

/**
 * What the platform needs under the prefix, as Vault names capabilities: KV v2 reads and writes the
 * `data` path, writes the `metadata` path (where the ownership marker and the not-a-secret flags live)
 * and lists it. Nothing deletes or destroys a version, so `delete` is not asked for. `show` is the
 * policy path that grants it.
 */
const NEEDS = (c: VaultConfig) =>
  [
    {
      path: `${c.kvMount}/data/${c.prefix}/orch-check`,
      show: `${c.kvMount}/data/${c.prefix}/*`,
      caps: ["create", "read", "update"],
    },
    {
      path: `${c.kvMount}/metadata/${c.prefix}/`,
      show: `${c.kvMount}/metadata/${c.prefix}/*`,
      caps: ["create", "update", "list"],
    },
  ] as const;

export const VAULT_WHY = {
  unauthorized:
    "rejected the AppRole login: the role ID or secret ID is wrong, expired or revoked, or the auth mount is not an AppRole method",
  forbidden: "refused the AppRole login: the role may be limited to other addresses or policies",
  not_found: "has no AppRole auth method at this mount: check the address and the auth mount",
} as const;

export const vaultJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export interface VaultDeps {
  fetch: Fetch;
  timeoutMs?: number | undefined;
}

/** One request to the Vault at `address`; the token, when there is one, goes in the header Vault reads and nowhere else. */
export const vaultRequest = (
  config: Pick<VaultConfig, "address">,
  d: VaultDeps,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) =>
  send(
    d.fetch,
    `${config.address}/v1/${path}`,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { "x-vault-token": token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    d.timeoutMs,
  );

/** Logs in with the AppRole and returns the client token. Any failure is a `CloudError` that says why in a word. */
export async function vaultLogin(
  config: VaultConfig,
  secretId: string,
  d: VaultDeps,
): Promise<string> {
  const login = await vaultRequest(config, d, "POST", `auth/${config.authMount}/login`, {
    role_id: config.roleId,
    secret_id: secretId,
  });
  // Vault answers a wrong role or secret ID with a 400
  if (login.status !== 200)
    throw new CloudError(login.status === 400 ? "unauthorized" : reasonOf(login.status));
  const granted = (vaultJson(login.text) as { auth?: { client_token?: unknown } } | undefined)?.auth
    ?.client_token;
  if (typeof granted !== "string" || !granted) throw new CloudError("unexpected");
  return granted;
}

/** Lets a token go. A failure is ignored: the token then lives until its TTL, which the role sets. */
export const vaultRevoke = (config: VaultConfig, token: string, d: VaultDeps): Promise<void> =>
  vaultRequest(config, d, "POST", "auth/token/revoke-self", {}, token).then(
    () => undefined,
    () => undefined,
  );

/**
 * The connection test: logs in with the AppRole, asks Vault what the resulting token may do on the two
 * paths the adapter uses (capabilities-self, which any token may ask about itself), and revokes the
 * token. Nothing is read or written. The client token lives in this function and goes nowhere else.
 */
export async function checkVaultAppRole(
  config: VaultConfig,
  secretId: string,
  d: VaultDeps,
): Promise<Check> {
  let token: string | undefined;
  try {
    token = await vaultLogin(config, secretId, d);
    const needs = NEEDS(config);
    const asked = await vaultRequest(
      config,
      d,
      "POST",
      "sys/capabilities-self",
      { paths: needs.map((n) => n.path) },
      token,
    );
    if (asked.status !== 200) throw new CloudError(reasonOf(asked.status));
    const answer = vaultJson(asked.text) as
      | (Record<string, unknown> & { data?: Record<string, unknown> })
      | undefined;
    const lacking: string[] = [];
    for (const { path, show, caps } of needs) {
      const have = answer?.data?.[path] ?? answer?.[path];
      if (!Array.isArray(have)) throw new CloudError("unexpected");
      const may = (c: string) =>
        !have.includes("deny") && (have.includes("root") || have.includes(c));
      const missing = caps.filter((c) => !may(c));
      if (missing.length > 0) lacking.push(`${missing.join(", ")} on ${show}`);
    }
    if (lacking.length > 0) {
      return {
        ok: false,
        reason: "forbidden",
        message: `Vault refused: the AppRole's policy lacks ${lacking.join("; ")}.`,
      };
    }
    return {
      ok: true,
      summary: `The AppRole may read and write secrets under ${config.kvMount}/${config.prefix}`,
    };
  } catch (e) {
    if (e instanceof CloudError) return failure("Vault", e.reason, VAULT_WHY);
    throw e;
  } finally {
    // the token was made for this check: do not leave it valid until it expires
    if (token) await vaultRevoke(config, token, d);
  }
}
