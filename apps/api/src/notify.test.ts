import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createLogger, type SinkKind } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  claim,
  createOrganization,
  createProject,
  createSink,
  fail,
  type Job,
  jobs,
  NOTIFY_QUEUE,
  notifyStackDrift,
  setSubscriptions,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq, sql } from "drizzle-orm";
import {
  bareHost,
  newWebhookSecret,
  notifyDeliverHandler,
  publicAddress,
  SinkUrlError,
  sealSink,
  sinkUrl,
} from "./notify";
import { createWorker, type JobContext } from "./worker";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.db.delete(jobs).where(eq(jobs.queue, NOTIFY_QUEUE));
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXSLACKTOKEN";
const WEBHOOK = "https://ops.example.com/orch?token=URLTOKEN123";
const SIGNING = "whsec_SIGNINGSECRET";
const NOW = new Date(Date.UTC(2026, 9, 18, 12, 30, 15));
const AT = "2026-10-18T12:00:00.000Z";
const PUBLIC = ["93.184.216.34"];

interface Sent {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: string;
}
type Answer = Response | Error;
function fakeFetch(answer: (n: number) => Answer | Promise<Answer> = () => new Response("ok")) {
  const sent: Sent[] = [];
  const fn = async (url: string, init: RequestInit) => {
    sent.push({
      url,
      init,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: String(init.body),
    });
    const a = await answer(sent.length);
    if (a instanceof Error) throw a;
    return a;
  };
  return { sent, fn };
}

const logs: string[] = [];
const logger = createLogger({ write: (l) => logs.push(l), level: "debug" });
beforeEach(() => {
  logs.length = 0;
});

let n = 0;
async function world(kind: "webhook" | "slack" = "webhook") {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: "api" });
  const url = kind === "slack" ? SLACK : WEBHOOK;
  const sink = await createSink(t.db, keys, {
    organizationId: org.id,
    kind,
    name: `s${++n}`,
    host: new URL(url).host,
    secret: sealSink({ url, ...(kind === "webhook" ? { secret: SIGNING } : {}) }),
  });
  await setSubscriptions(t.db, {
    organizationId: org.id,
    projectId: project.id,
    sinkId: sink.id,
    events: ["stack.drift"],
  });
  const tell = (over: object = {}) =>
    t.db.transaction((tx) =>
      notifyStackDrift(tx, {
        organizationId: org.id,
        projectId: project.id,
        stack: "net",
        status: "drifted",
        add: 1,
        change: 2,
        destroy: 3,
        at: new Date(AT),
        ...over,
      }),
    );
  const queued = async () =>
    (await t.db.select().from(jobs).where(eq(jobs.queue, NOTIFY_QUEUE))).filter(
      (j) => (j.payload as { sinkId: string }).sinkId === sink.id,
    );
  return { org, project, sink, tell, queued };
}
const ctxOf = (payload: Record<string, unknown>, over: Partial<JobContext> = {}): JobContext => ({
  id: "0198d6f0-0000-7000-8000-000000000001",
  queue: NOTIFY_QUEUE,
  payload,
  attempt: 1,
  maxAttempts: 10,
  log: logger,
  signal: new AbortController().signal,
  ...over,
});
const payloadOf = async (w: Awaited<ReturnType<typeof world>>, over: object = {}) => {
  await w.tell();
  const [job] = await w.queued();
  return { ...(job?.payload as Record<string, unknown>), ...over };
};
const handler = (f: ReturnType<typeof fakeFetch>, resolve = async () => PUBLIC) =>
  notifyDeliverHandler({ db: t.db, keys, fetch: f.fn, resolve, now: () => NOW, timeoutMs: 200 });

const hmac = (secret: string, text: string) =>
  createHmac("sha256", secret).update(text).digest("hex");

