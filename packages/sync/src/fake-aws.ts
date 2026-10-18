import { type AwsCreds, signV4 } from "./aws";
import type { Fetch } from "./http";

export interface FakeAwsOptions {
  /** The platform's own identity: the only one the role trusts, and it may do nothing but assume the role. */
  base: AwsCreds;
  roleArn: string;
  externalId: string;
  /** The one region the account's services answer in. */
  region: string;
  /** The clock the fake judges expiry by; the client under test has its own. */
  now?: () => Date;
  /** The most parameters one DescribeParameters page holds (50 at most, as AWS), to make a client follow the token. */
  pageSize?: number;
  /** Text put into the message of every error, as AWS puts ARNs and fields in its own: a client must pass none of it on. */
  leak?: string;
}

export interface FakeParameter {
  type: "String" | "StringList" | "SecureString";
  value: string;
  keyId?: string;
  tags: Record<string, string>;
  version: number;
}

export interface FakeAwsCall {
  service: string;
  action: string;
  region: string;
  accessKeyId: string;
  body: unknown;
}

const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const PUT_TYPES = ["String", "StringList", "SecureString"];

/**
 * AWS as far as the sync clients use it, as a `fetch`: STS (AssumeRole, GetCallerIdentity) and SSM
 * Parameter Store, written from the services' documentation, not from a recording. It checks what a
 * real endpoint checks of a request: the host names the region, the signature is the one the caller's
 * secret makes (re-signed here, so a header changed after signing is caught), the session token goes
 * with the key, assumed credentials expire after 900 s, and SSM refuses what the service refuses (names,
 * sizes, `Tags` with `Overwrite`, a value that looks like `{{ref}}`).
 *
 * shortcut: standard-tier parameters only, no versions or labels, no KMS (a SecureString is stored
 * readable and handed out only to `WithDecryption`); add them when an adapter needs them.
 */
