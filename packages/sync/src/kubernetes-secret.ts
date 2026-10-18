import { z } from "zod";
import { SyncError } from "./errors";
import { CloudError, type Fetch, reasonOf, send } from "./http";
import { type KubernetesConfig, kubeName } from "./kubernetes";
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

export const KUBERNETES_SECRET = "kubernetes-secret";

/** The label that says this platform made the Secret; its value is the Secret's name. */
export const MANAGED_LABEL = "orch-managed";
/** The keys that are not secrets, as a JSON list: a Secret holds everything the same, so the flag lives beside it. */
export const PLAIN_ANNOTATION = "orch-plain";

/**
 * Kubernetes stops at 1 MiB of data in a Secret. This keeps a Secret under half that, so that the
 * API server's answer, with its base64, always fits what a client reads.
 */
const MAX_DATA = 512 * 1024;

// what Kubernetes allows as the key of a Secret's data
const dataKey = /^(?!\.{1,2}$)[-._a-zA-Z0-9]{1,253}$/;

const configSchema = z.strictObject({
  namespace: kubeName,
  name: kubeName,
  protected: z.boolean().optional(),
});

/**
 * Where the Secret is: its namespace, which the connection must allow, and its name. The credential
 * and the server are the connection's.
 */
export type KubernetesSecretConfig = z.infer<typeof configSchema>;

export function parseKubernetesSecretConfig(config: unknown): KubernetesSecretConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new SyncError(
      "invalid_config",
      "the config is { namespace, name }, two lowercase names such as apps and my-app-env, and optionally { protected }",
    );
  }
  return parsed.data;
}

const secretSchema = z.object({
  metadata: z.object({
    resourceVersion: z.string(),
    labels: z.record(z.string(), z.string()).nullish(),
    annotations: z.record(z.string(), z.string()).nullish(),
  }),
  data: z.unknown(),
  immutable: z.boolean().nullish(),
});

/** The text of a base64 value, or undefined when it is not text (the platform only keeps text). */
function textOf(b64: string): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(b64, "base64"));
  } catch {
    return undefined;
  }
}

/** The members of an object whose values are strings, in a Map so that no key can be mistaken for `__proto__`. */
function stringMap(v: unknown): Map<string, string> {
  if (v === undefined || v === null) return new Map();
  if (typeof v !== "object" || Array.isArray(v)) throw new z.ZodError([]);
  const out = new Map<string, string>();
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string") throw new z.ZodError([]);
    out.set(k, x);
  }
  return out;
}

/** The keys an annotation lists as not secret. One that is not a list of names lists none: everything then shows as a secret. */
function plainKeys(annotation: string | undefined): Set<string> {
  try {
    const parsed: unknown = JSON.parse(annotation ?? "[]");
    if (Array.isArray(parsed) && parsed.every((k) => typeof k === "string")) return new Set(parsed);
  } catch {
    // not JSON: the same as no list
  }
  return new Set();
}

/** Fixed words and the status code, so nothing the API server said can reach an error. */
function failed(what: string, e: unknown) {
  let why = "the request could not be made";
  if (e instanceof CloudError) why = `Kubernetes could not be asked (${e.reason})`;
  else if (e instanceof z.ZodError) why = "Kubernetes answered something unexpected";
  return new SyncError("failed", `${what}: ${why}`);
}
const refused = (what: string, status: number) =>
  new SyncError("failed", `${what}: Kubernetes answered ${reasonOf(status)} (${status})`);

/** The checks that need no Secret: the key, the scope and the value. */
function check(item: ItemInput) {
  checkRef(item);
  if (item.file) throw new SyncError("unsupported", `${label(item)}: a Secret has no file values`);
  if (!dataKey.test(item.key)) {
    throw new SyncError(
      "invalid",
      `${label(item)}: a key is 1-253 letters, digits or - _ . (and not . or ..)`,
    );
  }
  if (Buffer.byteLength(item.value) > MAX_DATA) {
    throw new SyncError("invalid", `${label(item)}: a Secret here holds ${MAX_DATA} bytes at most`);
  }
}
/** Empty is wrong for any target, and a Secret has no scopes. */
function checkRef(ref: ItemRef) {
  if (!ref.key) throw new SyncError("invalid", "the key is empty");
  if (!ref.scope) throw new SyncError("invalid", `${label(ref)}: the scope is empty`);
  if (ref.scope !== ALL_SCOPES) {
    throw new SyncError(
      "unsupported",
      `${label(ref)}: a Secret has no scopes; sync an environment to a target of its own`,
    );
  }
}