describe("where a sink may point", () => {
  const refused = (kind: "webhook" | "slack", url: string) => {
    try {
      sinkUrl(kind, url);
    } catch (e) {
      if (e instanceof SinkUrlError) return e.message;
      throw e;
    }
    return undefined;
  };

  test("a public https address is taken as it is written", () => {
    expect(sinkUrl("webhook", WEBHOOK).href).toBe(WEBHOOK);
    expect(sinkUrl("webhook", "https://203.0.114.9:8443/in").host).toBe("203.0.114.9:8443");
    expect(sinkUrl("slack", SLACK).href).toBe(SLACK);
  });

  test.each([
    ["not an address", "hooks"],
    ["http", "http://ops.example.com/in"],
    ["other schemes", "ftp://ops.example.com/in"],
    ["credentials in the address", "https://user:pw@ops.example.com/in"],
    ["a user name alone", "https://user@ops.example.com/in"],
    ["localhost", "https://localhost/in"],
    ["a name under localhost", "https://api.localhost/in"],
    ["a name that is not public", "https://printer.local/in"],
    ["a name without a dot", "https://intranet/in"],
    ["loopback", "https://127.0.0.1/in"],
    ["loopback, shortened", "https://127.1/in"],
    ["loopback as one number", "https://2130706433/in"],
    ["loopback in hex", "https://0x7f000001/in"],
    ["the unspecified address", "https://0.0.0.0/in"],
    ["a private range", "https://10.1.2.3/in"],
    ["a private range", "https://172.16.0.9/in"],
    ["a private range", "https://192.168.1.1/in"],
    ["shared address space", "https://100.64.0.1/in"],
    ["the metadata address", "https://169.254.169.254/latest"],
    ["IPv6 loopback", "https://[::1]/in"],
    ["IPv6 unique local", "https://[fd00::1]/in"],
    ["IPv6 link local", "https://[fe80::1]/in"],
    ["IPv6 mapped IPv4", "https://[::ffff:10.0.0.1]/in"],
    ["a very long address", `https://ops.example.com/${"a".repeat(2100)}`],
  ])("webhook: %s is refused", (_why, url) => {
    expect(refused("webhook", url)).toBeString();
  });

  test.each([
    ["another host", "https://hooks.example.com/services/T/B/X"],
    ["a host that only starts like it", "https://hooks.slack.com.evil.example/services/T/B/X"],
    ["a host with it as the user", "https://hooks.slack.com@evil.example/services/T/B/X"],
    ["another path", "https://hooks.slack.com/api/chat.postMessage"],
    ["http", "http://hooks.slack.com/services/T/B/X"],
  ])("slack: %s is refused", (_why, url) => {
    expect(refused("slack", url)).toBeString();
  });

  test("a refusal never quotes the address", () => {
    expect(refused("webhook", "https://user:SECRETPW@ops.example.com/in")).not.toContain(
      "SECRETPW",
    );
    expect(refused("slack", "https://evil.example/services/TOKENPART")).not.toContain("TOKENPART");
  });

  test.each([
    ["93.184.216.34", true],
    ["8.8.8.8", true],
    ["1.1.1.1", true],
    ["172.15.255.255", true],
    ["172.32.0.1", true],
    ["100.63.255.255", true],
    ["100.128.0.1", true],
    ["2606:4700:4700::1111", true],
    ["2a00:1450:4009:81f::200e", true],
    ["0.1.2.3", false],
    ["10.0.0.1", false],
    ["100.64.0.1", false],
    ["100.127.255.255", false],
    ["127.0.0.1", false],
    ["169.254.169.254", false],
    ["172.16.0.1", false],
    ["172.31.255.255", false],
    ["192.0.0.1", false],
    ["192.0.2.1", false],
    ["192.168.0.1", false],
    ["198.18.0.1", false],
    ["198.19.255.255", false],
    ["198.51.100.1", false],
    ["203.0.113.1", false],
    ["192.88.99.1", false],
    ["224.0.0.1", false],
    ["240.0.0.1", false],
    ["255.255.255.255", false],
    ["::", false],
    ["::1", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:8.8.8.8", false],
    ["64:ff9b::a00:1", false],
    ["fc00::1", false],
    ["fd12:3456::1", false],
    ["fe80::1", false],
    ["fe80::1%eth0", false],
    ["ff02::1", false],
    ["2001:db8::1", false],
    ["2001::1", false],
    ["2001:1::1", false],
    ["2001:1ff:ffff::1", false],
    ["2001:200::1", true],
    ["3fff::1", false],
    ["3fff:fff:ffff::1", false],
    ["3fff:1000::1", true],
    ["2002:a00:1::1", false],
    ["not an address", false],
    ["", false],
    ["1.2.3", false],
    ["256.1.1.1", false],
  ])("%s is public: %p", (address, ok) => {
    expect(publicAddress(address)).toBe(ok);
  });
});

describe("a webhook delivery", () => {
  test("posts the news as JSON, signed so the receiver can tell it came from here", async () => {
    const w = await world();
    const payload = await payloadOf(w);
    const f = fakeFetch();
    await handler(f)(ctxOf(payload));

    expect(f.sent).toHaveLength(1);
    const [sent] = f.sent;
    if (!sent) throw new Error("nothing sent");
    expect(sent.url).toBe(WEBHOOK);
    expect(sent.init.method).toBe("POST");
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.headers["x-orch-event"]).toBe("stack.drift");
    expect(sent.headers["x-orch-delivery"]).toBe("0198d6f0-0000-7000-8000-000000000001");
    expect(sent.headers["x-orch-timestamp"]).toBe(String(Math.floor(NOW.getTime() / 1000)));
    expect(JSON.parse(sent.body)).toEqual({
      id: "0198d6f0-0000-7000-8000-000000000001",
      event: "stack.drift",
      at: AT,
      organizationId: w.org.id,
      project: { id: w.project.id, name: "api" },
      stack: "net",
      status: "drifted",
      plan: { add: 1, change: 2, destroy: 3 },
    });
    // the receiver's check, written out independently of the code that signs
    expect(sent.headers["x-orch-signature"]).toBe(
      `v1=${hmac(SIGNING, `${sent.headers["x-orch-timestamp"]}.${sent.body}`)}`,
    );
  });

  test("the signature covers the body, the time and the secret", async () => {
    const w = await world();
    const f = fakeFetch();
    await handler(f)(ctxOf(await payloadOf(w)));
    const [sent] = f.sent;
    if (!sent) throw new Error("nothing sent");
    const header = sent.headers["x-orch-signature"];
    const ts = sent.headers["x-orch-timestamp"];
    expect(header).not.toBe(
      `v1=${hmac(SIGNING, `${ts}.${sent.body.replace("drifted", "clean")}`)}`,
    );
    expect(header).not.toBe(`v1=${hmac(SIGNING, `${Number(ts) + 1}.${sent.body}`)}`);
    expect(header).not.toBe(`v1=${hmac("whsec_other", `${ts}.${sent.body}`)}`);
    expect(header).not.toContain(SIGNING);
  });

  test("a retry carries the same delivery id and a fresh timestamp", async () => {
    const w = await world();
    const payload = await payloadOf(w);
    let clock = NOW;
    const f = fakeFetch((n) =>
      n === 1 ? new Response("no", { status: 503 }) : new Response("ok"),
    );
    const h = notifyDeliverHandler({
      db: t.db,
      keys,
      fetch: f.fn,
      resolve: async () => PUBLIC,
      now: () => clock,
      timeoutMs: 200,
    });
    await expect(h(ctxOf(payload))).rejects.toThrow();
    clock = new Date(clock.getTime() + 60_000);
    await h(ctxOf(payload, { attempt: 2 }));
    const [first, second] = f.sent;
    expect(second?.headers["x-orch-delivery"]).toBe(first?.headers["x-orch-delivery"]);
    expect(Number(second?.headers["x-orch-timestamp"])).toBe(
      Number(first?.headers["x-orch-timestamp"]) + 60,
    );
  });

  test("a stack back in line is reported as clean", async () => {
    const w = await world();
    const f = fakeFetch();
    await handler(f)(ctxOf(await payloadOf(w, { status: "clean", add: 0, change: 0, destroy: 0 })));
    expect(JSON.parse(f.sent[0]?.body ?? "{}")).toMatchObject({
      status: "clean",
      plan: { add: 0, change: 0, destroy: 0 },
    });
  });

  test("the secret shown at creation is the one that signs", () => {
    const a = newWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(newWebhookSecret()).not.toBe(a);
  });
});