export function fakeAws(o: FakeAwsOptions) {
  const now = o.now ?? (() => new Date());
  const params = new Map<string, FakeParameter>();
  const assumed = new Map<string, { secret: string; token: string; expiresAt: Date }>();
  const calls: FakeAwsCall[] = [];
  /** SSM actions the assumed role may not call. */
  const denied = new Set<string>();
  let issued = 0;
  const account = /:(\d{12}):/.exec(o.roleArn)?.[1] ?? "000000000000";
  const roleName = o.roleArn.split("/").pop() ?? "role";

  const leak = o.leak ? ` ${o.leak}` : "";
  const xmlError = (status: number, code: string) =>
    new Response(
      `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>no${leak}</Message></Error></ErrorResponse>`,
      { status },
    );
  const jsonError = (status: number, type: string) =>
    Response.json({ __type: type, message: `no${leak}` }, { status });
  const refuse = (service: string, status: number, code: string) =>
    service === "sts" ? xmlError(status, code) : jsonError(status, code);
  const invalid = () => jsonError(400, "ValidationException");

  function badName(name: unknown): boolean {
    if (typeof name !== "string" || name.length > 1011) return true;
    if (!/^\/[A-Za-z0-9_.\-/]+$/.test(name) || name.includes("//") || name.endsWith("/"))
      return true;
    const levels = name.split("/").slice(1);
    return levels.length > 15 || /^(aws|ssm)/i.test(levels[0] ?? "");
  }

  function put(b: Record<string, unknown>): Response {
    const { Name: name, Value: value, Overwrite: overwrite, Tags: tags } = b;
    const type = (b.Type ?? "String") as FakeParameter["type"];
    if (badName(name) || typeof name !== "string") return invalid();
    if (!PUT_TYPES.includes(type)) return invalid();
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value) < 1 ||
      Buffer.byteLength(value) > 4096
    )
      return invalid();
    if (/\{\{.*\}\}/s.test(value)) return invalid();
    if (b.KeyId !== undefined && (type !== "SecureString" || typeof b.KeyId !== "string"))
      return invalid();
    // "Invalid request: tags and overwrite can't be used together"
    if (tags !== undefined && overwrite === true) return invalid();
    const tagged: Record<string, string> = {};
    for (const t of Array.isArray(tags) ? tags : []) {
      const { Key: k, Value: v } = t as { Key?: unknown; Value?: unknown };
      if (typeof k !== "string" || typeof v !== "string") return invalid();
      if (!/^[\w .:/=+@-]{1,128}$/.test(k) || /^aws:/i.test(k) || v.length > 256) return invalid();
      tagged[k] = v;
    }
    const there = params.get(name);
    if (there && overwrite !== true) return jsonError(400, "ParameterAlreadyExists");
    const keyId = typeof b.KeyId === "string" ? { keyId: b.KeyId } : {};
    // overwriting what is not there creates it, as the service does
    params.set(name, {
      type,
      value,
      ...keyId,
      tags: there ? there.tags : tagged,
      version: (there?.version ?? 0) + 1,
    });
    return Response.json({ Version: params.get(name)?.version, Tier: "Standard" });
  }

  function describe(b: Record<string, unknown>): Response {
    const filters = Array.isArray(b.ParameterFilters) ? b.ParameterFilters : [];
    const max = b.MaxResults ?? 50;
    if (typeof max !== "number" || max < 1 || max > 50) return invalid();
    let names = [...params.keys()];
    for (const f of filters as { Key?: unknown; Option?: unknown; Values?: unknown }[]) {
      const values = Array.isArray(f.Values) ? (f.Values as string[]) : [];
      if (typeof f.Key !== "string" || values.length < 1) return invalid();
      if (f.Key === "Path") {
        const path = values[0] ?? "";
        if (
          !path.startsWith("/") ||
          (f.Option !== undefined && !["Recursive", "OneLevel"].includes(f.Option as string))
        ) {
          return invalid();
        }
        names = names.filter((n) => {
          if (!n.startsWith(`${path}/`)) return false;
          return f.Option === "Recursive" || !n.slice(path.length + 1).includes("/");
        });
      } else if (f.Key.startsWith("tag:")) {
        const tag = f.Key.slice(4);
        names = names.filter((n) => values.includes(params.get(n)?.tags[tag] ?? "\0"));
      } else {
        return jsonError(400, "InvalidFilterKey");
      }
    }
    // no order is promised: a client that relies on one is caught by this one
    names.sort().reverse();
    const size = Math.min(max, o.pageSize ?? 50);
    let from = 0;
    if (b.NextToken !== undefined) {
      const m = /^page-(\d+)$/.exec(String(b.NextToken));
      if (!m) return jsonError(400, "InvalidNextToken");
      from = Number(m[1]);
    }
    const page = names.slice(from, from + size);
    return Response.json({
      Parameters: page.map((Name) => {
        const p = params.get(Name);
        return {
          Name,
          Type: p?.type,
          Version: p?.version,
          ...(p?.keyId ? { KeyId: p.keyId } : {}),
        };
      }),
      ...(from + size < names.length ? { NextToken: `page-${from + size}` } : {}),
    });
  }

  function get(b: Record<string, unknown>): Response {
    const names = b.Names;
    if (!Array.isArray(names) || names.length < 1 || names.length > 10) return invalid();
    const found: unknown[] = [];
    const missing: string[] = [];
    for (const name of names as string[]) {
      const p = params.get(name);
      if (!p) missing.push(name);
      else {
        const readable = p.type !== "SecureString" || b.WithDecryption === true;
        found.push({
          Name: name,
          Type: p.type,
          Version: p.version,
          Value: readable ? p.value : `AQICAHhfake${p.value.length}`,
        });
      }
    }
    return Response.json({ Parameters: found, InvalidParameters: missing });
  }

  function ssm(action: string, b: Record<string, unknown>): Response {
    switch (action) {
      case "PutParameter":
        return put(b);
      case "DescribeParameters":
        return describe(b);
      case "GetParameters":
        return get(b);
      case "ListTagsForResource": {
        const p = typeof b.ResourceId === "string" ? params.get(b.ResourceId) : undefined;
        if (b.ResourceType !== "Parameter") return invalid();
        if (!p) return jsonError(400, "InvalidResourceId");
        return Response.json({
          TagList: Object.entries(p.tags).map(([Key, Value]) => ({ Key, Value })),
        });
      }
      case "DeleteParameter": {
        if (typeof b.Name !== "string" || !params.delete(b.Name)) {
          return jsonError(400, "ParameterNotFound");
        }
        return Response.json({});
      }
      default:
        return jsonError(400, "UnknownOperationException");
    }
  }

  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = Object.fromEntries(new Headers(init.headers).entries());
    const body = String(init.body ?? "");
    const host = /^([a-z0-9]+)\.([a-z0-9-]+)\.amazonaws\.com$/.exec(u.host);
    if (!host || u.protocol !== "https:" || u.pathname !== "/" || init.method !== "POST") {
      return new Response("", { status: 404 });
    }
    const service = host[1] ?? "";
    const region = host[2] ?? "";
    const scope = /Credential=([^/]+)\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request/.exec(
      headers.authorization ?? "",
    );
    if (!scope) return refuse(service, 403, "MissingAuthenticationToken");
    const [, accessKeyId = "", scopeRegion, scopeService] = scope;
    if (scopeRegion !== region || scopeService !== service) {
      return refuse(service, 403, "SignatureDoesNotMatch");
    }
    const temp = assumed.get(accessKeyId);
    const known =
      accessKeyId === o.base.accessKeyId
        ? { secret: o.base.secretAccessKey, token: o.base.sessionToken }
        : temp && { secret: temp.secret, token: temp.token };
    if (!known) return refuse(service, 403, "InvalidClientTokenId");
    if (temp && temp.expiresAt.getTime() <= now().getTime()) {
      return refuse(service, 400, "ExpiredToken");
    }
    if (headers["x-amz-security-token"] !== known.token) {
      return refuse(service, 403, "InvalidClientTokenId");
    }
    const at = new Date((headers["x-amz-date"] ?? "").replace(STAMP, "$1-$2-$3T$4:$5:$6Z"));
    const unsigned = Object.fromEntries(
      Object.entries(headers).filter(
        ([k]) => !["authorization", "x-amz-date", "x-amz-security-token"].includes(k),
      ),
    );
    const again = signV4({
      method: "POST",
      url,
      headers: unsigned,
      body,
      creds: {
        accessKeyId,
        secretAccessKey: known.secret,
        ...(known.token ? { sessionToken: known.token } : {}),
      },
      region,
      service,
      now: at,
    });
    if (again.authorization !== headers.authorization) {
      return refuse(service, 403, "SignatureDoesNotMatch");
    }

    if (service === "sts") {
      const form = new URLSearchParams(body);
      const action = form.get("Action");
      calls.push({
        service,
        action: action ?? "",
        region,
        accessKeyId,
        body: Object.fromEntries(form),
      });
      if (action === "AssumeRole") {
        const trusted =
          accessKeyId === o.base.accessKeyId &&
          form.get("RoleArn") === o.roleArn &&
          form.get("ExternalId") === o.externalId;
        if (!trusted) return xmlError(403, "AccessDenied");
        issued += 1;
        const creds = {
          accessKeyId: `ASIAFAKE${String(issued).padStart(8, "0")}`,
          secret: `assumed-secret-${issued}-CANARY`,
          token: `assumed-token-${issued}-CANARY`,
          expiresAt: new Date(now().getTime() + 900_000),
        };
        assumed.set(creds.accessKeyId, creds);
        return new Response(
          `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>${creds.accessKeyId}</AccessKeyId><SecretAccessKey>${creds.secret}</SecretAccessKey><SessionToken>${creds.token}</SessionToken><Expiration>${creds.expiresAt.toISOString().replace(/\.\d{3}/, "")}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`,
        );
      }
      if (action === "GetCallerIdentity" && temp) {
        return new Response(
          `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:sts::${account}:assumed-role/${roleName}/orch</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`,
        );
      }
      return xmlError(400, "InvalidAction");
    }

    if (service === "ssm" && region === o.region) {
      const target = headers["x-amz-target"] ?? "";
      const action = target.startsWith("AmazonSSM.") ? target.slice("AmazonSSM.".length) : "";
      if (headers["content-type"] !== "application/x-amz-json-1.1") {
        return jsonError(415, "UnsupportedMediaType");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return invalid();
      }
      calls.push({ service, action, region, accessKeyId, body: parsed });
      // only the assumed role is allowed to touch parameters: the platform's own identity may not
      if (!temp || denied.has(action)) return jsonError(400, "AccessDeniedException");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid();
      return ssm(action, parsed as Record<string, unknown>);
    }
    return new Response("", { status: 404 });
  };

  return {
    fetch,
    /** The Parameter Store, by name. A test may put a parameter in or take one out "by hand". */
    params,
    calls,
    denied,
    /** Adds a parameter the platform did not make (no tags unless given). */
    seed(name: string, value: string, extra: Partial<FakeParameter> = {}) {
      params.set(name, { type: "String", value, tags: {}, version: 1, ...extra });
    },
  };
}
