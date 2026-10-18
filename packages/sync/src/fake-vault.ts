import type { Fetch } from "./http";

/** One version of a secret, as KV v2 keeps it. */
export interface FakeVaultVersion {
  data: Record<string, unknown>;
  deleted: boolean;
  destroyed: boolean;
}

/** A secret at a path: its versions, and the metadata that belongs to the path, not to a version. */
export interface FakeVaultSecret {
  versions: FakeVaultVersion[];
  custom: Record<string, string> | null;
}

export interface FakeVaultOptions {
  address: string;
  roleId: string;
  secretId: string;
  authMount?: string;
  kvMount?: string;
  /** The path the AppRole's policy covers: data create/read/update and metadata create/update/list under it. */
  prefix: string;
  /** Put into every error message, to catch a client that passes the server's words on. */
  leak?: string;
}

export interface FakeVaultCall {
  method: string;
  /** The path after `/v1/`, with the query. */
  path: string;
  token: string | null;
  body: unknown;
}

const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The part of Vault that the Vault KV v2 adapter uses, written from what a Vault 1.19 dev server
 * answered (see `docs/vault-targets.md`): AppRole login and `revoke-self`, a policy by prefix, KV v2
 * `data` read and check-and-set write, `metadata` custom metadata, and listing. A soft-deleted or
 * destroyed latest version reads as 404 with its metadata; a path that has only metadata reads as a
 * bare 404 and takes `cas: 0`. Errors carry `leak`. Every client token is tracked, so a test can say
 * that none outlived its call.
 */