describe("a slack delivery", () => {
  test("posts a message to the hook, with nothing of a signature", async () => {
    const w = await world("slack");
    const f = fakeFetch();
    await handler(f)(ctxOf(await payloadOf(w)));
    const [sent] = f.sent;
    if (!sent) throw new Error("nothing sent");
    expect(sent.url).toBe(SLACK);
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(Object.keys(sent.headers).filter((k) => k.startsWith("x-orch"))).toEqual([]);
    const message = JSON.parse(sent.body) as { text: string };
    expect(Object.keys(message)).toEqual(["text"]);
    expect(message.text).toContain("net");
    expect(message.text).toContain("api");
    expect(message.text).toContain("1 to add, 2 to change, 3 to destroy");
  });

  test("says when a stack is back in line", async () => {
    const w = await world("slack");
    const f = fakeFetch();
    await handler(f)(ctxOf(await payloadOf(w, { status: "clean", add: 0, change: 0, destroy: 0 })));
    const text = (JSON.parse(f.sent[0]?.body ?? "{}") as { text: string }).text;
    expect(text).toContain("net");
    expect(text).not.toContain("to add");
  });

  test("a project name cannot turn into a link or a mention", async () => {
    const w = await world("slack");
    const f = fakeFetch();
    await handler(f)(ctxOf(await payloadOf(w, { projectName: "<!channel> <http://x|y> & co" })));
    const text = (JSON.parse(f.sent[0]?.body ?? "{}") as { text: string }).text;
    expect(text).not.toMatch(/[<>]/);
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&amp; co");
  });
});

