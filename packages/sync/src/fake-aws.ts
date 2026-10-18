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
  /** The most one DescribeParameters or ListSecrets page holds (50 and 100 at most, as AWS), to make a client follow the token. */
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

export interface FakeSecret {
  /** Oldest first. Each version carries the staging labels it holds; one holds `AWSCURRENT`. */
  versions: { id: string; token: string; value: string; stages: string[] }[];
  tags: Record<string, string>;
  kmsKeyId?: string;
  /** Set once DeleteSecret scheduled it for deletion: the secret can no longer be read or changed. */
  deletedAt?: Date;
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
 * AWS as far as the sync clients use it, as a `fetch`: STS (AssumeRole, GetCallerIdentity), SSM
 * Parameter Store and Secrets Manager, written from the services' documentation, not from a recording. It checks what a
 * real endpoint checks of a request: the host names the region, the signature is the one the caller's
 * secret makes (re-signed here, so a header changed after signing is caught), the session token goes
 * with the key, assumed credentials expire after 900 s, and SSM refuses what the service refuses (names,
 * sizes, `Tags` with `Overwrite`, a value that looks like `{{ref}}`), and Secrets Manager refuses what it
 * refuses (names, sizes, tags, a name that is waiting to be deleted) and keeps versions and staging labels.
 *
 * shortcut: standard-tier parameters only, no versions or labels, no KMS (a SecureString is stored
 * readable and handed out only to `WithDecryption`); secrets are text (no binary), found by name and
 * never by ARN, and a scheduled deletion never completes; add them when an adapter needs them.
 */
export function fakeAws(o: FakeAwsOptions) {
  const now = o.now ?? (() => new Date());
  const params = new Map<string, FakeParameter>();
  const secrets = new Map<string, FakeSecret>();
  let versionsMade = 0;
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

  const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;
  const TOKEN = /^[\w-]{32,64}$/;
  const arnOf = (name: string) =>
    `arn:aws:secretsmanager:${o.region}:${account}:secret:${name}-Ab12Cd`;

  function secretTags(raw: unknown): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    if (raw === undefined) return out;
    if (!Array.isArray(raw)) return undefined;
    for (const t of raw) {
      const { Key: k, Value: v } = t as { Key?: unknown; Value?: unknown };
      if (typeof k !== "string" || typeof v !== "string") return undefined;
      if (!/^[\w .:/=+@-]{1,128}$/.test(k) || /^aws:/i.test(k) || v.length > 256) return undefined;
      if (k in out) return undefined;
      out[k] = v;
    }
    return out;
  }
  const secretText = (v: unknown) =>
    typeof v === "string" && Buffer.byteLength(v) >= 1 && Buffer.byteLength(v) <= 65536;
  const current = (s: FakeSecret) => s.versions.find((v) => v.stages.includes("AWSCURRENT"));
  const entryOf = (name: string, s: FakeSecret) => ({
    ARN: arnOf(name),
    Name: name,
    ...(Object.keys(s.tags).length
      ? { Tags: Object.entries(s.tags).map(([Key, Value]) => ({ Key, Value })) }
      : {}),
    ...(s.deletedAt ? { DeletedDate: s.deletedAt.getTime() / 1000 } : {}),
  });
  /** The secret a request names, or the answer that says it cannot be had. */
  function target(
    b: Record<string, unknown>,
    allowDeleted = false,
  ): [string, FakeSecret] | Response {
    const name = b.SecretId;
    if (typeof name !== "string" || name === "") return invalid();
    const s = secrets.get(name);
    if (!s) return jsonError(400, "ResourceNotFoundException");
    // as the service: a secret waiting to be deleted can be described and restored, nothing else
    if (s.deletedAt && !allowDeleted) return jsonError(400, "InvalidRequestException");
    return [name, s];
  }
  function addVersion(s: FakeSecret, value: string, token: unknown, stages: string[]) {
    if (token !== undefined && (typeof token !== "string" || !TOKEN.test(token))) return invalid();
    const seen = token === undefined ? undefined : s.versions.find((v) => v.token === token);
    // the same token with the same value is the same request again; with another value it is a clash
    if (seen) return seen.value === value ? seen : jsonError(400, "ResourceExistsException");
    versionsMade += 1;
    if (stages.includes("AWSCURRENT")) {
      for (const v of s.versions) {
        v.stages = v.stages.filter((x) => x !== "AWSPREVIOUS");
        if (v.stages.includes("AWSCURRENT")) {
          v.stages = [...v.stages.filter((x) => x !== "AWSCURRENT"), "AWSPREVIOUS"];
        }
      }
    }
    const made = {
      id: `00000000-0000-4000-8000-${String(versionsMade).padStart(12, "0")}`,
      token: typeof token === "string" ? token : `auto-${versionsMade}`,
      value,
      stages,
    };
    s.versions.push(made);
    return made;
  }