interface Held {
  version: string;
  ours: boolean;
  immutable: boolean;
  /** Key to its base64 value. */
  data: Map<string, string>;
  plain: Set<string>;
}

/**
 * One Kubernetes Secret as a sync target: `<namespace>/<name>`, type `Opaque`, a key of the Secret per
 * variable (scope `*` only; one target per environment's namespace). The connection holds the server,
 * the service-account token and the namespaces this platform may write to; a target in any other
 * namespace is refused, whatever the token could do.
 *
 * The platform only touches a Secret it made: it carries the label `orch-managed=<name>`. A Secret
 * that is not labelled (made by hand, by Helm or another tool) is never listed, written or emptied:
 * `create` answers `exists`, `update` and `delete` `not_found`. Inside its own Secret the platform
 * keeps the other keys as they are, so what it does not know about stays (the plan's `unmanaged`
 * policy decides whether they are ever deleted). Every write is a JSON merge patch that carries the
 * `resourceVersion` it read, so a write that raced another is refused by the API server (`failed`,
 * which the engine retries) instead of replacing it. Secrets are all alike, so "not a secret" is a
 * list of keys in an annotation, changed by the same patch as the value. A delete removes the key; the
 * Secret stays, empty, since pods may mount it.
 *
 * shortcut: one GET per write; text values only (a binary key is left alone, not listed), a Secret
 * under 512 KiB; no rollout restart of the workloads that use it (add an after-apply step to the
 * adapter when a cluster has no reloader); one Secret per target, so no scopes.
 */