describe("what a delivery does when it cannot", () => {
  const failing = (status: number) => fakeFetch(() => new Response("nope", { status }));

  test.each([200, 201, 202, 204])("an answer of %i is delivered", async (status) => {
    const w = await world();
    await handler(fakeFetch(() => new Response(null, { status })))(ctxOf(await payloadOf(w)));
  });

  test.each([300, 301, 302, 307, 400, 401, 404, 408, 410, 429, 500, 502, 503])(
    "an answer of %i fails the attempt, and a redirect is not followed",
    async (status) => {
      const w = await world();
      const f = failing(status);
      await expect(handler(f)(ctxOf(await payloadOf(w)))).rejects.toThrow(
        `sink answered ${status}`,
      );
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]?.init.redirect).toBe("manual");
    },
  );

  test("an error from the network names neither the address nor the secret", async () => {
    const w = await world();
    const f = fakeFetch(
      () => new Error(`connect ECONNREFUSED ${WEBHOOK} using ${SIGNING} and ${SLACK}`),
    );
    const error = await handler(f)(ctxOf(await payloadOf(w))).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message) + String((error as Error).stack)).not.toMatch(
      /URLTOKEN|SIGNING|XXXXSLACK|ops\.example/,
    );
    expect((error as Error).message).toBe("sink could not be reached");
  });

  test("a slow receiver is given up on, and so is a stopping worker", async () => {
    const w = await world();
    const stuck = (timeoutMs: number) =>
      notifyDeliverHandler({
        db: t.db,
        keys,
        resolve: async () => PUBLIC,
        now: () => NOW,
        timeoutMs,
        // never answers; only the signal ends it
        fetch: (_url, init) =>
          new Promise((_, reject) => {
            const stop = () => reject(init.signal?.reason);
            if (init.signal?.aborted) stop();
            else init.signal?.addEventListener("abort", stop);
          }),
      });
    const payload = await payloadOf(w);
    await expect(stuck(20)(ctxOf(payload))).rejects.toThrow("sink could not be reached");

    const stop = new AbortController();
    const running = stuck(60_000)(ctxOf(payload, { signal: stop.signal }));
    stop.abort(new Error("shutting down"));
    await expect(running).rejects.toThrow("sink could not be reached");
  });

  test("a sink that is gone is nothing to deliver to", async () => {
    const w = await world();
    const payload = await payloadOf(w);
    await t.db.execute(sql`DELETE FROM notification_sinks WHERE id = ${w.sink.id}`);
    const f = fakeFetch();
    await handler(f)(ctxOf(payload));
    expect(f.sent).toEqual([]);
    expect(logs.join("\n")).toContain("sink is gone");
  });

  test("a sink of another organization is not reached through this one's payload", async () => {
    const w = await world();
    const other = await world();
    const f = fakeFetch();
    await handler(f)(ctxOf(await payloadOf(w, { organizationId: other.org.id })));
    expect(f.sent).toEqual([]);
  });

  test("a payload that is not ours fails and sends nothing", async () => {
    const w = await world();
    const f = fakeFetch();
    for (const bad of [
      {},
      { ...(await payloadOf(w)), sinkId: "nope" },
      { ...(await payloadOf(w)), status: "on fire" },
      { ...(await payloadOf(w)), add: -1 },
      { ...(await payloadOf(w)), event: "run.apply" },
    ]) {
      await expect(handler(f)(ctxOf(bad))).rejects.toThrow("not a notification");
    }
    expect(f.sent).toEqual([]);
  });
});

