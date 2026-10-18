import { z } from "zod";
import type { AwsCreds, AwsDeps } from "./aws";
import { AwsApiError, awsJson } from "./aws-json";
import { SM_API } from "./aws-sm";
import { type CheckReason, CloudError, reasonOf } from "./http";
import {
  type VaultConfig,
  type VaultDeps,
  vaultJson,
  vaultLogin,
  vaultRequest,
  vaultRevoke,
} from "./vault";

/**
 * A variable whose whole value is `vault://<connection>/<path>#<field>` or
 * `aws-sm://<connection>/<secret>[#<field>]` stands for a value that lives in a secret store: it is read
 * when a sync target is planned or applied and goes nowhere else (EXT-6). The connection is named by its
 * name in the organization; the path is under the connection's prefix.
 */

/** Words for why a reference could not be used. They name no value, path or server answer. */
export const REFERENCE_WHY = {
  malformed:
    "is not a valid reference (vault://<connection>/<path>#<field> or aws-sm://<connection>/<secret>[#<field>])",
  unknown_connection: "names a connection this organization does not have",
  wrong_connection: "names a connection of another type",
  not_enabled:
    "names a connection that does not allow references (its config needs references: true)",
  not_found: "points at a secret or field that is not there, or is empty",
  not_text: "points at something that is not text",
  too_large: "points at a value that is too large",
  denied: "points at something the connection's credential may not read",
  credential: "needs a connection whose credential was refused",
  unreachable: "could not be read: the secret store did not answer",
  unexpected: "could not be read: the secret store answered something unexpected",
} as const;
export type ReferenceReason = keyof typeof REFERENCE_WHY;

/** A reference that cannot be resolved. The reason is all it carries. */
export class ReferenceFailure extends Error {
  constructor(readonly reason: ReferenceReason) {
    super(reason);
    this.name = "ReferenceFailure";
  }
}

export type Reference =
  | { kind: "vault"; connection: string; path: string; field: string }
  | { kind: "aws-sm"; connection: string; secret: string; field?: string };

/** The longest value a reference may resolve to; a sync target takes less than this anyway. */
export const MAX_REFERENCE_VALUE = 256 * 1024;

/** Whether a value is meant as a reference. One that is and does not parse is an error, not a literal. */
export const isReference = (value: string) => /^(vault|aws-sm):\/\//.test(value);

const word = "[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}";
const connection = "([A-Za-z0-9._~%-]{1,300})";
const VAULT = new RegExp(`^vault://${connection}/(${word}(?:/${word}){0,7})#(${word})$`);
// a Secrets Manager name may start with a slash, which is written as a second one
const AWS = new RegExp(`^aws-sm://${connection}/([A-Za-z0-9/_+=.@-]{1,512})(?:#(${word}))?$`);

function connectionName(encoded: string | undefined) {
  try {
    const name = decodeURIComponent(encoded ?? "");
    if (name.length >= 1 && name.length <= 100) return name;
  } catch {
    // a bad escape is a malformed reference like any other
  }
  throw new ReferenceFailure("malformed");
}

export function parseReference(text: string): Reference {
  const v = VAULT.exec(text);
  if (v?.[2] && v[3]) {
    return { kind: "vault", connection: connectionName(v[1]), path: v[2], field: v[3] };
  }
  const a = AWS.exec(text);
  if (a?.[2]) {
    return {
      kind: "aws-sm",
      connection: connectionName(a[1]),
      secret: a[2],
      ...(a[3] === undefined ? {} : { field: a[3] }),
    };
  }
  throw new ReferenceFailure("malformed");
}

/**
 * Reads references from one store through one connection. It holds a credential for as long as it is
 * open: `close` lets it go and must be called when the caller is done, whatever happened.
 */
export interface ReferenceReader {
  read(ref: Reference): Promise<string>;
  close(): Promise<void>;
}

function whyOf(reason: CheckReason): ReferenceReason {
  switch (reason) {
    case "unauthorized":
    case "forbidden":
      return "denied";
    case "not_found":
      return "not_found";
    case "rate_limited":
    case "server":
    case "timeout":
    case "network":
      return "unreachable";
    default:
      return "unexpected";
  }
}

