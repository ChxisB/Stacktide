import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { takesAudit } from "@orch/core";
import { type AuditRow, dueForwards, FORWARD_BATCH, type Forwarding, forwardStep } from "@orch/db";
import { auditFields } from "./audit-export";
import {
  bareHost,
  checkTarget,
  type NotifyDeps,
  openSealed,
  post,
  SinkFailure,
  signature,
} from "./notify";
import type { JobHandler } from "./worker";

/** Sinks looked at in one run, and hand-overs to one sink in one run: a sink far behind is worked off over several runs, not in one long one. */
export const FORWARD_SINKS = 50;
export const FORWARD_ROUNDS = 20;

const SYSLOG_PORT = 6514;

/** One framed syslog message per event (RFC 5425 over TLS): "<octets> <message>", the length counted in bytes. */
export interface SyslogDelivery {
  address: string;
  port: number;
  /** The name the certificate must carry; absent when the address was written as an IP. */
  servername: string | undefined;
  payload: Buffer;
  signal: AbortSignal;
}

export interface ForwardDeps
  extends Pick<NotifyDeps, "db" | "keys" | "fetch" | "resolve" | "now" | "timeoutMs"> {
  settleMs?: number;
  /** Test seam: the syslog connection. */
  connect?: (d: SyslogDelivery) => Promise<void>;
}

/**
 * Opens a TLS connection to the checked address (not the name, so the address that was checked is the
 * address that is used), writes the frames and ends. Done when the data has left this process.
 *
 * shortcut: no acknowledgement exists in syslog over TLS, so a server that accepts the connection and
 * then drops the data is not noticed; use a collector with an HTTP interface where that matters.
 */
const tlsDelivery = (d: SyslogDelivery) =>
  new Promise<void>((resolve, reject) => {
    const fail = () => reject(new SinkFailure("sink could not be reached"));
    const socket = tlsConnect({ host: d.address, port: d.port, servername: d.servername }, () =>
      socket.end(d.payload, () => resolve()),
    );
    socket.setTimeout(10_000, () => socket.destroy());
    socket.once("error", fail);
    // a connection that closes before the data has been written never answers; the timeout above covers a stall
    socket.once("close", fail);
    d.signal.addEventListener("abort", () => socket.destroy(), { once: true });
  });

/** RFC 5424: facility 13 (log audit), severity 6 (informational), the action as the message id, the event as JSON. */
function syslogFrame(r: AuditRow) {
  const msg = `<110>1 ${r.at.toISOString()} orch orch - ${r.action.slice(0, 32)} - ${JSON.stringify(auditFields(r))}`;
  return `${Buffer.byteLength(msg)} ${msg}`;
}

/** The source and tags a collector files an event under. */
const SOURCE = "orch";

function render(kind: "webhook" | "datadog" | "splunk", events: AuditRow[]) {
  const records = events.map(auditFields);
  if (kind === "webhook") return JSON.stringify({ events: records });
  if (kind === "datadog") {
    return JSON.stringify(
      records.map((r) => ({
        ddsource: SOURCE,
        ddtags: `organization:${r.organizationId}`,
        service: SOURCE,
        hostname: SOURCE,
        message: JSON.stringify(r),
      })),
    );
  }
  // Splunk's collector takes events one after another; time is in seconds, with milliseconds
  return events
    .map((e, i) =>
      JSON.stringify({
        time: e.at.getTime() / 1000,
        host: SOURCE,
        source: SOURCE,
        sourcetype: "_json",
        event: records[i],
      }),
    )
    .join("\n");
}

/** Hands one batch to the sink: throws a `SinkFailure` (a fixed sentence) when it did not take it. */
async function deliver(d: ForwardDeps, signal: AbortSignal, f: Forwarding, events: AuditRow[]) {
  const sink = await openSealed(d.db, d.keys, f.organizationId, f.sinkId);
  if (!sink) throw new SinkFailure("sink is not readable");
  const { kind } = sink;
  if (!takesAudit(kind)) throw new SinkFailure("sink cannot take the audit log");
  const { target, addresses } = await checkTarget(kind, sink.url, d.resolve);

  if (kind === "syslog") {
    const host = bareHost(target);
    const payload = Buffer.from(events.map(syslogFrame).join(""));
    let failure: unknown;
    // shortcut: at most three of the name's addresses are tried per batch, each for up to the timeout; raise it for a collector with more records
    for (const address of addresses.slice(0, 3)) {
      if (signal.aborted) break;
      try {
        await (d.connect ?? tlsDelivery)({
          address,
          port: Number(target.port || SYSLOG_PORT),
          servername: isIP(host) ? undefined : host,
          payload,
          signal: AbortSignal.any([signal, AbortSignal.timeout(d.timeoutMs ?? 10_000)]),
        });
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure ?? new SinkFailure("sink could not be reached");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "orch-audit-forwarding",
  };
  // the kinds that carry a credential need it; the sealed secret is that credential
  if (sink.secret === undefined) throw new SinkFailure("sink is not readable");
  const body = render(kind, events);
  if (kind === "datadog") headers["dd-api-key"] = sink.secret;
  else if (kind === "splunk") headers.authorization = `Splunk ${sink.secret}`;
  else {
    const timestamp = String(Math.floor((d.now?.() ?? new Date()).getTime() / 1000));
    headers["x-orch-event"] = "audit.events";
    headers["x-orch-delivery"] = `${f.sinkId}:${events.at(-1)?.id}`;
    headers["x-orch-timestamp"] = timestamp;
    headers["x-orch-signature"] = signature(sink.secret, timestamp, body);
  }
  await post(d, target, { headers, body, signal });
}

/**
 * The `audit.forward` schedule's job (GOV-4): for each sink whose turn it is, hands the organization's
 * audit events after its cursor to the sink, a batch at a time, until the log is caught up, the sink
 * fails (it is tried again after a backoff) or this run has done its share. The cursor moves only when
 * the sink took the batch, so delivery is at least once and a receiver dedupes by event id. Opening a
 * sink needs the master keys, so this is registered only where the worker has them.
 *
 * shortcut: the HTTP kinds resolve the name again when they connect, so a DNS answer that changes
 * between the check and the connection (rebinding) gets through; syslog connects to the checked address.
 */
export const auditForwardHandler =
  (d: ForwardDeps): JobHandler =>
  async (ctx) => {
    // read again for every hand-over: a long run must not date a failure from its start
    const clock = d.now ?? (() => new Date());
    for (const sinkId of await dueForwards(d.db, clock(), FORWARD_SINKS)) {
      for (let round = 0; round < FORWARD_ROUNDS && !ctx.signal.aborted; round++) {
        const step = await forwardStep(d.db, {
          sinkId,
          now: clock(),
          ...(d.settleMs === undefined ? {} : { settleMs: d.settleMs }),
          send: (f, events) => deliver(d, ctx.signal, f, events),
        });
        if (step.result === "failed") ctx.log.warn("audit forwarding failed", { sink_id: sinkId });
        if (step.result !== "sent") break;
        ctx.log.info("audit events forwarded", { sink_id: sinkId, count: step.count });
        if (step.count < FORWARD_BATCH) break;
      }
    }
  };