describe("a sink that points somewhere private", () => {
  test.each([
    ["resolves to a private address", ["10.0.0.5"]],
    ["resolves to the metadata address", ["169.254.169.254"]],
    ["resolves to loopback", ["127.0.0.1"]],
    ["resolves to a private IPv6 address", ["fd00::1"]],
    ["resolves to both a public and a private address", ["93.184.216.34", "10.0.0.5"]],
    ["resolves to nothing", []],
  ])("a host that %s is not delivered to", async (_why, addresses) => {
    const w = await world();
    const f = fakeFetch();
    await expect(handler(f, async () => addresses)(ctxOf(await payloadOf(w)))).rejects.toThrow(
      "sink address is not allowed",
    );
    expect(f.sent).toEqual([]);
  });

  test("a host that does not resolve fails the attempt", async () => {
    const w = await world();
    const f = fakeFetch();
    const gone = async (): Promise<string[]> => {
      throw new Error(`getaddrinfo ENOTFOUND ops.example.com ${SIGNING}`);
    };
    const error = await handler(f, gone)(ctxOf(await payloadOf(w))).catch((e: Error) => e);
    expect((error as Error).message).toBe("sink could not be reached");
    expect(f.sent).toEqual([]);
  });

  test("an address stored as a private literal is refused at delivery, whatever created it", async () => {
    const w = await world();
    const bad = await createSink(t.db, keys, {
      organizationId: w.org.id,
      kind: "webhook",
      name: "bad",
      host: "10.0.0.1",
      secret: sealSink({ url: "https://10.0.0.1/in", secret: SIGNING }),
    });
    const f = fakeFetch();
    let resolved = 0;
    const h = handler(f, async () => {
      resolved++;
      return PUBLIC;
    });
    await expect(h(ctxOf(await payloadOf(w, { sinkId: bad.id })))).rejects.toThrow(
      "sink address is not allowed",
    );
    expect(f.sent).toEqual([]);
    expect(resolved).toBe(0);
  });

  test.each([
    ["webhook", "http://ops.example.com/in"],
    ["webhook", "https://user:hunter2@ops.example.com/in"],
    ["webhook", "https://ops.internal/in"],
    ["webhook", "https://intranet/in"],
    ["slack", "https://ops.example.com/services/T/B/X"],
    ["slack", "https://hooks.slack.com/api/chat.postMessage"],
  ] as const)(
    "a %s address stored as %s is refused at delivery too, even though its name resolves publicly",
    async (kind, url) => {
      const w = await world();
      const bad = await createSink(t.db, keys, {
        organizationId: w.org.id,
        kind,
        name: `bad${++n}`,
        host: new URL(url).host,
        secret: sealSink({ url, ...(kind === "webhook" ? { secret: SIGNING } : {}) }),
      });
      const f = fakeFetch();
      const error = await handler(f)(ctxOf(await payloadOf(w, { sinkId: bad.id }))).catch(
        (e: Error) => e,
      );
      expect((error as Error).message).toBe("sink address is not allowed");
      expect(f.sent).toEqual([]);
    },
  );

  test("a webhook stored without a signing secret is not sent unsigned", async () => {
    const w = await world();
    const bare = await createSink(t.db, keys, {
      organizationId: w.org.id,
      kind: "webhook",
      name: "bare",
      host: "ops.example.com",
      secret: sealSink({ url: WEBHOOK }),
    });
    const f = fakeFetch();
    const error = await handler(f)(ctxOf(await payloadOf(w, { sinkId: bare.id }))).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toBe("sink is not readable");
    expect(f.sent).toEqual([]);
  });

  test("a public IP literal is delivered to without asking DNS", async () => {
    const w = await world();
    const lit = await createSink(t.db, keys, {
      organizationId: w.org.id,
      kind: "webhook",
      name: "lit",
      host: "93.184.216.34",
      secret: sealSink({ url: "https://93.184.216.34/in", secret: SIGNING }),
    });
    const f = fakeFetch();
    let resolved = 0;
    await handler(f, async () => {
      resolved++;
      return [];
    })(ctxOf(await payloadOf(w, { sinkId: lit.id })));
    expect(f.sent).toHaveLength(1);
    expect(resolved).toBe(0);
  });
});

