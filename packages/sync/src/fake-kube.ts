import type { Fetch } from "./http";

/** A Secret as the fake keeps it: the base64 strings the API server stores. */
export interface FakeKubeSecret {
  resourceVersion: number;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  data: Record<string, string>;
  type: string;
  immutable?: boolean;
}

export interface FakeKubeOptions {
  server: string;
  token: string;
  /** The namespaces that exist. */
  namespaces: string[];
  /** Put into every error message, to catch a client that passes the server's words on. */
  leak?: string;
}

export interface FakeKubeCall {
  method: string;
  path: string;
  contentType: string | null;
  authorization: string | null;
  tls: unknown;
  body: unknown;
}

const MAX_DATA = 1024 * 1024;
const KEY = /^(?!\.{1,2}$)[-._a-zA-Z0-9]{1,253}$/;
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** RFC 7386: an object merges, `null` removes, anything else replaces. Own keys only, so `__proto__` is a key. */
function merge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (plain(v)) {
      const there = target[k];
      const next = plain(there) ? there : {};
      merge(next, v);
      Object.defineProperty(target, k, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      Object.defineProperty(target, k, {
        value: v,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
}

/**
 * The part of a Kubernetes API server that Secrets use: bearer authentication, `GET`, `POST` and
 * JSON-merge `PATCH` of Secrets in namespaces that exist, with `resourceVersion` as a precondition,
 * the key and size rules, and immutable Secrets. Everything else is a 404. Errors are `Status` objects
 * whose message carries `leak`.
 */
export function fakeKube(o: FakeKubeOptions) {
  const secrets = new Map<string, FakeKubeSecret>();
  const calls: FakeKubeCall[] = [];
  /** `<METHOD> <namespace>` the token may not do. */
  const forbidden = new Set<string>();
  let versions = 0;
  const leak = o.leak ? ` ${o.leak}` : "";
  const status = (code: number, reason: string) =>
    Response.json(
      { kind: "Status", status: "Failure", reason, code, message: `no${leak}` },
      { status: code },
    );
  const view = (ns: string, name: string, s: FakeKubeSecret) => ({
    apiVersion: "v1",
    kind: "Secret",
    type: s.type,
    metadata: {
      name,
      namespace: ns,
      resourceVersion: String(s.resourceVersion),
      labels: s.labels,
      annotations: s.annotations,
    },
    data: s.data,
    ...(s.immutable ? { immutable: true } : {}),
  });
  /** Why the data cannot be stored, if it cannot. */
  const invalid = (data: Record<string, string>) => {
    let size = 0;
    for (const [k, v] of Object.entries(data)) {
      if (!KEY.test(k) || typeof v !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) return true;
      size += Buffer.from(v, "base64").length;
    }
    return size > MAX_DATA;
  };
  const strings = (v: unknown) =>
    plain(v) && Object.values(v).every((x) => typeof x === "string")
      ? (v as Record<string, string>)
      : undefined;

  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const method = String(init.method ?? "GET");
    const headers = new Headers(init.headers);
    let body: unknown;
    try {
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({
      method,
      path: u.pathname,
      contentType: headers.get("content-type"),
      authorization: headers.get("authorization"),
      tls: init.tls,
      body,
    });
    if (u.origin !== o.server) return status(404, "NotFound");
    if (headers.get("authorization") !== `Bearer ${o.token}`) return status(401, "Unauthorized");
    const m = /^\/api\/v1\/namespaces\/([^/]+)\/secrets(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return status(404, "NotFound");
    const [, ns = "", name] = m;
    if (forbidden.has(`${method} ${ns}`)) return status(403, "Forbidden");
    if (!o.namespaces.includes(ns)) return status(404, "NotFound");
    const key = `${ns}/${name}`;

    if (name === undefined) {
      if (method !== "POST") return status(405, "MethodNotAllowed");
      if (!plain(body) || !plain(body.metadata)) return status(400, "BadRequest");
      const meta = body.metadata;
      const made = meta.name;
      if (typeof made !== "string" || !NAME.test(made)) return status(422, "Invalid");
      const data = body.data === undefined ? {} : strings(body.data);
      if (!data || invalid(data) || (body.type !== undefined && typeof body.type !== "string")) {
        return status(422, "Invalid");
      }
      if (secrets.has(`${ns}/${made}`)) return status(409, "AlreadyExists");
      const s: FakeKubeSecret = {
        resourceVersion: ++versions,
        labels: strings(meta.labels) ?? {},
        annotations: strings(meta.annotations) ?? {},
        data,
        type: typeof body.type === "string" ? body.type : "Opaque",
      };
      secrets.set(`${ns}/${made}`, s);
      return Response.json(view(ns, made, s), { status: 201 });
    }

    const s = secrets.get(key);
    if (!s) return status(404, "NotFound");
    if (method === "GET") return Response.json(view(ns, name, s));
    if (method !== "PATCH") return status(405, "MethodNotAllowed");
    if (headers.get("content-type") !== "application/merge-patch+json") {
      return status(415, "UnsupportedMediaType");
    }
    if (!plain(body)) return status(400, "BadRequest");
    const wanted = plain(body.metadata) ? body.metadata.resourceVersion : undefined;
    if (wanted !== undefined && wanted !== String(s.resourceVersion)) {
      return status(409, "Conflict");
    }
    const next = structuredClone({ ...s }) as FakeKubeSecret;
    const { metadata, data } = body;
    if (plain(metadata)) {
      if (plain(metadata.labels)) merge(next.labels, metadata.labels);
      if (plain(metadata.annotations)) merge(next.annotations, metadata.annotations);
    }
    if (plain(data)) merge(next.data, data);
    if (invalid(next.data) || !strings(next.labels) || !strings(next.annotations)) {
      return status(422, "Invalid");
    }
    if (s.immutable && JSON.stringify(next.data) !== JSON.stringify(s.data)) {
      return status(422, "Invalid");
    }
    next.resourceVersion = ++versions;
    secrets.set(key, next);
    return Response.json(view(ns, name, next));
  };

  return {
    fetch,
    secrets,
    calls,
    forbidden,
    /** The text of a key, decoded. */
    value(ns: string, name: string, key: string) {
      const v = secrets.get(`${ns}/${name}`)?.data[key];
      return v === undefined ? undefined : Buffer.from(v, "base64").toString("utf8");
    },
    /** Adds a Secret (no labels unless given); `data` is plain text and is encoded. */
    seed(
      ns: string,
      name: string,
      data: Record<string, string>,
      extra: Partial<Pick<FakeKubeSecret, "labels" | "annotations" | "immutable" | "type">> = {},
    ) {
      secrets.set(`${ns}/${name}`, {
        resourceVersion: ++versions,
        labels: {},
        annotations: {},
        type: "Opaque",
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString("base64")]),
        ),
        ...extra,
      });
    },
  };
}
