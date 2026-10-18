import { z } from "zod";
import { SyncError } from "./errors";
import { CloudError, failure, reasonOf } from "./http";
import { byKeyThenScope, label } from "./ref";
import {
  ALL_SCOPES,
  type Capabilities,
  type ItemInput,
  type ItemRef,
  type Remote,
  type RemoteItem,
  type SyncAdapter,
} from "./types";
import {
  VAULT_WHY,
  type VaultConfig,
  type VaultDeps,
  vaultJson,
  vaultLogin,
  vaultRequest,
  vaultRevoke,
} from "./vault";

export const VAULT_KV = "vault-kv";

/** The custom metadata that says this platform made the secret; its value is the path the target manages. */
export const MANAGED_KEY = "orch-managed";
/** The custom metadata that says a field is not a secret: `orch-plain.<KEY>` is `1`. A field without one is a secret. */
export const PLAIN_PREFIX = "orch-plain.";
/** The name of the secret that holds the variables of every environment (scope `*`). */
export const ALL_SCOPES_NAME = "_";

/** Vault takes 64 custom metadata entries; this keeps room for the marker and a few that people add. */
const MAX_PLAIN = 48;
const MAX_CUSTOM = 64;
/** The marker is a custom metadata value, which Vault stops at 512 bytes. */
const MAX_MARKER = 512;
/** The data of one secret, so that Vault's answer, with its metadata, is far below what a client reads. */
const MAX_DATA = 256 * 1024;
/** More secrets than this under one path is not a path this platform should manage. */
const MAX_SCOPES = 200;

const name = (max: number) => `[A-Za-z0-9_][A-Za-z0-9_.-]{0,${max - 1}}`;
const fieldName = new RegExp(`^${name(100)}$`);
// the name of a scope's secret; `_` is `*`, so it is not a scope
const scopeName = new RegExp(`^(?!${ALL_SCOPES_NAME}$)${name(100)}$`);

const configSchema = z.strictObject({
  path: z
    .string()
    .regex(
      new RegExp(`^${name(64)}(/${name(64)}){0,3}$`),
      "must be 1-4 names of letters, digits, _ . - separated by /",
    ),
  protected: z.boolean().optional(),
});

/**
 * Where the secrets are: a path under the prefix of the connection (`web`, or `web/api`). The
 * credential, the server and the mounts are the connection's.
 */
export type VaultKvConfig = z.infer<typeof configSchema>;

export function parseVaultKvConfig(config: unknown): VaultKvConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new SyncError(
      "invalid_config",
      "the config is { path }, one to four names such as web/api, and optionally { protected }",
    );
  }
  return parsed.data;
}

const readSchema = z.object({
  data: z.object({
    data: z.unknown(),
    metadata: z.object({ version: z.number().int().nonnegative(), custom_metadata: z.unknown() }),
  }),
});
const listSchema = z.object({ data: z.object({ keys: z.array(z.string()) }) });

const isObject = (v: unknown): v is object =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The members of an object in a Map, so that no key can be mistaken for `__proto__`. */
function entries(v: unknown): Map<string, unknown> {
  if (v === undefined || v === null) return new Map();
  if (!isObject(v)) throw new z.ZodError([]);
  return new Map(Object.entries(v));
}

/** Custom metadata: strings only, as Vault keeps it. */
function strings(v: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, x] of entries(v)) {
    if (typeof x !== "string") throw new z.ZodError([]);
    out.set(k, x);
  }
  return out;
}

/** Fixed words and the status code, so nothing Vault said can reach an error. */
function failed(what: string, e: unknown) {
  let why = "the request could not be made";
  if (e instanceof CloudError) why = `Vault could not be asked (${e.reason})`;
  else if (e instanceof z.ZodError) why = "Vault answered something unexpected";
  return new SyncError("failed", `${what}: ${why}`);
}
const refused = (what: string, status: number) =>
  new SyncError("failed", `${what}: Vault answered ${reasonOf(status)} (${status})`);

/** Whether a 400 is Vault's refusal of a check-and-set. The text is looked at, never repeated. */
const casMismatch = (status: number, text: string) =>
  status === 400 && text.includes("check-and-set");

/** Empty is wrong for any target. */
function checkRef(ref: ItemRef) {
  if (!ref.key) throw new SyncError("invalid", "the key is empty");
  if (!ref.scope) throw new SyncError("invalid", `${label(ref)}: the scope is empty`);
}
/** Whether a secret can be named for this key and scope (a scope is `*` or a name). */
const nameable = ({ key, scope }: ItemRef) =>
  fieldName.test(key) && (scope === ALL_SCOPES || scopeName.test(scope));