  function secretsManager(action: string, b: Record<string, unknown>): Response {
    switch (action) {
      case "CreateSecret": {
        const name = b.Name;
        if (typeof name !== "string" || !SECRET_NAME.test(name) || !secretText(b.SecretString)) {
          return invalid();
        }
        const tags = secretTags(b.Tags);
        if (!tags || Object.keys(tags).length > 50) return invalid();
        if (b.KmsKeyId !== undefined && typeof b.KmsKeyId !== "string") return invalid();
        const there = secrets.get(name);
        if (there) {
          return jsonError(
            400,
            there.deletedAt ? "InvalidRequestException" : "ResourceExistsException",
          );
        }
        const s: FakeSecret = {
          versions: [],
          tags,
          ...(typeof b.KmsKeyId === "string" ? { kmsKeyId: b.KmsKeyId } : {}),
        };
        const v = addVersion(s, b.SecretString as string, b.ClientRequestToken, ["AWSCURRENT"]);
        if (v instanceof Response) return v;
        secrets.set(name, s);
        return Response.json({ ARN: arnOf(name), Name: name, VersionId: v.id });
      }
      case "PutSecretValue": {
        const t = target(b);
        if (t instanceof Response) return t;
        if (!secretText(b.SecretString)) return invalid();
        const stages = b.VersionStages === undefined ? ["AWSCURRENT"] : b.VersionStages;
        if (!Array.isArray(stages) || stages.some((x) => typeof x !== "string")) return invalid();
        const v = addVersion(
          t[1],
          b.SecretString as string,
          b.ClientRequestToken,
          stages as string[],
        );
        if (v instanceof Response) return v;
        return Response.json({
          ARN: arnOf(t[0]),
          Name: t[0],
          VersionId: v.id,
          VersionStages: v.stages,
        });
      }
      case "GetSecretValue": {
        const t = target(b);
        if (t instanceof Response) return t;
        const stage = b.VersionStage ?? "AWSCURRENT";
        if (typeof stage !== "string") return invalid();
        const v = t[1].versions.find((x) => x.stages.includes(stage));
        if (!v) return jsonError(400, "ResourceNotFoundException");
        return Response.json({
          ARN: arnOf(t[0]),
          Name: t[0],
          VersionId: v.id,
          SecretString: v.value,
          VersionStages: v.stages,
        });
      }
      case "DescribeSecret": {
        const t = target(b, true);
        if (t instanceof Response) return t;
        return Response.json(entryOf(...t));
      }
      case "ListSecrets": {
        const max = b.MaxResults ?? 100;
        if (typeof max !== "number" || max < 1 || max > 100) return invalid();
        const filters = Array.isArray(b.Filters) ? b.Filters : [];
        let names = [...secrets.keys()].filter(
          (n) => b.IncludePlannedDeletion === true || !secrets.get(n)?.deletedAt,
        );
        for (const f of filters as { Key?: unknown; Values?: unknown }[]) {
          const values = Array.isArray(f.Values) ? (f.Values as string[]) : [];
          if (values.length < 1) return invalid();
          // every filter is a prefix match, and the tag filters are independent of each other
          const some = (xs: string[]) => xs.some((x) => values.some((v) => x.startsWith(v)));
          if (f.Key === "name") names = names.filter((n) => some([n]));
          else if (f.Key === "tag-key") {
            names = names.filter((n) => some(Object.keys(secrets.get(n)?.tags ?? {})));
          } else if (f.Key === "tag-value") {
            names = names.filter((n) => some(Object.values(secrets.get(n)?.tags ?? {})));
          } else return invalid();
        }
        // no order is promised: a client that relies on one is caught by this one
        names.sort().reverse();
        const size = Math.min(max, o.pageSize ?? 100);
        let from = 0;
        if (b.NextToken !== undefined) {
          const m = /^page-(\d+)$/.exec(String(b.NextToken));
          if (!m) return jsonError(400, "InvalidNextTokenException");
          from = Number(m[1]);
        }
        return Response.json({
          SecretList: names.slice(from, from + size).map((n) => {
            const s = secrets.get(n);
            return s ? entryOf(n, s) : {};
          }),
          ...(from + size < names.length ? { NextToken: `page-${from + size}` } : {}),
        });
      }
      case "TagResource": {
        const t = target(b);
        if (t instanceof Response) return t;
        const tags = secretTags(b.Tags);
        if (!tags || Object.keys(tags).length < 1) return invalid();
        const merged = { ...t[1].tags, ...tags };
        if (Object.keys(merged).length > 50) return jsonError(400, "LimitExceededException");
        t[1].tags = merged;
        return Response.json({});
      }
      case "UntagResource": {
        const t = target(b);
        if (t instanceof Response) return t;
        const keys = b.TagKeys;
        if (!Array.isArray(keys) || keys.length < 1 || keys.some((k) => typeof k !== "string")) {
          return invalid();
        }
        t[1].tags = Object.fromEntries(
          Object.entries(t[1].tags).filter(([k]) => !keys.includes(k)),
        );
        return Response.json({});
      }
      case "RestoreSecret": {
        const t = target(b, true);
        if (t instanceof Response) return t;
        delete t[1].deletedAt;
        return Response.json({ ARN: arnOf(t[0]), Name: t[0] });
      }
      case "DeleteSecret": {
        const t = target(b, true);
        if (t instanceof Response) return t;
        const days = b.RecoveryWindowInDays ?? 30;
        const force = b.ForceDeleteWithoutRecovery === true;
        if (typeof days !== "number" || !Number.isInteger(days) || days < 7 || days > 30) {
          return invalid();
        }
        // "you can't use both"
        if (force && b.RecoveryWindowInDays !== undefined) return invalid();
        if (force) secrets.delete(t[0]);
        else t[1].deletedAt = t[1].deletedAt ?? new Date(now().getTime() + days * 86_400_000);
        return Response.json({
          ARN: arnOf(t[0]),
          Name: t[0],
          DeletionDate: (t[1].deletedAt ?? now()).getTime() / 1000,
        });
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

    if ((service === "ssm" || service === "secretsmanager") && region === o.region) {
      const prefix = service === "ssm" ? "AmazonSSM." : "secretsmanager.";
      const named = headers["x-amz-target"] ?? "";
      const action = named.startsWith(prefix) ? named.slice(prefix.length) : "";
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
      // only the assumed role is allowed to touch parameters and secrets: the platform's own identity may not
      if (!temp || denied.has(action)) return jsonError(400, "AccessDeniedException");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalid();
      const args = parsed as Record<string, unknown>;
      return service === "ssm" ? ssm(action, args) : secretsManager(action, args);
    }
    return new Response("", { status: 404 });
  };

  return {
    fetch,
    /** The Parameter Store, by name. A test may put a parameter in or take one out "by hand". */
    params,
    /** Secrets Manager, by name. */
    secrets,
    /** What the secret holds now (its `AWSCURRENT` version), or undefined when there is none. */
    secretValue: (name: string) => {
      const s = secrets.get(name);
      return s && current(s)?.value;
    },
    /** Adds a secret the platform did not make (no tags unless given). */
    seedSecret(name: string, value: string, tags: Record<string, string> = {}) {
      versionsMade += 1;
      secrets.set(name, {
        tags,
        versions: [
          {
            id: `seed-${versionsMade}`,
            token: `seed-${versionsMade}`,
            value,
            stages: ["AWSCURRENT"],
          },
        ],
      });
    },
    calls,
    denied,
    /** Adds a parameter the platform did not make (no tags unless given). */
    seed(name: string, value: string, extra: Partial<FakeParameter> = {}) {
      params.set(name, { type: "String", value, tags: {}, version: 1, ...extra });
    },
  };
}
