import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type SinkKind, takesNotifications } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { type Db, ForwardFailure, openSink } from "@orch/db";
import { z } from "zod";
import type { JobHandler } from "./worker";

/** A sink address that may not be used. The message says why, and never quotes the address: it can be a credential. */
export class SinkUrlError extends Error {
  override readonly name = "SinkUrlError";
}

/** Why a sink could not be reached, as a fixed sentence that is safe to store and show: it carries no address, no credential and nothing the sink said but its status. */
export class SinkFailure extends ForwardFailure {}

const MAX_URL = 2000;

/**
 * True for an address that is routable on the public internet: not this host, a private network,
 * link-local (the cloud metadata address), shared, documentation, multicast or reserved space.
 * IPv6 is allowed only inside global unicast (2000::/3), which leaves out mapped, unique-local and
 * link-local forms, minus the documentation, protocol-assignment (Teredo) and 6to4 blocks.
 */
export function publicAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a = 0, b = 0, c = 0] = v4.slice(1).map(Number);
    if (v4.slice(1).some((o) => Number(o) > 255)) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) !== 6) return false;
  const [first = "", second = ""] = ip.toLowerCase().split(":");
  const g1 = Number.parseInt(first, 16);
  const g2 = second === "" ? 0 : Number.parseInt(second, 16);
  if (Number.isNaN(g1) || g1 >> 13 !== 1) return false;
  // 6to4, IETF protocol assignments (2001::/23, Teredo among them), documentation (2001:db8::/32, 3fff::/20)
  return !(
    g1 === 0x2002 ||
    (g1 === 0x2001 && (g2 < 0x200 || g2 === 0xdb8)) ||
    (g1 === 0x3fff && g2 < 0x1000)
  );
}

export const bareHost = (u: URL) =>
  u.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();

/**
 * The address of a sink, checked: https (tls:// for syslog), no credentials in it, a public host, and
 * for Slack a hooks.slack.com/services address. This is what can be known without asking DNS;
 * delivery also checks what the name resolves to.
 */
export function sinkUrl(kind: SinkKind, raw: string): URL {
  if (raw.length > MAX_URL) throw new SinkUrlError("The address is too long");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SinkUrlError("The address is not a URL");
  }
  if (u.protocol !== (kind === "syslog" ? "tls:" : "https:")) {
    throw new SinkUrlError(`The address must use ${kind === "syslog" ? "tls" : "https"}`);
  }
  if (u.username !== "" || u.password !== "") {
    throw new SinkUrlError("The address must not carry a user name or password");
  }
  const host = bareHost(u);
  if (isIP(host)) {
    if (!publicAddress(host)) throw new SinkUrlError("The address must be public");
  } else if (!host.includes(".") || /(^|\.)(localhost|local|internal)$/.test(host)) {
    throw new SinkUrlError("The address must use a public host name");
  }
  if (kind === "slack" && (host !== "hooks.slack.com" || !u.pathname.startsWith("/services/"))) {
    throw new SinkUrlError("A Slack address must be a hooks.slack.com/services address");
  }
  return u;
}

/** What is sealed for a sink: where to deliver, and a webhook's signing secret. */
const sealedShape = z.object({ url: z.string(), secret: z.string().optional() });
export const sealSink = (s: { url: string; secret?: string | undefined }) => JSON.stringify(s);

/** A webhook's signing secret, shown once when the sink is made. */
export const newWebhookSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

const notificationBase = {
  sinkId: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string().max(200),
  at: z.iso.datetime(),
};
const notificationShape = z.discriminatedUnion("event", [
  z.object({
    ...notificationBase,
    event: z.literal("stack.drift"),
    stack: z.string().max(100),
    status: z.enum(["drifted", "clean"]),
    add: z.number().int().min(0),
    change: z.number().int().min(0),
    destroy: z.number().int().min(0),
  }),
  z.object({
    ...notificationBase,
    event: z.literal("rotation.failing"),
    key: z.string().max(200),
    provider: z.string().max(32),
    attempts: z.number().int().min(1),
  }),
]);
type Notification = z.infer<typeof notificationShape>;

// Slack reads <...> as a link or a mention and & as an entity.
const slackText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function slackMessage(n: Notification) {
  const project = `project *${slackText(n.projectName)}*`;
  if (n.event === "rotation.failing") {
    return {
      text: `:rotating_light: Rotation of *${slackText(n.key)}* (${slackText(n.provider)}) in ${project} has failed ${n.attempts} times; the old value is still in use`,
    };
  }
  const where = `stack *${slackText(n.stack)}* (${project})`;
  return {
    text:
      n.status === "drifted"
        ? `:warning: Drift in ${where}: ${n.add} to add, ${n.change} to change, ${n.destroy} to destroy`
        : `:white_check_mark: ${where[0]?.toUpperCase()}${where.slice(1)} is back in line with its code`,
  };
}