function check(item: ItemInput) {
  checkRef(item);
  if (item.file) throw new SyncError("unsupported", `${label(item)}: Vault has no file values`);
  if (!nameable(item)) {
    throw new SyncError(
      "invalid",
      `${label(item)}: a key and a scope are 1-100 letters, digits or _ . - that do not start with . or - (a scope may also be *, and not _)`,
    );
  }
  if (Buffer.byteLength(item.value) > MAX_DATA) {
    throw new SyncError("invalid", `${label(item)}: a secret here holds ${MAX_DATA} bytes at most`);
  }
}

/** The secret's name for a scope. */
const segmentOf = (scope: string) => (scope === ALL_SCOPES ? ALL_SCOPES_NAME : scope);
/** The scope a secret's name stands for; undefined when this adapter would never have made it. */
const scopeOf = (secret: string) =>
  secret === ALL_SCOPES_NAME ? ALL_SCOPES : scopeName.test(secret) ? secret : undefined;

interface Held {
  /** The latest version; the check-and-set of the next write. 0 when nothing was ever written. */
  version: number;
  ours: boolean;
  /** Field to value, whatever it is: what is not text is kept as it is and never listed. */
  data: Map<string, unknown>;
  custom: Map<string, string>;
  plain: Set<string>;
}

/**
 * Secrets in Vault's KV v2 engine as a sync target: the variables of a scope are the fields of one
 * secret, `<mount>/<prefix>/<path>/<scope>`, and scope `*` is the secret `_`. The connection holds the
 * server, the AppRole, the mounts and the prefix; every path stays under the prefix.
 *
 * The platform logs in with the AppRole before each call and revokes the token after it, so no token
 * outlives the call that needed it.
 *
 * The platform only touches a secret it made: its custom metadata has `orch-managed=<prefix>/<path>`.
 * A secret without it (made by hand, or by another tool) is never listed, written or emptied: `create`
 * answers `exists`, `update` and `delete` `not_found`. Inside its own secret the platform keeps the
 * fields it does not know. Every write to the data carries the version it read as check-and-set, so a
 * write that raced another is refused by Vault (`failed`, which the engine retries) instead of
 * replacing it. KV has no per-field flag, so "not a secret" is custom metadata beside the data
 * (`orch-plain.<KEY>=1`); the data and the metadata are two calls, ordered so that an interrupted write
 * leaves a field flagged as a secret, never the other way round. A delete writes a new version
 * without the field: no version is ever deleted or destroyed, so the old values stay in the earlier
 * versions until `max_versions` rotates them out.
 *
 * shortcut: text values only (a field that is not a string is left alone and not listed), 48 plain
 * keys and 256 KiB per secret, 200 secrets per path, one request at a time, a login per call; add
 * batching, a token cache and a destroy of old versions when a path outgrows that.
 */