const failureOf = (e: unknown) =>
  e instanceof ReferenceFailure
    ? e
    : new ReferenceFailure(e instanceof CloudError ? whyOf(e.reason) : "unexpected");

/** A failure to get a credential: what the store says about the credential is the connection's, not the secret's. */
const credentialFailure = (e: unknown) =>
  e instanceof CloudError && ["unauthorized", "forbidden", "not_found"].includes(e.reason)
    ? new ReferenceFailure("credential")
    : failureOf(e);

/** The members of a JSON object in a Map, so that no field can be mistaken for `__proto__`. */
const membersOf = (v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? new Map(Object.entries(v)) : undefined;

/** Text, and not empty, and not larger than a value may be. */
function textOf(v: unknown) {
  if (v === undefined || v === "") throw new ReferenceFailure("not_found");
  if (typeof v !== "string") throw new ReferenceFailure("not_text");
  if (v.length > MAX_REFERENCE_VALUE) throw new ReferenceFailure("too_large");
  return v;
}

/**
 * Reads fields of KV v2 secrets under the connection's prefix. It logs in with the AppRole when the
 * first read needs it and keeps that token for the reads that follow; `close` revokes it.
 *
 * shortcut: the reads of one reader go at once, which a Vault with a low rate limit may refuse; serialise
 * them when one does.
 */
export function vaultReferenceReader(
  config: VaultConfig,
  secretId: string,
  d: VaultDeps,
): ReferenceReader {
  let login: Promise<string> | undefined;
  return {
    async read(ref) {
      if (ref.kind !== "vault") throw new ReferenceFailure("wrong_connection");
      login ??= vaultLogin(config, secretId, d).catch((e: unknown) => {
        throw credentialFailure(e);
      });
      const token = await login;
      let reply: Awaited<ReturnType<typeof vaultRequest>>;
      try {
        reply = await vaultRequest(
          config,
          d,
          "GET",
          `${config.kvMount}/data/${config.prefix}/${ref.path}`,
          undefined,
          token,
        );
      } catch (e) {
        throw failureOf(e);
      }
      if (reply.status !== 200) throw new ReferenceFailure(whyOf(reasonOf(reply.status)));
      const json = vaultJson(reply.text) as { data?: { data?: unknown } } | undefined;
      const fields = membersOf(json?.data?.data);
      if (!fields) throw new ReferenceFailure("unexpected");
      return textOf(fields.get(ref.field));
    },
    async close() {
      const token = await login?.catch(() => undefined);
      if (token) await vaultRevoke(config, token, d);
    },
  };
}

const secretSchema = z.object({ SecretString: z.string().optional() });

/**
 * Reads secrets of Secrets Manager by name (or a field of a JSON one) with the credentials of an
 * assumed role. The role's own policy decides what it may read.
 */
export function awsReferenceReader(
  config: { region: string },
  session: () => Promise<AwsCreds>,
  d: AwsDeps,
): ReferenceReader {
  return {
    async read(ref) {
      if (ref.kind !== "aws-sm") throw new ReferenceFailure("wrong_connection");
      let creds: AwsCreds;
      try {
        creds = await session();
      } catch (e) {
        throw credentialFailure(e);
      }
      let answer: unknown;
      try {
        answer = await awsJson(d, creds, SM_API, config.region, "GetSecretValue", {
          SecretId: ref.secret,
        });
      } catch (e) {
        if (e instanceof AwsApiError && e.code === "ResourceNotFoundException") {
          throw new ReferenceFailure("not_found");
        }
        throw failureOf(e);
      }
      const secret = secretSchema.safeParse(answer);
      if (!secret.success) throw new ReferenceFailure("unexpected");
      // a binary secret has no SecretString
      if (secret.data.SecretString === undefined) throw new ReferenceFailure("not_text");
      if (ref.field === undefined) return textOf(secret.data.SecretString);
      let parsed: unknown;
      try {
        parsed = JSON.parse(secret.data.SecretString);
      } catch {
        throw new ReferenceFailure("not_text");
      }
      const fields = membersOf(parsed);
      if (!fields) throw new ReferenceFailure("not_text");
      return textOf(fields.get(ref.field));
    },
    close: () => Promise.resolve(),
  };
}