const webhookBody = (id: string, n: Notification) => {
  const head = {
    id,
    event: n.event,
    at: n.at,
    organizationId: n.organizationId,
    project: { id: n.projectId, name: n.projectName },
  };
  return n.event === "rotation.failing"
    ? { ...head, rotation: { key: n.key, provider: n.provider, attempts: n.attempts } }
    : {
        ...head,
        stack: n.stack,
        status: n.status,
        plan: { add: n.add, change: n.change, destroy: n.destroy },
      };
};

const resolveAll = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface NotifyDeps {
  db: Db;
  keys: KeyProvider;
  /** Test seams: the network and the name service. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  resolve?: (host: string) => Promise<string[]>;
  now?: () => Date;
  timeoutMs?: number;
}

/** A sink opened: its kind, where it delivers to, and the secret or credential sealed with it. */
export async function openSealed(
  db: Db,
  keys: KeyProvider,
  organizationId: string,
  sinkId: string,
) {
  const opened = await openSink(db, keys, organizationId, sinkId);
  if (!opened) return undefined;
  const sealed = sealedShape.safeParse(safeJson(opened.secret));
  if (!sealed.success) throw new SinkFailure("sink is not readable");
  return { kind: opened.sink.kind, ...sealed.data };
}

/**
 * Where a sink delivers to, checked: the address is allowed and every address its name resolves to
 * is public. Throws a `SinkFailure` otherwise.
 */
export async function checkTarget(
  kind: SinkKind,
  raw: string,
  resolve: (host: string) => Promise<string[]> = resolveAll,
) {
  let target: URL;
  try {
    target = sinkUrl(kind, raw);
  } catch {
    throw new SinkFailure("sink address is not allowed");
  }
  const host = bareHost(target);
  let addresses = [host];
  if (!isIP(host)) {
    try {
      addresses = await resolve(host);
    } catch {
      throw new SinkFailure("sink could not be reached");
    }
  }
  if (addresses.length === 0 || !addresses.every(publicAddress)) {
    throw new SinkFailure("sink address is not allowed");
  }
  return { target, addresses };
}

/** POSTs to a checked address and returns the status of a 2xx answer; anything else is a `SinkFailure`. */
export async function post(
  d: Pick<NotifyDeps, "fetch" | "timeoutMs">,
  target: URL,
  o: { headers: Record<string, string>; body: string; signal: AbortSignal },
) {
  let res: Response;
  try {
    res = await (d.fetch ?? fetch)(target.href, {
      method: "POST",
      headers: o.headers,
      body: o.body,
      // a redirect could lead somewhere the checks above did not look at
      redirect: "manual",
      signal: AbortSignal.any([o.signal, AbortSignal.timeout(d.timeoutMs ?? 10_000)]),
    });
  } catch {
    throw new SinkFailure("sink could not be reached");
  }
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new SinkFailure(`sink answered ${res.status}`);
  return res.status;
}

/**
 * Delivers one notification (POL-2): reads the sink's address (and a webhook's secret) from the
 * vault, checks that it still points at the public internet, and posts. Resolve is delivery, throw
 * is a retry with backoff until the attempts run out and the job is dead. Every error thrown here
 * is a fixed sentence: the address and the secret never reach a log or `last_error`.
 *
 * shortcut: the name is resolved and checked, then the fetch resolves it again, so a DNS answer that
 * changes between the two (rebinding) gets through; pin the checked address when the control plane
 * can reach anything worth protecting from a hostile sink.
 */
export const notifyDeliverHandler =
  (d: NotifyDeps): JobHandler =>
  async (ctx) => {
    const parsed = notificationShape.safeParse(ctx.payload);
    if (!parsed.success) throw new Error("job is not a notification");
    const n = parsed.data;
    const sink = await openSealed(d.db, d.keys, n.organizationId, n.sinkId);
    if (!sink) {
      ctx.log.info("sink is gone; nothing to deliver", { sink_id: n.sinkId });
      return;
    }
    const { kind } = sink;
    // a sink made for the audit log has no business here
    if (!takesNotifications(kind)) {
      throw new SinkFailure("sink cannot take notifications");
    }
    const { target } = await checkTarget(kind, sink.url, d.resolve);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "orch-notifications",
    };
    let body: string;
    if (kind === "slack") body = JSON.stringify(slackMessage(n));
    else {
      if (sink.secret === undefined) throw new SinkFailure("sink is not readable");
      body = JSON.stringify(webhookBody(ctx.id, n));
      const timestamp = String(Math.floor((d.now?.() ?? new Date()).getTime() / 1000));
      headers["x-orch-event"] = n.event;
      headers["x-orch-delivery"] = ctx.id;
      headers["x-orch-timestamp"] = timestamp;
      headers["x-orch-signature"] = signature(sink.secret, timestamp, body);
    }
    const status = await post(d, target, { headers, body, signal: ctx.signal });
    ctx.log.info("notification delivered", { sink_id: n.sinkId, status });
  };

/** The `x-orch-signature` of a webhook body: `v1=` and the HMAC-SHA256 of `${timestamp}.${body}` under the sink's secret. */
export const signature = (secret: string, timestamp: string, body: string) =>
  `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