export function vaultKvAdapter(
  connection: VaultConfig,
  secretId: string,
  d: VaultDeps,
): SyncAdapter<VaultKvConfig> {
  const capabilities: Capabilities = {
    canReadValues: true,
    supportsMasking: true,
    supportsScopes: true,
    supportsFiles: false,
  };
  /** The config, and the path it manages (the marker): names go into URLs, so whatever got here is taken apart again. */
  const located = (given: unknown) => {
    const config = parseVaultKvConfig(given);
    const base = `${connection.prefix}/${config.path}`;
    if (Buffer.byteLength(base) > MAX_MARKER) {
      throw new SyncError("invalid_config", "the path under the prefix is too long");
    }
    return { config, base };
  };

  return {
    type: VAULT_KV,
    capabilities,
    check,
    validate: (config) => located(config).config,
    connect(given): Remote {
      const { base } = located(given);
      const at = (kind: "data" | "metadata", secret = "") =>
        `${connection.kvMount}/${kind}/${base}/${secret}`;
      const absent = (ref: ItemRef) =>
        new SyncError(
          "not_found",
          `${label(ref)} is not there, or its secret is not marked ${MANAGED_KEY}=${base}`,
        );
      const exists = (ref: ItemRef, why: "foreign" | "present" | "not text" = "foreign") =>
        new SyncError(
          "exists",
          {
            foreign: `${label(ref)} is already there; a secret this platform did not make is only managed once its custom metadata has ${MANAGED_KEY}=${base}`,
            present: `${label(ref)} is already there`,
            "not text": `${label(ref)} is already a field of the secret and does not hold text; remove it by hand to let this platform manage the key`,
          }[why],
        );
      const changed = (ref: ItemRef) =>
        new SyncError(
          "failed",
          `${label(ref)}: the secret changed while it was written; try again`,
        );

      /** Runs `fn` with a client token that is revoked afterwards. Whatever goes wrong comes out as a `SyncError`. */
      async function session<T>(what: string, fn: (token: string) => Promise<T>): Promise<T> {
        let token: string;
        try {
          token = await vaultLogin(connection, secretId, d);
        } catch (e) {
          if (e instanceof CloudError) {
            const said = failure("Vault", e.reason, VAULT_WHY);
            throw new SyncError("failed", `${what}: ${said.ok ? "" : said.message}`);
          }
          throw failed(what, e);
        }
        try {
          return await fn(token);
        } catch (e) {
          if (e instanceof SyncError) throw e;
          throw failed(what, e);
        } finally {
          await vaultRevoke(connection, token, d);
        }
      }
      const call = (token: string, method: string, path: string, body?: unknown) =>
        vaultRequest(connection, d, method, path, body, token);

      /** The secret for a scope, or undefined when there is none (or only metadata). */
      async function get(token: string, secret: string, what: string): Promise<Held | undefined> {
        const r = await call(token, "GET", at("data", secret));
        if (r.status !== 200 && r.status !== 404) throw refused(what, r.status);
        // a 404 that carries metadata is a version that was deleted or destroyed: the path is still there
        const parsed = readSchema.safeParse(vaultJson(r.text));
        if (!parsed.success) {
          if (r.status === 404) return undefined;
          throw parsed.error;
        }
        const { data, metadata } = parsed.data.data;
        const custom = strings(metadata.custom_metadata);
        return {
          version: metadata.version,
          ours: custom.get(MANAGED_KEY) === base,
          data: r.status === 200 ? entries(data) : new Map(),
          custom,
          plain: new Set(
            [...custom]
              .filter(([k, v]) => k.startsWith(PLAIN_PREFIX) && v === "1")
              .map(([k]) => k.slice(PLAIN_PREFIX.length)),
          ),
        };
      }
      /** Writes the data at the version that was read. False when Vault says someone else wrote since. */
      async function putData(
        token: string,
        secret: string,
        ref: ItemRef,
        version: number,
        data: Map<string, unknown>,
      ) {
        const r = await call(token, "POST", at("data", secret), {
          options: { cas: version },
          data: Object.fromEntries(data),
        });
        if (casMismatch(r.status, r.text)) return false;
        if (r.status !== 200 && r.status !== 204) throw refused(label(ref), r.status);
        return true;
      }
      /** The flags that still point at a field: a flag left behind by a field that went by hand is dropped. */
      const live = (plain: Set<string>, data: Map<string, unknown>) =>
        new Set([...plain].filter((k) => data.has(k)));
      /** The custom metadata after a write: whatever people added stays, the marker and the flags (`orch-plain.<key>=1`) are this platform's. */
      function stamped(custom: Map<string, string>, plain: Set<string>, ref: ItemRef) {
        const next = new Map(
          [...custom].filter(([k, v]) => !(k.startsWith(PLAIN_PREFIX) && v === "1")),
        );
        next.set(MANAGED_KEY, base);
        for (const k of [...plain].sort()) next.set(`${PLAIN_PREFIX}${k}`, "1");
        if (next.size > MAX_CUSTOM) {
          throw new SyncError(
            "invalid",
            `${label(ref)}: the secret would have more than ${MAX_CUSTOM} custom metadata entries`,
          );
        }
        return next;
      }
      async function putMetadata(
        token: string,
        secret: string,
        ref: ItemRef,
        custom: Map<string, string>,
      ) {
        const r = await call(token, "POST", at("metadata", secret), {
          custom_metadata: Object.fromEntries(custom),
        });
        if (r.status !== 200 && r.status !== 204) throw refused(label(ref), r.status);
      }

      /** What the secret would hold after this write: refused when it would pass what the platform keeps. */
      function bounded(ref: ItemRef, data: Map<string, unknown>, plain: Set<string>) {
        if (Buffer.byteLength(JSON.stringify(Object.fromEntries(data))) > MAX_DATA) {
          throw new SyncError("invalid", `${label(ref)}: the secret would pass ${MAX_DATA} bytes`);
        }
        if (plain.size > MAX_PLAIN) {
          throw new SyncError(
            "invalid",
            `${label(ref)}: a secret here holds ${MAX_PLAIN} keys that are not secrets at most`,
          );
        }
      }

      /**
       * Changes the data and, when a flag changes, the metadata. A flag that goes (the key becomes a
       * secret) goes first and one that comes goes last, so a failure between the two leaves a field
       * flagged as a secret.
       */
      async function commit(
        token: string,
        ref: ItemRef,
        secret: string,
        held: Held,
        data: Map<string, unknown>,
        plain: Set<string>,
      ) {
        const flagsChange =
          plain.size !== held.plain.size || [...plain].some((k) => !held.plain.has(k));
        const custom = flagsChange ? stamped(held.custom, plain, ref) : undefined;
        const goes = [...held.plain].some((k) => !plain.has(k));
        if (custom && goes) await putMetadata(token, secret, ref, custom);
        if (!(await putData(token, secret, ref, held.version, data))) throw changed(ref);
        if (custom && !goes) await putMetadata(token, secret, ref, custom);
      }

      async function write(
        token: string,
        item: ItemInput,
        mode: "create" | "update",
        raced = false,
      ): Promise<void> {
        const secret = segmentOf(item.scope);
        const held = await get(token, secret, label(item));
        const plain = new Set(held?.plain);
        if (item.secret) plain.delete(item.key);
        else plain.add(item.key);

        if (!held) {
          if (mode === "update") throw absent(item);
          const data = new Map<string, unknown>([[item.key, item.value]]);
          bounded(item, data, plain);
          const custom = stamped(new Map(), plain, item);
          // data first, with cas 0: it cannot take over a secret that someone made meanwhile
          if (!(await putData(token, secret, item, 0, data))) {
            if (raced) throw exists(item);
            return write(token, item, mode, true);
          }
          try {
            await putMetadata(token, secret, item, custom);
          } catch (e) {
            if (!(e instanceof SyncError) && !(e instanceof CloudError)) throw e;
            throw new SyncError(
              "failed",
              `${label(item)}: written, but the secret could not be marked; add the custom metadata ${MANAGED_KEY}=${base} to ${at("data", secret)} by hand`,
            );
          }
          return;
        }
        if (!held.ours) throw mode === "create" ? exists(item) : absent(item);
        const there = held.data.get(item.key);
        if (mode === "create" && held.data.has(item.key)) {
          throw exists(item, typeof there === "string" ? "present" : "not text");
        }
        if (mode === "update" && typeof there !== "string") throw absent(item);
        const data = new Map(held.data).set(item.key, item.value);
        const flags = live(plain, data);
        bounded(item, data, flags);
        await commit(token, item, secret, held, data, flags);
      }

      return {
        read: () =>
          session("reading the secrets", async (token) => {
            const r = await call(token, "GET", `${at("metadata")}?list=true`);
            if (r.status === 404) return [];
            if (r.status !== 200) throw refused("reading the secrets", r.status);
            const secrets = listSchema.parse(vaultJson(r.text)).data.keys.flatMap((k) => {
              const scope = k.endsWith("/") ? undefined : scopeOf(k);
              return scope === undefined ? [] : [{ secret: k, scope }];
            });
            if (secrets.length > MAX_SCOPES) {
              throw new SyncError(
                "failed",
                `reading the secrets: more than ${MAX_SCOPES} under the path`,
              );
            }
            const items: RemoteItem[] = [];
            for (const { secret, scope } of secrets) {
              const held = await get(token, secret, "reading the secrets");
              if (!held?.ours) continue;
              for (const [key, value] of held.data) {
                if (typeof value !== "string" || !fieldName.test(key)) continue;
                items.push({ key, scope, value, secret: !held.plain.has(key), file: false });
              }
            }
            return items.sort(byKeyThenScope);
          }),
        async create(item) {
          check(item);
          return session(label(item), (token) => write(token, item, "create"));
        },
        async update(item) {
          check(item);
          return session(label(item), (token) => write(token, item, "update"));
        },
        async delete(ref) {
          checkRef(ref);
          // a key or scope that cannot be named is not there, so `not_found`; create and update say `invalid`
          if (!nameable(ref)) throw absent(ref);
          return session(label(ref), async (token) => {
            const secret = segmentOf(ref.scope);
            const held = await get(token, secret, label(ref));
            if (!held?.ours || typeof held.data.get(ref.key) !== "string") throw absent(ref);
            const data = new Map(held.data);
            data.delete(ref.key);
            await commit(token, ref, secret, held, data, live(held.plain, data));
          });
        },
      };
    },
  };
}