export function fakeVault(o: FakeVaultOptions) {
  const authMount = o.authMount ?? "approle";
  const kv = o.kvMount ?? "kv";
  /** Path (under the mount) to its secret. */
  const secrets = new Map<string, FakeVaultSecret>();
  const calls: FakeVaultCall[] = [];
  /** Tokens that are valid now. */
  const live = new Set<string>();
  let logins = 0;
  const leak = o.leak ? ` ${o.leak}` : "";
  const errors = (status: number, ...messages: string[]) =>
    Response.json({ errors: messages.map((m) => `${m}${leak}`) }, { status });
  const denied = () => errors(403, "permission denied");
  const gone = () => Response.json({ errors: [] }, { status: 404 });

  const latest = (s: FakeVaultSecret) => s.versions[s.versions.length - 1];
  const metadataOf = (s: FakeVaultSecret) => {
    const v = latest(s);
    return {
      created_time: "2030-01-01T00:00:00Z",
      custom_metadata: s.custom,
      deletion_time: v?.deleted ? "2030-01-02T00:00:00Z" : "",
      destroyed: v?.destroyed ?? false,
      version: s.versions.length,
    };
  };
  const covered = (path: string) => path === o.prefix || path.startsWith(`${o.prefix}/`);

  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const method = String(init.method ?? "GET");
    const headers = new Headers(init.headers);
    const token = headers.get("x-vault-token");
    let body: unknown;
    try {
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    const path = u.pathname.replace(/^\/v1\//, "");
    calls.push({ method, path: path + u.search, token, body });
    if (u.origin !== o.address || !u.pathname.startsWith("/v1/")) return gone();

    if (path === `auth/${authMount}/login`) {
      if (method !== "POST" || !plain(body)) return errors(400, "missing role_id");
      if (body.role_id !== o.roleId || body.secret_id !== o.secretId) {
        return errors(400, "invalid role or secret ID");
      }
      const made = `hvs.fake-client-token-${++logins}`;
      live.add(made);
      return Response.json({ auth: { client_token: made, policies: ["default", "orch"] } });
    }
    if (!token || !live.has(token)) return errors(403, "permission denied", "invalid token");
    if (path === "auth/token/revoke-self") {
      live.delete(token);
      return new Response(null, { status: 204 });
    }

    const m = new RegExp(`^${kv}/(data|metadata)/(.+?)/?$`).exec(path);
    if (!m) return gone();
    const [, kind = "", at = ""] = m;
    if (!covered(at) || at.split("/").includes("..")) return denied();
    const listing =
      kind === "metadata" && method === "GET" && u.searchParams.get("list") === "true";
    const s = secrets.get(at);

    if (listing) {
      const names = new Set<string>();
      for (const k of secrets.keys()) {
        if (!k.startsWith(`${at}/`)) continue;
        const rest = k.slice(at.length + 1).split("/");
        names.add(rest.length > 1 ? `${rest[0]}/` : (rest[0] ?? ""));
      }
      if (names.size === 0) return gone();
      return Response.json({ data: { keys: [...names].sort() } });
    }

    if (kind === "data" && method === "GET") {
      const v = s && latest(s);
      if (!s || !v) return gone();
      if (v.deleted || v.destroyed) {
        return Response.json({ data: { data: null, metadata: metadataOf(s) } }, { status: 404 });
      }
      return Response.json({ data: { data: v.data, metadata: metadataOf(s) } });
    }

    if (kind === "data" && method === "POST") {
      if (!plain(body) || !plain(body.data)) return errors(400, "no data provided");
      const have = s?.versions.length ?? 0;
      const options = body.options;
      if (options !== undefined && !plain(options)) return errors(400, "bad options");
      if (options && "cas" in options && options.cas !== have) {
        return errors(400, "check-and-set parameter did not match the current version");
      }
      const made: FakeVaultSecret = s ?? { versions: [], custom: null };
      made.versions.push({ data: structuredClone(body.data), deleted: false, destroyed: false });
      secrets.set(at, made);
      return Response.json({ data: metadataOf(made) });
    }

    if (kind === "metadata" && method === "POST") {
      const c = plain(body) ? body.custom_metadata : undefined;
      if (
        c !== undefined &&
        !(
          plain(c) &&
          Object.keys(c).length <= 64 &&
          Object.entries(c).every(
            ([k, v]) =>
              typeof v === "string" && Buffer.byteLength(k) <= 128 && Buffer.byteLength(v) <= 512,
          )
        )
      ) {
        return errors(400, "invalid custom_metadata");
      }
      const made: FakeVaultSecret = s ?? { versions: [], custom: null };
      if (c !== undefined) made.custom = structuredClone(c) as Record<string, string>;
      secrets.set(at, made);
      return new Response(null, { status: 204 });
    }

    // the platform deletes nothing: any other call is not one it makes
    return errors(405, "unsupported operation");
  };

  const secretAt = (path: string) => secrets.get(path);
  return {
    fetch,
    secrets,
    calls,
    live,
    get logins() {
      return logins;
    },
    /** The data of the latest version at a path (under the mount), or undefined. */
    data(path: string) {
      const v = secretAt(path)?.versions.at(-1);
      return v && !v.deleted && !v.destroyed ? v.data : undefined;
    },
    custom: (path: string) => secretAt(path)?.custom ?? null,
    /** Adds a secret by hand: `custom` is its custom metadata. */
    seed(
      path: string,
      data: Record<string, unknown>,
      custom: Record<string, string> | null = null,
    ) {
      const s: FakeVaultSecret = secretAt(path) ?? { versions: [], custom: null };
      s.versions.push({ data: structuredClone(data), deleted: false, destroyed: false });
      s.custom = custom;
      secrets.set(path, s);
    },
    /** A path that has custom metadata and no version, as one made by a metadata write alone is. */
    seedMetadataOnly(path: string, custom: Record<string, string>) {
      secrets.set(path, { versions: [], custom });
    },
    /** What `DELETE` or `destroy` leave: the latest version unreadable, its metadata kept. */
    remove(path: string, how: "delete" | "destroy" = "delete") {
      const v = secretAt(path)?.versions.at(-1);
      if (!v) throw new Error(`no secret at ${path}`);
      if (how === "delete") v.deleted = true;
      else v.destroyed = true;
    },
  };
}
