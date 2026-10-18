import {
  type AwsConfig,
  type AwsCreds,
  type AwsDeps,
  assumeRole,
  reasonOfCode,
  signV4,
} from "./aws";
import { type CheckReason, CloudError, send } from "./http";

/**
 * A failed call of an AWS JSON API. Besides the reason it carries the error's name (`ParameterNotFound`),
 * a word the service defines; the message that goes with it is dropped, because AWS puts ARNs and
 * sometimes request fields in it.
 */
export class AwsApiError extends CloudError {
  constructor(
    readonly code: string,
    reason: CheckReason,
  ) {
    super(reason);
  }
}

/** A service that speaks JSON 1.1: its host and signing name, and the prefix of `X-Amz-Target`. */
export interface AwsJsonApi {
  service: string;
  target: string;
}

/** `__type` is `Name`, `ns#Name` or `Name:url`; only a plain word is believed. */
function codeOf(text: string): string {
  try {
    const type = (JSON.parse(text) as { __type?: unknown }).__type;
    if (typeof type !== "string") return "";
    const name = (type.split("#").pop() ?? "").split(":")[0] ?? "";
    return /^[A-Za-z]{1,64}$/.test(name) ? name : "";
  } catch {
    return "";
  }
}

/**
 * One signed call of an AWS JSON 1.1 API: POST to `<service>.<region>.amazonaws.com`, built from the
 * region and nothing a connection could point elsewhere. The answer is parsed JSON; a failure is an
 * {@link AwsApiError}.
 *
 * shortcut: no retry of a throttled or 5xx answer (a read of a prefix with thousands of parameters can
 * be throttled and fails the run); add backoff here when one does.
 */
export async function awsJson(
  d: AwsDeps,
  creds: AwsCreds,
  api: AwsJsonApi,
  region: string,
  action: string,
  body: unknown,
): Promise<unknown> {
  const url = `https://${api.service}.${region}.amazonaws.com/`;
  const payload = JSON.stringify(body);
  const headers = signV4({
    method: "POST",
    url,
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `${api.target}.${action}`,
    },
    body: payload,
    creds,
    region,
    service: api.service,
    now: (d.now ?? (() => new Date()))(),
  });
  const r = await send(d.fetch, url, { method: "POST", headers, body: payload }, d.timeoutMs);
  if (r.status !== 200) {
    const code = codeOf(r.text);
    throw new AwsApiError(code, reasonOfCode(r.status, code));
  }
  try {
    return r.text ? JSON.parse(r.text) : {};
  } catch {
    throw new CloudError("unexpected");
  }
}

/** Credentials this close to their end are not used: a call may take 10 s and the clocks differ. */
const REFRESH_BEFORE_MS = 60_000;

/**
 * The credentials of an assumed role, asked for when first needed and again once they are about to
 * lapse, so one sync run (which can outlast 15 minutes) never signs with expired keys. Callers that
 * arrive while the credentials are being asked for share that one request. They live in this closure only.
 */
export function assumedSession(
  d: AwsDeps,
  base: AwsCreds,
  role: AwsConfig & { externalId: string },
): () => Promise<AwsCreds> {
  const now = d.now ?? (() => new Date());
  let held: Promise<AwsCreds> | undefined;
  // while a request is in flight it counts as good, so that callers share it
  let goodUntil = 0;
  return () => {
    if (held && now().getTime() < goodUntil - REFRESH_BEFORE_MS) return held;
    goodUntil = Number.POSITIVE_INFINITY;
    const next: Promise<AwsCreds> = assumeRole(d, base, role).then(
      (creds) => {
        if (held === next) goodUntil = creds.expiresAt.getTime();
        return creds;
      },
      (e: unknown) => {
        if (held === next) held = undefined;
        throw e;
      },
    );
    held = next;
    return next;
  };
}
