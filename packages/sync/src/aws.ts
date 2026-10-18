import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import {
  type Check,
  type CheckReason,
  CloudError,
  type Fetch,
  failure,
  reasonOf,
  send,
} from "./http";

/** The connection type, as `connections.type` stores it. */
export const AWS_ASSUME_ROLE = "aws_assume_role";

/** Short-lived or restricted keys: what the platform signs with, and what a role it assumed hands back. */
export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

/**
 * The platform's own AWS identity, from the standard variables. It needs one permission, to assume the
 * roles that connections name; everything else comes from a role the target's owner controls.
 *
 * shortcut: static variables only, so the identity does not refresh itself; an instance profile, ECS
 * or IRSA provider chain is the upgrade when the platform runs where those exist.
 */
export function awsFromEnv(env: z.infer<typeof awsEnv>): AwsCreds | undefined {
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = env.AWS_SESSION_TOKEN;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

/** The platform's own AWS identity, as the environment names it (see `awsFromEnv`). */
export const awsEnv = z.object({
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_SESSION_TOKEN: z.string().optional(),
});

/**
 * What a connection of type `aws_assume_role` says in the open. The endpoint is not here: the client
 * builds `sts.<region>.amazonaws.com` itself, so a connection cannot make the platform sign a request
 * to a host of its choosing.
 *
 * shortcut: the commercial `aws` partition only; China and GovCloud need another endpoint domain.
 */
export const awsConfigSchema = z.strictObject({
  roleArn: z
    .string()
    .regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/, "must be an IAM role ARN"),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, "must be an AWS region such as eu-west-1"),
  /** Lets variables point at secrets this role can read (`aws-sm://<name>/…`); off unless set (EXT-6). */
  references: z.boolean().optional(),
});
export type AwsConfig = z.infer<typeof awsConfigSchema>;

/**
 * The secret of the connection: the role's external ID, which the role's trust policy demands, so that
 * a role named by one customer cannot be assumed on another's behalf. Long enough that it is not guessed.
 */
export const externalIdSchema = z
  .string()
  .min(16)
  .max(1224)
  .regex(/^[\w+=,.@:/-]+$/, "must be an AWS external ID: letters, digits and _+=,.@:/-");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();
// RFC 3986: encodeURIComponent leaves !'()* alone
const encode = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Signature Version 4: the headers to send (the given ones, lower-cased, plus `x-amz-date`, the session
 * token and `authorization`). `host` is signed and not returned: fetch sets it.
 *
 * shortcut: the path must be `/` (every call these clients make is a POST to the root); a longer path
 * needs the double encoding non-S3 services expect.
 */
