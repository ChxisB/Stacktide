import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createLogger, type SinkKind } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  auditForwards,
  createOrganization,
  createSink,
  enableForwarding,
  FORWARD_BATCH,
  getForwarding,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { auditForwardHandler, type SyslogDelivery } from "./audit-forward";
import { sealSink } from "./notify";
import type { JobContext } from "./worker";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
// the handler works every due sink there is, so one test's sinks must not be there for the next
beforeEach(async () => {
  await t.db.delete(auditForwards);
  logs.length = 0;
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const PUBLIC = ["93.184.216.34"];

const logs: string[] = [];
const logger = createLogger({ write: (l) => logs.push(l), level: "debug" });
const ctx = (signal = new AbortController().signal): JobContext => ({
  id: "0198d6f0-0000-7000-8000-000000000001",
  queue: "audit.forward",
  payload: {},
  attempt: 1,
  maxAttempts: 1,
  log: logger,
  signal,
});

interface Sent {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: string;
}
type Answer = Response | Error;
function fakeFetch(answer: (n: number) => Answer = () => new Response("ok")) {
  const sent: Sent[] = [];
  const fn = async (url: string, init: RequestInit) => {
    sent.push({
      url,
      init,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: String(init.body),
    });
    const a = answer(sent.length);
    if (a instanceof Error) throw a;
    return a;
  };
  return { sent, fn };
}

const v7 = (ms: number, tail: number) => {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-${tail.toString(16).padStart(12, "0")}`;
};
let seq = 1;
const newEvent = (
  org: string,
  seconds: number,
  over: Partial<typeof auditEvents.$inferInsert> = {},
) => ({
  id: v7(T0 + seconds * 1000, seq++),
  at: new Date(T0 + seconds * 1000),
  organizationId: org,
  actorKind: "user",
  actorId: "u1",
  action: "variable.update",
  resourceType: "variable",
  ...over,
});
async function events(
  org: string,
  seconds: number[],
  over: Partial<typeof auditEvents.$inferInsert> = {},
) {
  const rows = seconds.map((s) => newEvent(org, s, over));
  await t.db.insert(auditEvents).values(rows);
  return rows.map((r) => r.id).sort();
}

let n = 0;
async function world(
  kind: SinkKind,
  o: { url?: string; secret?: string; sealed?: string; from?: "now" | "start" } = {},
) {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const url =
    o.url ?? (kind === "syslog" ? "tls://logs.example.com:6514" : "https://logs.example.com/in");
  const sink = await createSink(t.db, keys, {
    organizationId: org.id,
    kind,
    name: `s${++n}`,
    host: new URL(url).host,
    secret: o.sealed ?? sealSink({ url, secret: o.secret }),
  });
  await enableForwarding(t.db, {
    organizationId: org.id,
    sinkId: sink.id,
    from: o.from ?? "start",
    now: at(0),
  });
  return { org: org.id, sink: sink.id };
}
const state = (w: { org: string; sink: string }) => getForwarding(t.db, w.org, w.sink);

function tick(
  now: Date,
  d: {
    fetch?: ReturnType<typeof fakeFetch>["fn"];
    resolve?: (host: string) => Promise<string[]>;
    connect?: (d: SyslogDelivery) => Promise<void>;
    signal?: AbortSignal;
  } = {},
) {
  return auditForwardHandler({
    db: t.db,
    keys,
    now: () => now,
    resolve: d.resolve ?? (async () => PUBLIC),
    ...(d.fetch ? { fetch: d.fetch } : {}),
    ...(d.connect ? { connect: d.connect } : {}),
  })(ctx(d.signal));
}
const idsIn = (body: string) =>
  (JSON.parse(body) as { events: { id: string }[] }).events.map((e) => e.id);

describe("a webhook", () => {
  test("gets the events as JSON in id order, signed over the timestamp and the body", async () => {
    const w = await world("webhook", { secret: "whsec_SIGN" });
    const ids = await events(w.org, [3, 1, 2], { metadata: { key: "DB_URL" } });
    const f = fakeFetch();
    await tick(at(120), { fetch: f.fn });
    expect(f.sent).toHaveLength(1);
    const [s] = f.sent;
    expect(s?.url).toBe("https://logs.example.com/in");
    expect(s?.init.method).toBe("POST");
    expect(s?.init.redirect).toBe("manual");
    expect(idsIn(s?.body ?? "")).toEqual(ids);
    const first = (JSON.parse(s?.body ?? "") as { events: Record<string, unknown>[] }).events[0];
    expect(first).toMatchObject({
      organizationId: w.org,
      actorKind: "user",
      actorId: "u1",
      action: "variable.update",
      resourceType: "variable",
      metadata: { key: "DB_URL" },
    });
    expect(first?.at).toBe(new Date(T0 + 1000).toISOString());
    const h = s?.headers ?? {};
    expect(h["x-orch-event"]).toBe("audit.events");
    expect(h["x-orch-delivery"]).toBe(`${w.sink}:${ids.at(-1)}`);
    const expected = createHmac("sha256", "whsec_SIGN")
      .update(`${h["x-orch-timestamp"]}.${s?.body}`)
      .digest("hex");
    expect(h["x-orch-signature"]).toBe(`v1=${expected}`);
    expect((await state(w))?.cursor).toBe(ids.at(-1) ?? "");
  });

  test("holds back an event until it has settled, by default, then sends it", async () => {
    const w = await world("webhook", { secret: "whsec_SETTLE" });
    const ids = await events(w.org, [100]);
    const f = fakeFetch();
    // 10 s old at T0 + 110: a slower transaction could still land an event behind it
    await tick(at(110), { fetch: f.fn });
    expect(f.sent).toEqual([]);
    await tick(at(131), { fetch: f.fn });
    expect(idsIn(f.sent[0]?.body ?? "")).toEqual(ids);
  });

  test("dates a failure from the hand-over, not from when the run began", async () => {
    const w = await world("webhook", { secret: "whsec_CLOCK" });
    await events(w.org, [1]);
    let reads = 0;
    // every read of the clock is a minute later than the one before
    const clock = () => at(120 + 60 * reads++);
    const f = fakeFetch(() => new Response("no", { status: 500 }));
    await auditForwardHandler({
      db: t.db,
      keys,
      now: clock,
      resolve: async () => PUBLIC,
      fetch: f.fn,
    })(ctx());
    // a clock read once, at the start, would give T0 + 120 s + the 30 s backoff
    expect((await state(w))?.nextAttemptAt.getTime()).toBeGreaterThan(at(150).getTime());
  });

  test("with no secret sealed with it, nothing is sent", async () => {
    const w = await world("webhook", {
      sealed: JSON.stringify({ url: "https://logs.example.com/in" }),
    });
    await events(w.org, [1]);
    const f = fakeFetch();
    await tick(at(120), { fetch: f.fn });
    expect(f.sent).toEqual([]);
    expect((await state(w))?.lastError).toBe("sink is not readable");
  });
});

describe("a Datadog logs intake", () => {
  test("gets an array of entries with the API key in its header, each carrying the event as its message", async () => {
    const w = await world("datadog", {
      url: "https://http-intake.logs.datadoghq.com/api/v2/logs",
      secret: "DDKEY0123",
    });
    const ids = await events(w.org, [1, 2]);
    const f = fakeFetch();
    await tick(at(120), { fetch: f.fn });
    const [s] = f.sent;
    expect(s?.headers["dd-api-key"]).toBe("DDKEY0123");
    expect(s?.headers["content-type"]).toBe("application/json");
    const entries = JSON.parse(s?.body ?? "") as {
      ddsource: string;
      ddtags: string;
      message: string;
    }[];
    expect(entries.map((e) => JSON.parse(e.message).id)).toEqual(ids);
    expect(entries[0]).toMatchObject({ ddsource: "orch", ddtags: `organization:${w.org}` });
    // the key is a header, not part of what is stored at the collector
    expect(s?.body).not.toContain("DDKEY0123");
  });
});

describe("a Splunk collector", () => {
  test("gets one event after another, with the token in its authorization header", async () => {
    const w = await world("splunk", {
      url: "https://splunk.example.com:8088/services/collector/event",
      secret: "11111111-2222-3333-4444-555555555555",
    });
    const ids = await events(w.org, [1, 2]);
    const f = fakeFetch();
    await tick(at(120), { fetch: f.fn });
    const [s] = f.sent;
    expect(s?.headers.authorization).toBe("Splunk 11111111-2222-3333-4444-555555555555");
    const lines = (s?.body ?? "").split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event.id)).toEqual(ids);
    expect(lines[0]).toMatchObject({
      time: (T0 + 1000) / 1000,
      source: "orch",
      sourcetype: "_json",
    });
    expect(s?.body).not.toContain("11111111-2222");
  });
});

/** Reads RFC 5425 frames: the length in bytes, a space, that many bytes. */
function frames(buf: Buffer) {
  const out: string[] = [];
  for (let i = 0; i < buf.length; ) {
    const space = buf.indexOf(0x20, i);
    const len = Number(buf.subarray(i, space).toString());
    out.push(buf.subarray(space + 1, space + 1 + len).toString("utf8"));
    i = space + 1 + len;
  }
  return out;
}

describe("a syslog collector", () => {
  test("gets RFC 5424 messages in octet-counted frames, the length in bytes, at the address that was checked", async () => {
    const w = await world("syslog", { url: "tls://logs.example.com:6515" });
    const ids = await events(w.org, [1, 2], { metadata: { note: "café €5 😀" } });
    const got: SyslogDelivery[] = [];
    await tick(at(120), {
      connect: async (d) => {
        got.push(d);
      },
    });
    expect(got).toHaveLength(1);
    const [d] = got;
    expect([d?.address, d?.port, d?.servername]).toEqual([PUBLIC[0], 6515, "logs.example.com"]);
    const msgs = frames(d?.payload ?? Buffer.alloc(0));
    expect(msgs).toHaveLength(2);
    for (const [i, m] of msgs.entries()) {
      expect(
        m.startsWith(
          `<110>1 ${new Date(T0 + (i + 1) * 1000).toISOString()} orch orch - variable.update - {`,
        ),
      ).toBe(true);
      const json = JSON.parse(m.slice(m.indexOf(" - {") + 3));
      expect(json).toMatchObject({ id: ids[i], metadata: { note: "café €5 😀" } });
    }
    // the framing counts bytes: a count of characters would have lost the frames' edges above
    expect(Buffer.byteLength(msgs[0] ?? "")).toBeGreaterThan((msgs[0] ?? "").length);
    expect((await state(w))?.cursor).toBe(ids.at(-1) ?? "");
  });

  test("the message id is cut at the 32 characters RFC 5424 allows", async () => {
    const w = await world("syslog");
    await events(w.org, [1], { action: "a".repeat(40) });
    const got: SyslogDelivery[] = [];
    await tick(at(120), {
      connect: async (d) => {
        got.push(d);
      },
    });
    expect(frames(got[0]?.payload ?? Buffer.alloc(0))[0]).toContain(` - ${"a".repeat(32)} - {`);
  });

  test("tries the next address of the name when the first does not answer, and gives up when none does", async () => {
    const w = await world("syslog");
    const ids = await events(w.org, [1]);
    const addresses = ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "93.184.216.35"];
    const tried: string[] = [];
    let up = "";
    const connect = async (d: SyslogDelivery) => {
      tried.push(d.address);
      if (d.address !== up) throw new Error("connect ECONNREFUSED");
    };
    up = addresses[1] ?? "";
    await tick(at(120), { resolve: async () => addresses, connect });
    expect(tried).toEqual(addresses.slice(0, 2));
    expect((await state(w))?.cursor).toBe(ids.at(-1) ?? "");

    // nothing answers: three are tried, no more, and it is a failure that keeps the events
    const lost = await world("syslog");
    await events(lost.org, [1]);
    tried.length = 0;
    up = "";
    await tick(at(120), {
      resolve: async () => [...addresses, "93.184.216.36"],
      connect,
    });
    expect(tried.slice(0, 3)).toEqual(addresses);
    expect(tried).toHaveLength(3);
    expect(await state(lost)).toMatchObject({
      failures: 1,
      cursor: "00000000-0000-0000-0000-000000000000",
    });
  });

  test("stops trying addresses once the run is aborted", async () => {
    const w = await world("syslog");
    await events(w.org, [1]);
    const stop = new AbortController();
    const tried: string[] = [];
    await tick(at(120), {
      signal: stop.signal,
      resolve: async () => ["93.184.216.34", "93.184.216.35"],
      connect: async (d) => {
        tried.push(d.address);
        stop.abort();
        throw new Error("connect ECONNREFUSED");
      },
    });
    expect(tried).toEqual(["93.184.216.34"]);
    expect((await state(w))?.failures).toBe(1);
  });

  test("uses the default port, and no server name for an address written as an IP", async () => {
    const w = await world("syslog", { url: "tls://93.184.216.34" });
    await events(w.org, [1]);
    const got: SyslogDelivery[] = [];
    await tick(at(120), {
      connect: async (d) => {
        got.push(d);
      },
    });
    expect([got[0]?.address, got[0]?.port, got[0]?.servername]).toEqual([
      "93.184.216.34",
      6514,
      undefined,
    ]);
  });

  test("a connection that fails is a plain failure that keeps the events for the next try", async () => {
    const w = await world("syslog");
    const ids = await events(w.org, [1]);
    let fails = true;
    const connect = async (_d: SyslogDelivery) => {
      if (fails) throw new Error("connect ECONNREFUSED logs.example.com:6514");
    };
    await tick(at(120), { connect });
    expect(await state(w)).toMatchObject({ failures: 1, lastError: "delivery failed" });
    fails = false;
    await tick(at(200), { connect });
    expect((await state(w))?.cursor).toBe(ids[0] ?? "");
  });
});

describe("an address that is not allowed", () => {
  test.each([
    ["a private address", ["10.0.0.5"]],
    ["a loopback address", ["127.0.0.1"]],
    ["the cloud metadata address", ["169.254.169.254"]],
    ["one private among public ones", ["93.184.216.34", "192.168.1.9"]],
    ["no address at all", []],
  ])("%s is refused before anything is sent", async (_name, addresses) => {
    const w = await world("webhook", { secret: "s" });
    const sys = await world("syslog");
    await events(w.org, [1]);
    await events(sys.org, [1]);
    const f = fakeFetch();
    const connected: SyslogDelivery[] = [];
    await tick(at(120), {
      fetch: f.fn,
      resolve: async () => addresses,
      connect: async (d) => {
        connected.push(d);
      },
    });
    expect(f.sent).toEqual([]);
    expect(connected).toEqual([]);
    expect((await state(w))?.lastError).toBe("sink address is not allowed");
    expect((await state(sys))?.lastError).toBe("sink address is not allowed");
  });

  test("an address that cannot be resolved is a sink that cannot be reached", async () => {
    const w = await world("webhook", { secret: "s" });
    await events(w.org, [1]);
    await tick(at(120), {
      fetch: fakeFetch().fn,
      resolve: async () => {
        throw new Error("ENOTFOUND logs.example.com");
      },
    });
    expect((await state(w))?.lastError).toBe("sink could not be reached");
  });

  test("an address sealed before the rules got stricter is checked again", async () => {
    const w = await world("webhook", { secret: "s", url: "https://127.0.0.1/in" });
    await events(w.org, [1]);
    const f = fakeFetch();
    await tick(at(120), { fetch: f.fn });
    expect(f.sent).toEqual([]);
    expect((await state(w))?.lastError).toBe("sink address is not allowed");
  });

  test("a redirect is not followed: it is a failure", async () => {
    const w = await world("webhook", { secret: "s" });
    await events(w.org, [1]);
    const f = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/x" } }),
    );
    await tick(at(120), { fetch: f.fn });
    expect(f.sent).toHaveLength(1);
    expect(await state(w)).toMatchObject({ failures: 1, lastError: "sink answered 302" });
  });

  test("a sink of a kind that cannot take the audit log is left alone", async () => {
    const w = await world("slack", { url: "https://hooks.slack.com/services/T0/B0/XXXX" });
    await events(w.org, [1]);
    const f = fakeFetch();
    await tick(at(120), { fetch: f.fn });
    expect(f.sent).toEqual([]);
    expect((await state(w))?.lastError).toBe("sink cannot take the audit log");
  });

  test("a sink that cannot be read says so", async () => {
    const w = await world("webhook", { sealed: "not json" });
    await events(w.org, [1]);
    const f = fakeFetch();
    await tick(at(120), { fetch: f.fn });
    expect(f.sent).toEqual([]);
    expect((await state(w))?.lastError).toBe("sink is not readable");
  });
});

describe("what never leaves", () => {
  test("neither the address nor the credential is in a stored error, a log line or what the collector gets beyond its header", async () => {
    const url = "https://logs.example.com/in?token=URLCANARY";
    const w = await world("splunk", { url, secret: "TOKENCANARY" });
    await events(w.org, [1]);
    let up = false;
    const f = fakeFetch(() =>
      up ? new Response("ok") : new Error(`connect ECONNREFUSED ${url} Splunk TOKENCANARY`),
    );
    await tick(at(120), { fetch: f.fn });
    const failed = await state(w);
    expect(failed?.lastError).toBe("sink could not be reached");
    up = true;
    await tick(at(200), { fetch: f.fn });
    for (const text of [JSON.stringify(failed), JSON.stringify(await state(w)), logs.join("\n")]) {
      expect(text).not.toContain("URLCANARY");
      expect(text).not.toContain("TOKENCANARY");
    }
    expect(f.sent.at(-1)?.body).not.toContain("CANARY");
  });
});

describe("retry, resume and duplicates", () => {
  test("a sink that answers badly is tried again after its backoff with the same events, and not before", async () => {
    const w = await world("webhook", { secret: "s" });
    const ids = await events(w.org, [1, 2, 3]);
    let status = 500;
    const f = fakeFetch(() => new Response("no", { status }));
    await tick(at(120), { fetch: f.fn });
    expect(await state(w)).toMatchObject({
      failures: 1,
      lastError: "sink answered 500",
      deliveredAt: null,
    });
    // too early: not asked at all
    await tick(at(149), { fetch: f.fn });
    expect(f.sent).toHaveLength(1);
    status = 200;
    await tick(at(150), { fetch: f.fn });
    expect(f.sent).toHaveLength(2);
    expect(idsIn(f.sent[0]?.body ?? "")).toEqual(ids);
    expect(idsIn(f.sent[1]?.body ?? "")).toEqual(ids);
    expect(await state(w)).toMatchObject({ failures: 0, lastError: null, cursor: ids.at(-1) });
  });

  test("after downtime the sink gets what was written meanwhile, from where it stopped, in order and in batches", async () => {
    const w = await world("webhook", { secret: "s", from: "now" });
    const early = await events(w.org, [10]);
    let up = true;
    const f = fakeFetch(() => (up ? new Response("ok") : new Response("down", { status: 503 })));
    await tick(at(60), { fetch: f.fn });
    up = false;
    const during = await events(
      w.org,
      Array.from({ length: FORWARD_BATCH + 50 }, (_, i) => 100 + i),
    );
    await tick(at(400), { fetch: f.fn });
    await tick(at(500), { fetch: f.fn });
    expect(f.sent.map((s) => idsIn(s.body).length)).toEqual([1, FORWARD_BATCH, FORWARD_BATCH]);
    up = true;
    await tick(at(10_000), { fetch: f.fn });
    const got = f.sent.slice(3).map((s) => idsIn(s.body));
    // one run works the backlog off, a batch at a time
    expect(got.map((g) => g.length)).toEqual([FORWARD_BATCH, 50]);
    expect(got.flat()).toEqual(during);
    expect((await state(w))?.cursor).toBe(during.at(-1) ?? "");
    expect(idsIn(f.sent[0]?.body ?? "")).toEqual(early);
  });

  test("a batch the collector kept but never answered for arrives twice, and its ids dedupe it", async () => {
    const w = await world("webhook", { secret: "s" });
    const ids = await events(w.org, [1, 2]);
    const f = fakeFetch((k) => (k === 1 ? new Error("timeout") : new Response("ok")));
    await tick(at(120), { fetch: f.fn });
    await tick(at(150), { fetch: f.fn });
    const seen = f.sent.flatMap((s) => idsIn(s.body));
    expect(seen).toEqual([...ids, ...ids]);
    expect([...new Set(seen)]).toEqual(ids);
  });

  test("a failing sink does not hold up another, and a sink not yet due is not asked", async () => {
    const bad = await world("webhook", { secret: "s", url: "https://bad.example.com/in" });
    const good = await world("webhook", { secret: "s", url: "https://good.example.com/in" });
    await events(bad.org, [1]);
    await events(good.org, [1]);
    const sent: string[] = [];
    const routed = async (url: string, _init: RequestInit) => {
      sent.push(url);
      return url.includes("bad") ? new Response("no", { status: 500 }) : new Response("ok");
    };
    await tick(at(120), { fetch: routed });
    expect((await state(bad))?.failures).toBe(1);
    expect((await state(good))?.failures).toBe(0);
    expect((await state(good))?.deliveredAt).not.toBeNull();
    expect(sent.sort()).toEqual(["https://bad.example.com/in", "https://good.example.com/in"]);
    await tick(at(125), { fetch: routed });
    // the good one is caught up and the bad one is waiting: nothing to send
    expect(sent).toHaveLength(2);
  });

  test("a run that was told to stop sends nothing", async () => {
    const w = await world("webhook", { secret: "s" });
    await events(w.org, [1]);
    const f = fakeFetch();
    const stopped = AbortSignal.abort();
    await tick(at(120), { fetch: f.fn, signal: stopped });
    expect(f.sent).toEqual([]);
    expect((await state(w))?.deliveredAt).toBeNull();
  });
});