describe("through the queue", () => {
  const run = async (
    f: ReturnType<typeof fakeFetch>,
    until: (j: Job) => boolean,
    queued: () => Promise<Job[]>,
  ) => {
    const worker = createWorker({
      db: t.db,
      logger,
      handlers: { [NOTIFY_QUEUE]: handler(f) },
      pollMs: 10,
      backoff: () => 0,
    });
    worker.start();
    try {
      for (let i = 0; i < 500; i++) {
        const [job] = await queued();
        if (job && until(job)) return job;
        await Bun.sleep(10);
      }
      throw new Error("timed out");
    } finally {
      await worker.stop();
    }
  };

  test("a receiver that is down for a while gets the news once it is back", async () => {
    const w = await world();
    await w.tell();
    const f = fakeFetch((n) =>
      n <= 3 ? new Response("down", { status: 503 }) : new Response("ok"),
    );
    const job = await run(f, (j) => j.status === "done", w.queued);
    expect([job.status, job.attempts, f.sent.length]).toEqual(["done", 4, 4]);
    expect(new Set(f.sent.map((s) => s.headers["x-orch-delivery"])).size).toBe(1);
    expect(f.sent[0]?.headers["x-orch-delivery"]).toBe(job.id);
  });

  test("a receiver that never answers well ends up dead after the attempts run out, with a plain reason", async () => {
    const w = await world();
    await w.tell();
    const f = fakeFetch(() => new Response("nope", { status: 500 }));
    const job = await run(f, (j) => j.status === "dead", w.queued);
    expect([job.status, job.attempts, f.sent.length]).toEqual(["dead", 10, 10]);
    expect(job.lastError).toBe("Error: sink answered 500");
    expect(logs.join("\n")).toContain("job failed for good");
  });

  test("each failure waits twice as long as the one before", async () => {
    const w = await world();
    await w.tell();
    const f = fakeFetch(() => new Response("nope", { status: 500 }));
    const h = handler(f);
    // queued at the real clock, so its first attempt is due when it says, not at a fixed date (+1: the column keeps microseconds)
    let now = new Date(((await w.queued())[0]?.runAt ?? NOW).getTime() + 1);
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const [job] = await claim(t.db, { queues: [NOTIFY_QUEUE], workerId: "w", now });
      if (!job) throw new Error(`attempt ${attempt} was not handed out`);
      expect(job.attempts).toBe(attempt);
      const error = await h(ctxOf(job.payload, { id: job.id, attempt })).catch((e: unknown) => e);
      await fail(t.db, job, "w", error, { now });
      const [after] = await w.queued();
      waits.push((after?.runAt.getTime() ?? 0) - now.getTime());
      // not due a moment before, due at the moment
      expect(
        await claim(t.db, {
          queues: [NOTIFY_QUEUE],
          workerId: "w",
          now: new Date(now.getTime() + (waits.at(-1) ?? 0) - 1),
        }),
      ).toEqual([]);
      now = new Date(now.getTime() + (waits.at(-1) ?? 0));
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000]);
  });
});