export function kubernetesSecretAdapter(
  connection: KubernetesConfig,
  token: string,
  d: { fetch: Fetch; timeoutMs?: number | undefined },
): SyncAdapter<KubernetesSecretConfig> {
  const capabilities: Capabilities = {
    canReadValues: true,
    supportsMasking: true,
    supportsScopes: false,
    supportsFiles: false,
  };
  const allowed = new Set(connection.namespaces);
  /** The namespace allowlist belongs to the connection, and is checked wherever a config is taken. */
  const bound = (config: KubernetesSecretConfig) => {
    if (!allowed.has(config.namespace)) {
      throw new SyncError("invalid_config", "the namespace is not one the connection allows");
    }
    return config;
  };

  return {
    type: KUBERNETES_SECRET,
    capabilities,
    check,
    validate: (config) => bound(parseKubernetesSecretConfig(config)),
    connect(given): Remote {
      // names go into a URL: whatever reached here is taken apart again, not trusted to have been validated
      const config = bound(parseKubernetesSecretConfig(given));
      const path = `/api/v1/namespaces/${config.namespace}/secrets`;
      const call = (method: string, at: string, body?: unknown) =>
        send(
          d.fetch,
          `${connection.server}${at}`,
          {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json",
              ...(body === undefined
                ? {}
                : {
                    "content-type":
                      method === "PATCH" ? "application/merge-patch+json" : "application/json",
                  }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            ...(connection.ca ? { tls: { ca: connection.ca } } : {}),
          },
          d.timeoutMs,
        );
      const absent = (ref: ItemRef) =>
        new SyncError(
          "not_found",
          `${label(ref)} is not there, or its Secret is not labelled ${MANAGED_LABEL}=${config.name}`,
        );
      const exists = (ref: ItemRef, binary = false) =>
        new SyncError(
          "exists",
          binary
            ? `${label(ref)} is already a key of the Secret and holds bytes that are not text; remove it by hand to let this platform manage the key`
            : `${label(ref)} is already there; a Secret this platform did not make is only managed once it carries the label ${MANAGED_LABEL}=${config.name}`,
        );

      /** The Secret, or undefined when there is none. */
      const get = async (what: string): Promise<Held | undefined> => {
        try {
          const r = await call("GET", `${path}/${config.name}`);
          if (r.status === 404) return undefined;
          if (r.status !== 200) throw refused(what, r.status);
          const s = secretSchema.parse(JSON.parse(r.text));
          return {
            version: s.metadata.resourceVersion,
            ours: s.metadata.labels?.[MANAGED_LABEL] === config.name,
            immutable: s.immutable === true,
            data: stringMap(s.data),
            plain: plainKeys(s.metadata.annotations?.[PLAIN_ANNOTATION]),
          };
        } catch (e) {
          if (e instanceof SyncError) throw e;
          throw failed(what, e);
        }
      };
      /** A merge patch that holds only if nobody changed the Secret since it was read. */
      const patch = async (ref: ItemRef, held: Held, value: string | null, plain: Set<string>) => {
        // permanent, so said plainly rather than as a 422 from the API server
        if (held.immutable) {
          throw new SyncError(
            "failed",
            `${label(ref)}: the Secret is immutable and cannot be changed`,
          );
        }
        const flags = JSON.stringify([...plain].sort());
        try {
          const r = await call("PATCH", `${path}/${config.name}`, {
            metadata: {
              resourceVersion: held.version,
              ...(flags === JSON.stringify([...held.plain].sort())
                ? {}
                : { annotations: { [PLAIN_ANNOTATION]: plain.size > 0 ? flags : null } }),
            },
            data: { [ref.key]: value === null ? null : Buffer.from(value).toString("base64") },
          });
          if (r.status === 409 || r.status === 404) {
            throw new SyncError(
              "failed",
              `${label(ref)}: the Secret ${r.status === 409 ? "changed while it was being written" : "is no longer there"}; try again`,
            );
          }
          if (r.status !== 200) throw refused(label(ref), r.status);
        } catch (e) {
          if (e instanceof SyncError) throw e;
          throw failed(label(ref), e);
        }
      };
      const flagged = (held: Held, item: ItemInput) => {
        const plain = new Set(held.plain);
        if (item.secret) plain.delete(item.key);
        else plain.add(item.key);
        return plain;
      };
      /** What the Secret would hold after this value goes in (a Secret's size is all its keys). */
      const grown = (held: Held, ref: ItemRef, value: string) => {
        let size = Buffer.byteLength(value);
        for (const [k, v] of held.data) if (k !== ref.key) size += Buffer.from(v, "base64").length;
        if (size > MAX_DATA) {
          throw new SyncError("invalid", `${label(ref)}: the Secret would pass ${MAX_DATA} bytes`);
        }
      };

      /** A key as text; undefined when the Secret has no such key or it holds bytes that are not text. */
      const textAt = (held: Held, key: string) => {
        const b64 = held.data.get(key);
        return b64 === undefined ? undefined : textOf(b64);
      };

      async function write(
        item: ItemInput,
        mode: "create" | "update",
        raced = false,
      ): Promise<void> {
        check(item);
        const held = await get(label(item));
        if (!held) {
          if (mode === "update") throw absent(item);
          let taken = false;
          try {
            const r = await call("POST", path, {
              apiVersion: "v1",
              kind: "Secret",
              type: "Opaque",
              metadata: {
                name: config.name,
                labels: { [MANAGED_LABEL]: config.name },
                ...(item.secret
                  ? {}
                  : { annotations: { [PLAIN_ANNOTATION]: JSON.stringify([item.key]) } }),
              },
              data: { [item.key]: Buffer.from(item.value).toString("base64") },
            });
            taken = r.status === 409;
            if (taken && raced) throw exists(item);
            if (!taken && r.status !== 201 && r.status !== 200)
              throw refused(label(item), r.status);
          } catch (e) {
            if (e instanceof SyncError) throw e;
            throw failed(label(item), e);
          }
          // made between the read and the create: look again, it may be ours
          return taken ? write(item, mode, true) : undefined;
        }
        if (!held.ours) throw mode === "create" ? exists(item) : absent(item);
        if (mode === "create") {
          if (held.data.has(item.key)) throw exists(item, textAt(held, item.key) === undefined);
        } else if (textAt(held, item.key) === undefined) {
          throw absent(item);
        }
        grown(held, item, item.value);
        await patch(item, held, item.value, flagged(held, item));
      }

      return {
        async read() {
          const held = await get("reading the Secret");
          if (!held?.ours) return [];
          const items: RemoteItem[] = [];
          for (const [key, b64] of held.data) {
            const value = textOf(b64);
            if (value === undefined || !dataKey.test(key)) continue;
            items.push({
              key,
              scope: ALL_SCOPES,
              value,
              secret: !held.plain.has(key),
              file: false,
            });
          }
          return items.sort(byKeyThenScope);
        },
        create: (item) => write(item, "create"),
        update: (item) => write(item, "update"),
        async delete(ref) {
          checkRef(ref);
          if (!dataKey.test(ref.key)) throw absent(ref);
          const held = await get(label(ref));
          if (!held?.ours || textAt(held, ref.key) === undefined) throw absent(ref);
          const plain = new Set(held.plain);
          plain.delete(ref.key);
          await patch(ref, held, null, plain);
        },
      };
    },
  };
}