export function signV4(r: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  creds: AwsCreds;
  region: string;
  service: string;
  now: Date;
}): Record<string, string> {
  const url = new URL(r.url);
  if (url.pathname !== "/") throw new TypeError("signV4 signs requests to / only");
  const stamp = r.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);
  const sent: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) sent[k.toLowerCase()] = v.trim();
  sent["x-amz-date"] = stamp;
  if (r.creds.sessionToken) sent["x-amz-security-token"] = r.creds.sessionToken;
  const signable: Record<string, string> = { ...sent, host: url.host };
  const names = Object.keys(signable).sort();
  const query = [...url.searchParams]
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .sort()
    .join("&");
  const canonical = [
    r.method,
    "/",
    query,
    ...names.map((n) => `${n}:${signable[n]}`),
    "",
    names.join(";"),
    sha256(r.body),
  ].join("\n");
  const scope = `${day}/${r.region}/${r.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${r.creds.secretAccessKey}`, day), r.region), r.service),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${r.creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

export interface AwsDeps {
  fetch: Fetch;
  now?: (() => Date) | undefined;
  timeoutMs?: number | undefined;
}

const CREDENTIAL_ERRORS =
  /InvalidClientTokenId|SignatureDoesNotMatch|InvalidSignature|Expired|UnrecognizedClient|MissingAuthentication|IncompleteSignature/;
const THROTTLED = /Throttl|RequestLimitExceeded|TooManyRequests|TooManyUpdates/;
// the JSON APIs answer a refusal with a 400, so the status alone would call it `invalid`
const REFUSED = /AccessDenied|UnauthorizedOperation|NotAuthorized/;

/** AWS names the failure; the status alone cannot tell a bad key from a refused role. */
export function reasonOfCode(status: number, code: string): CheckReason {
  if (CREDENTIAL_ERRORS.test(code)) return "unauthorized";
  if (THROTTLED.test(code)) return "rate_limited";
  if (REFUSED.test(code)) return "forbidden";
  return reasonOf(status);
}

const reasonOfAws = (status: number, text: string) =>
  reasonOfCode(status, /<Code>([A-Za-z]+)<\/Code>/.exec(text)?.[1] ?? "");

/** One call of the STS query API, signed, and the text of a 200 answer. */
async function sts(
  d: AwsDeps,
  creds: AwsCreds,
  region: string,
  params: Record<string, string>,
): Promise<string> {
  const url = `https://sts.${region}.amazonaws.com/`;
  const body = new URLSearchParams({ Version: "2011-06-15", ...params }).toString();
  const headers = signV4({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body,
    creds,
    region,
    service: "sts",
    now: (d.now ?? (() => new Date()))(),
  });
  const r = await send(d.fetch, url, { method: "POST", headers, body }, d.timeoutMs);
  if (r.status !== 200) throw new CloudError(reasonOfAws(r.status, r.text));
  return r.text;
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1];

/**
 * Becomes the role: credentials for 15 minutes (the least STS gives), made by the platform's identity
 * and the external ID. Nothing is kept; each use asks again.
 */
export async function assumeRole(
  d: AwsDeps,
  base: AwsCreds,
  o: AwsConfig & { externalId: string },
): Promise<Required<AwsCreds> & { expiresAt: Date }> {
  const xml = await sts(d, base, o.region, {
    Action: "AssumeRole",
    RoleArn: o.roleArn,
    RoleSessionName: "orch",
    ExternalId: o.externalId,
    DurationSeconds: "900",
  });
  const accessKeyId = tag(xml, "AccessKeyId");
  const secretAccessKey = tag(xml, "SecretAccessKey");
  const sessionToken = tag(xml, "SessionToken");
  const expiresAt = new Date(tag(xml, "Expiration") ?? Number.NaN);
  if (!accessKeyId || !secretAccessKey || !sessionToken || Number.isNaN(expiresAt.getTime())) {
    throw new CloudError("unexpected");
  }
  return { accessKeyId, secretAccessKey, sessionToken, expiresAt };
}

const ASSUMED = /^arn:aws:sts::\d{12}:assumed-role\/[\w+=,.@/-]+$/;

const WHY = {
  unauthorized:
    "rejected the platform's own identity: ask the operator to check its AWS credentials",
  forbidden:
    "refused to let the platform assume the role: check the role ARN, its trust policy and the external ID",
  invalid: "did not accept the request: check the role ARN and the region",
} as const;

/**
 * The connection test: assumes the role, then asks STS who it became (a call every identity may make),
 * which proves the trust policy and the external ID without touching a single resource. The answer is
 * fixed words and the assumed role's ARN; what AWS said, the keys and the external ID go no further.
 */
export async function checkAwsAssumeRole(
  config: AwsConfig,
  externalId: string,
  d: AwsDeps & { base: AwsCreds },
): Promise<Check> {
  try {
    const creds = await assumeRole(d, d.base, { ...config, externalId });
    // the role was just assumed: a refusal now is not the platform identity's fault, so it is not blamed
    const who = await sts(d, creds, config.region, { Action: "GetCallerIdentity" }).catch((e) => {
      throw e instanceof CloudError && (e.reason === "unauthorized" || e.reason === "forbidden")
        ? new CloudError("unexpected")
        : e;
    });
    const arn = tag(who, "Arn");
    if (!arn || !ASSUMED.test(arn)) return failure("AWS", "unexpected");
    return { ok: true, summary: `Assumed ${arn}` };
  } catch (e) {
    if (e instanceof CloudError) return failure("AWS", e.reason, WHY);
    throw e;
  }
}