describe("what leaves", () => {
  test("neither the job, the body, a header, the log nor the stored error holds an address or a secret", async () => {
    for (const kind of ["webhook", "slack"] as const) {
      const w = await world(kind);
      await w.tell();
      const f = fakeFetch(() => new Response("nope", { status: 500 }));
      const [job] = await w.queued();
      if (!job) throw new Error("no job");
      const error = await handler(f)(ctxOf(job.payload, { id: job.id })).catch((e: Error) => e);
      await fail(t.db, job, "w", error);
      const [after] = await w.queued();

      const everything = JSON.stringify([
        after,
        f.sent.map((s) => [s.body, s.headers]),
        logs,
        String(error),
      ]);
      // the address goes to its receiver (the url of the request) and nowhere else
      for (const secret of ["XXXXSLACKTOKEN", "URLTOKEN123", "SIGNINGSECRET", "ops.example.com"]) {
        expect(everything).not.toContain(secret);
      }
      expect(everything).not.toContain("whsec_");
    }
  });

  test("the job holds ids, names and counts and nothing else", async () => {
    const w = await world();
    await w.tell();
    const [job] = await w.queued();
    expect(Object.keys(job?.payload ?? {}).sort()).toEqual(
      [
        "add",
        "at",
        "change",
        "destroy",
        "event",
        "organizationId",
        "projectId",
        "projectName",
        "sinkId",
        "stack",
        "status",
      ].sort(),
    );
  });
});

describe("the collectors' addresses (GOV-4)", () => {
  const refused = (kind: SinkKind, url: string) => {
    try {
      sinkUrl(kind, url);
    } catch (e) {
      if (e instanceof SinkUrlError) return e.message;
      throw e;
    }
    return undefined;
  };

  test("a syslog address is tls:// with a public host; the port is kept, and the host is lower-cased", () => {
    expect(sinkUrl("syslog", "tls://logs.example.com:6514").port).toBe("6514");
    // the URL keeps the case of a host it does not know the scheme of; the name that is resolved and checked does not
    expect(bareHost(sinkUrl("syslog", "tls://Logs.Example.com"))).toBe("logs.example.com");
    expect(sinkUrl("syslog", "tls://93.184.216.34:443").port).toBe("443");
  });

  test.each([
    ["https", "https://logs.example.com:6514"],
    ["plain tcp", "tcp://logs.example.com:514"],
    ["credentials", "tls://user:pw@logs.example.com:6514"],
    ["localhost", "tls://localhost:6514"],
    ["a name without a dot", "tls://syslog:6514"],
    ["a private address", "tls://10.1.2.3:6514"],
    ["the metadata address", "tls://169.254.169.254:6514"],
    ["loopback in IPv6", "tls://[::1]:6514"],
    ["a name under .internal", "tls://logs.internal:6514"],
    ["a name under .internal in capitals", "tls://LOGS.INTERNAL:6514"],
  ])("syslog: %s is refused, and the message does not quote the address", (_why, url) => {
    const why = refused("syslog", url);
    expect(why).toBeString();
    expect(why).not.toContain("pw@");
  });

  test("the other kinds stay https-only, and tls:// is for syslog alone", () => {
    for (const kind of ["webhook", "datadog", "splunk"] as const) {
      expect(refused(kind, "tls://logs.example.com:6514")).toBeString();
      expect(refused(kind, "https://logs.example.com/in")).toBeUndefined();
      expect(refused(kind, "http://logs.example.com/in")).toBeString();
      expect(refused(kind, "https://10.0.0.5/in")).toBeString();
    }
  });

  test("a sink made for the audit log is not a destination for notifications", async () => {
    const w = await world();
    const syslog = await createSink(t.db, keys, {
      organizationId: w.org.id,
      kind: "syslog",
      name: `l${++n}`,
      host: "logs.example.com:6514",
      secret: sealSink({ url: "tls://logs.example.com:6514" }),
    });
    const f = fakeFetch();
    await expect(handler(f)(ctxOf({ ...(await payloadOf(w)), sinkId: syslog.id }))).rejects.toThrow(
      "sink cannot take notifications",
    );
    expect(f.sent).toEqual([]);
  });
});
