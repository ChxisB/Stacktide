import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  connections,
  createConnection,
  createOrganization,
  createSession,
  jobs,
  upsertUser,
  WEBHOOK_QUEUE,
  webhookDeliveries,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { MAX_WEBHOOK_BYTES } from "./routes/webhooks";
import { hashToken, randomToken } from "./tokens";
import { createWorker } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const CANARY = "CANARY-VALUE-5521-do-not-leak";

let t: TestDb;
let o1: string;
let o2: string;
let c1: string; // o1, has a secret
let c1b: string; // o1, has a secret too
let c2: string; // o2, has a secret
let bare: string; // o1, never issued a secret
let other: string; // o1, not a GitLab connection, has a secret
let sOther: string;
let s1: string;
let s1b: string;
let s2: string;
const lines: string[] = [];
const issued: string[] = [];
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();
const people = {} as Record<"alice" | "bob" | "carol", string>;

const app = () =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
  });
let api: ReturnType<typeof app>;

async function admin(who: keyof typeof people | undefined, method: string, path: string) {
  const res = await api.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: who ? { cookie: people[who] } : {},
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { res, text, json: (text ? JSON.parse(text) : undefined) as any };
}
const issue = async (org: string, conn: string, who: keyof typeof people = "alice") => {
  const r = await admin(who, "POST", `/organizations/${org}/connections/${conn}/webhook-secret`);
  if (r.res.status === 200) issued.push(r.json.secret);
  return r;
};

interface Hook {
  conn?: string;
  token?: string | null;
  event?: string | null;
  uuid?: string;
  idem?: string;
  body?: unknown;
  raw?: string | ReadableStream;
  type?: string;
}
async function hook(h: Hook) {
  const headers: Record<string, string> = { "content-type": h.type ?? "application/json" };
  if (h.token !== null) headers["x-gitlab-token"] = h.token ?? s1;
  if (h.event !== null) headers["x-gitlab-event"] = h.event ?? "Push Hook";
  if (h.uuid) headers["x-gitlab-event-uuid"] = h.uuid;
  if (h.idem) headers["idempotency-key"] = h.idem;
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers,
    body: h.raw ?? JSON.stringify("body" in h ? h.body : PUSH),
  };
  if (h.raw instanceof ReadableStream) init.duplex = "half";
  const res = await api.handle(
    new Request(`http://localhost/webhooks/gitlab/${h.conn ?? c1}`, init),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const PUSH = {
  object_kind: "push",
  ref: "refs/heads/main",
  before: "0".repeat(40),
  after: "a".repeat(40),
  total_commits_count: 2,
  project: { id: 77, name: "x" },
  commits: [{ id: "a".repeat(40), message: `deploy with ${CANARY}` }],
};

const allJobs = () => t.db.select().from(jobs).where(eq(jobs.queue, WEBHOOK_QUEUE));
const jobsFor = async (conn: string) =>
  (await allJobs()).filter((j) => j.payload.connectionId === conn);
const deliveries = (conn: string) =>
  t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.connectionId, conn));

let n = 0;
beforeAll(async () => {
  t = await createTestDb();
  [o1, o2] = (await Promise.all(
    ["one", "two"].map(async (slug) => (await createOrganization(t.db, { slug, name: slug })).id),
  )) as [string, string];
  const make = async (organizationId: string, type = "gitlab") =>
    (
      await createConnection(t.db, keys, {
        organizationId,
        type,
        name: `c${++n}`,
        token: "glpat-SECRET-TOKEN-0123456789",
      })
    ).id;
  [c1, c1b, c2, bare, other] = [
    await make(o1),
    await make(o1),
    await make(o2),
    await make(o1),
    await make(o1, "other"),
  ];
  let gitlabId = 700;
  for (const name of ["alice", "bob", "carol"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = `orch_session=${session}`;
  }
  roleTable.set(701, { orgRoles: { [o1]: "admin", [o2]: "admin" }, projectRoles: {} });
  roleTable.set(702, { orgRoles: { [o1]: "member" }, projectRoles: {} });
  api = app();
  s1 = (await issue(o1, c1)).json.secret;
  s1b = (await issue(o1, c1b)).json.secret;
  s2 = (await issue(o2, c2)).json.secret;
  sOther = (await issue(o1, other)).json.secret;
});
afterAll(async () => {
  await t.drop();
});

describe("issuing the webhook secret", () => {
  test("an org admin gets it once, and only its hash is stored", async () => {
    const r = await admin(
      "alice",
      "POST",
      `/organizations/${o1}/connections/${bare}/webhook-secret`,
    );
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.json.secret).toMatch(/^orchwh_[A-Za-z0-9_-]{43}$/);
    expect(r.json.path).toBe(`/webhooks/gitlab/${bare}`);
    issued.push(r.json.secret);

    const [row] = await t.db.select().from(connections).where(eq(connections.id, bare));
    expect(row?.webhookSecretHash).toBe(hashToken(r.json.secret));
    expect(JSON.stringify(row)).not.toContain(r.json.secret);
    const events = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "connection.webhook_secret"));
    const mine = events.find((e) => e.resourceId === bare);
    expect(mine).toMatchObject({ organizationId: o1, resourceType: "connection", metadata: {} });
    expect(JSON.stringify(events)).not.toContain(r.json.secret);

    const list = await admin("alice", "GET", `/organizations/${o1}/connections`);
    expect(list.text).not.toContain(r.json.secret);
    expect(list.text).not.toContain(hashToken(r.json.secret));
  });

  test("issuing again replaces it: the old one stops working at once", async () => {
    const before = (await issue(o2, c2)).json.secret;
    expect((await hook({ conn: c2, token: before })).status).toBe(200);
    const after = (await issue(o2, c2)).json.secret;
    expect(after).not.toBe(before);
    expect((await hook({ conn: c2, token: before })).status).toBe(401);
    expect((await hook({ conn: c2, token: after })).status).toBe(200);
    s2 = after;
  });

  test("members and strangers cannot, nor can a path that mixes organizations", async () => {
    const path = (org: string, conn: string) =>
      `/organizations/${org}/connections/${conn}/webhook-secret`;
    const hashOf = async (id: string) =>
      (await t.db.select().from(connections).where(eq(connections.id, id)))[0]?.webhookSecretHash;
    const before = await hashOf(c1);
    expect((await admin("bob", "POST", path(o1, c1))).res.status).toBe(403);
    expect((await admin("carol", "POST", path(o1, c1))).res.status).toBe(404);
    expect((await admin(undefined, "POST", path(o1, c1))).res.status).toBe(401);
    // alice is admin of both organizations, but c1 belongs to o1
    const mixed = await admin("alice", "POST", path(o2, c1));
    expect(mixed.res.status).toBe(404);
    expect((await admin("alice", "POST", path(o1, crypto.randomUUID()))).res.status).toBe(404);
    expect(await hashOf(c1)).toBe(before);
  });
});

describe("the receiver's secret check", () => {
  test("a valid token queues a job with ids and fields, never the body", async () => {
    const r = await hook({ uuid: "u-push-1" });
    expect(r).toMatchObject({ status: 200, json: { status: "queued" } });
    const [job] = await jobsFor(c1);
    expect(job?.payload).toEqual({
      connectionId: c1,
      organizationId: o1,
      event: "push",
      deliveryId: "u-push-1",
      projectId: 77,
      ref: "refs/heads/main",
      before: "0".repeat(40),
      after: "a".repeat(40),
      commitCount: 2,
    });
    expect(JSON.stringify(await allJobs())).not.toContain(CANARY);
    expect(JSON.stringify(await deliveries(c1))).not.toContain(CANARY);
  });

  test("a wrong, missing, empty or foreign token, an unknown connection and a connection without a secret all get the same 401", async () => {
    const before = [(await allJobs()).length, (await deliveries(c1)).length];
    const answers = await Promise.all([
      hook({ token: "wrong" }),
      hook({ token: null }),
      hook({ token: "" }),
      hook({ token: s1b }), // another connection's secret
      hook({ token: s2 }), // another organization's secret
      hook({ token: hashToken(s1) }), // the stored hash is not the secret
      hook({ conn: crypto.randomUUID() }),
      hook({ conn: "not-a-uuid" }),
      hook({ conn: bare, token: s1 }),
      hook({ conn: bare, token: "" }),
    ]);
    for (const a of answers) {
      expect(a.status).toBe(401);
      expect(a.json).toMatchObject({
        code: "invalid_webhook_token",
        detail: "The webhook token is not valid",
      });
    }
    expect([...new Set(answers.map((a) => a.json.detail))]).toHaveLength(1);
    expect([(await allJobs()).length, (await deliveries(c1)).length]).toEqual(before);
  });

  test("only a GitLab connection takes GitLab webhooks", async () => {
    expect((await hook({ conn: other, token: sOther })).status).toBe(401);
  });

  test("the token is checked before the body is read", async () => {
    expect((await hook({ token: "wrong", raw: "{ not json" })).status).toBe(401);
    expect((await hook({ token: "wrong", raw: "x".repeat(MAX_WEBHOOK_BYTES + 10) })).status).toBe(
      401,
    );
    expect((await hook({ raw: "{ not json" })).status).toBe(400); // right token: now the body counts
  });

  test("a token for one connection does not open another, and a deleted connection takes none", async () => {
    expect((await hook({ conn: c1b, token: s1 })).status).toBe(401);
    expect((await hook({ conn: c1b, token: s1b, uuid: "u-b-1" })).status).toBe(200);
    await t.db.delete(connections).where(eq(connections.id, c1b));
    expect((await hook({ conn: c1b, token: s1b, uuid: "u-b-2" })).status).toBe(401);
  });
});

describe("events", () => {
  const cases: Array<[string, string, unknown, Record<string, unknown>]> = [
    [
      "Merge Request Hook",
      "merge_request",
      {
        project: { id: 5 },
        object_attributes: {
          id: 99,
          iid: 12,
          action: "open",
          state: "opened",
          source_branch: "feat",
          target_branch: "main",
          last_commit: { id: "c".repeat(40), message: CANARY },
          description: CANARY,
        },
      },
      {
        iid: 12,
        action: "open",
        state: "opened",
        sourceBranch: "feat",
        targetBranch: "main",
        sha: "c".repeat(40),
      },
    ],
    [
      "Pipeline Hook",
      "pipeline",
      {
        project: { id: 5 },
        object_attributes: {
          id: 31,
          status: "failed",
          ref: "main",
          sha: "d".repeat(40),
          variables: [{ key: "K", value: CANARY }],
        },
        variables: [{ key: "K", value: CANARY }],
      },
      { pipelineId: 31, status: "failed", ref: "main", sha: "d".repeat(40) },
    ],
    [
      "Job Hook",
      "job",
      {
        project_id: 5,
        build_id: 8,
        pipeline_id: 31,
        build_status: "success",
        build_name: "test",
        ref: "main",
        sha: "e".repeat(40),
        commit: { message: CANARY },
      },
      {
        jobId: 8,
        pipelineId: 31,
        status: "success",
        name: "test",
        ref: "main",
        sha: "e".repeat(40),
      },
    ],
    [
      "Note Hook",
      "note",
      {
        project_id: 5,
        // the text and the author are read from GitLab by the job that handles the command (IAC-9), never taken from here
        object_attributes: {
          id: 4,
          noteable_type: "MergeRequest",
          action: "create",
          author_id: 77,
          note: CANARY,
        },
        user: { id: 77, username: "someone" },
        merge_request: { iid: 12 },
      },
      { noteId: 4, noteableType: "MergeRequest", action: "create", mrIid: 12 },
    ],
  ];
  for (const [header, event, body, picked] of cases) {
    test(`${header} becomes a ${event} job with only the picked fields`, async () => {
      const id = `u-${event}`;
      expect((await hook({ event: header, body, uuid: id })).json).toEqual({ status: "queued" });
      const job = (await jobsFor(c1)).find((j) => j.payload.deliveryId === id);
      expect(job?.payload).toEqual({
        connectionId: c1,
        organizationId: o1,
        event,
        deliveryId: id,
        projectId: 5,
        ...picked,
      });
      expect(JSON.stringify(job)).not.toContain(CANARY);
    });
  }

  test("a child pipeline's event carries the ids of the pipeline that started it, and nothing else of it", async () => {
    const body = {
      project: { id: 5 },
      object_attributes: { id: 32, status: "running", ref: "main", sha: "d".repeat(40) },
      source_pipeline: {
        project: { id: 5, web_url: CANARY, path_with_namespace: CANARY },
        job_id: 9,
        pipeline_id: 31,
      },
    };
    expect((await hook({ event: "Pipeline Hook", body, uuid: "u-child" })).json).toEqual({
      status: "queued",
    });
    const job = (await jobsFor(c1)).find((j) => j.payload.deliveryId === "u-child");
    expect(job?.payload).toEqual({
      connectionId: c1,
      organizationId: o1,
      event: "pipeline",
      deliveryId: "u-child",
      projectId: 5,
      pipelineId: 32,
      status: "running",
      ref: "main",
      sha: "d".repeat(40),
      sourcePipelineId: 31,
      sourceProjectId: 5,
    });
    expect(JSON.stringify(job)).not.toContain(CANARY);
  });

  test("an event we do not handle, or none, is accepted and dropped without a job or a row", async () => {
    const before = [(await allJobs()).length, (await deliveries(c1)).length];
    const events = [
      "Wiki Page Hook",
      "Release Hook",
      "",
      "push hook",
      "constructor",
      "__proto__",
      "toString",
      null,
    ];
    for (const event of events) {
      const r = await hook({ event, uuid: "u-ignored", raw: "{ not even json" });
      expect([event, r.status, r.json]).toEqual([event, 200, { status: "ignored" }]);
    }
    expect([(await allJobs()).length, (await deliveries(c1)).length]).toEqual(before);
  });

  test("values that are not short strings or numbers are left out of the job", async () => {
    const body = {
      ...PUSH,
      ref: "r".repeat(300),
      before: { nested: CANARY },
      after: [1],
      total_commits_count: "2",
    };
    expect((await hook({ body, uuid: "u-odd" })).status).toBe(200);
    const job = (await jobsFor(c1)).find((j) => j.payload.deliveryId === "u-odd");
    expect(job?.payload).toEqual({
      connectionId: c1,
      organizationId: o1,
      event: "push",
      deliveryId: "u-odd",
      projectId: 77,
      commitCount: "2",
    });
  });
});

describe("bad requests", () => {
  const rows = async () => [(await allJobs()).length, (await deliveries(c1)).length];

  test("a body that is not an event of a project is a 400 and leaves nothing behind", async () => {
    const before = await rows();
    const bad: unknown[] = [
      { ref: "x" },
      { project: { id: "77" } },
      { project: { id: 0 } },
      { project: { id: 1.5 } },
      { project: { id: 2 ** 60 } },
      { project: { id: null } },
      [],
      "text",
      null,
    ];
    for (const body of bad) {
      const r = await hook({ body, uuid: "u-bad" });
      expect([JSON.stringify(body), r.status, r.json.code]).toEqual([
        JSON.stringify(body),
        400,
        "invalid_webhook",
      ]);
    }
    expect((await hook({ raw: "", uuid: "u-bad" })).status).toBe(400);
    expect(await rows()).toEqual(before);
  });

  test("a delivery id that is not printable text of a sane length is a 400", async () => {
    const before = await rows();
    for (const uuid of ["has space", "x".repeat(129), "tab\there"]) {
      expect([uuid, (await hook({ uuid })).status]).toEqual([uuid, 400]);
    }
    expect(await rows()).toEqual(before);
  });

  test("a body over the cap is a 413, declared or streamed, and only a body that fits is read", async () => {
    const before = await rows();
    const big = JSON.stringify({ ...PUSH, pad: "x".repeat(MAX_WEBHOOK_BYTES) });
    expect((await hook({ raw: big, uuid: "u-big" })).status).toBe(413);
    const stream = new ReadableStream({
      start(c) {
        const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
        for (let i = 0; i < MAX_WEBHOOK_BYTES / chunk.length + 2; i++) c.enqueue(chunk);
        c.close();
      },
    });
    expect((await hook({ raw: stream, uuid: "u-big" })).status).toBe(413);
    expect(await rows()).toEqual(before);
    const fits = JSON.stringify({ ...PUSH, pad: "x".repeat(MAX_WEBHOOK_BYTES - 1000) });
    expect((await hook({ raw: fits, uuid: "u-fits" })).status).toBe(200);
  });

  test("the cap is exact: this many bytes are read, one more is refused", async () => {
    const pad = (n: number) => JSON.stringify({ ...PUSH, pad: "x".repeat(n) });
    const base = new TextEncoder().encode(pad(0)).length;
    const exact = pad(MAX_WEBHOOK_BYTES - base);
    expect(new TextEncoder().encode(exact).length).toBe(MAX_WEBHOOK_BYTES);
    expect((await hook({ raw: exact, uuid: "u-exact" })).status).toBe(200);
    expect((await hook({ raw: `${exact} `, uuid: "u-over" })).status).toBe(413);
  });

  test("only JSON bodies are accepted", async () => {
    expect((await hook({ type: "text/plain", raw: "x" })).status).toBe(415);
    expect((await hook({ type: "application/x-www-form-urlencoded", raw: "a=b" })).status).toBe(
      415,
    );
  });
});

describe("one job per delivery", () => {
  const count = async (id: string) =>
    (await jobsFor(c1)).filter((j) => j.payload.deliveryId === id).length;

  test("a repeated delivery id is answered 200 duplicate and creates nothing", async () => {
    expect((await hook({ uuid: "u-dup" })).json).toEqual({ status: "queued" });
    expect((await hook({ uuid: "u-dup" })).json).toEqual({ status: "duplicate" });
    expect((await hook({ uuid: "u-dup", event: "Pipeline Hook" })).json).toEqual({
      status: "duplicate",
    });
    expect(await count("u-dup")).toBe(1);
  });

  test("Idempotency-Key wins over X-Gitlab-Event-UUID", async () => {
    expect((await hook({ idem: "k-1", uuid: "u-1" })).json.status).toBe("queued");
    expect((await hook({ idem: "k-1", uuid: "u-2" })).json.status).toBe("duplicate"); // same key
    expect((await hook({ idem: "k-2", uuid: "u-1" })).json.status).toBe("queued"); // same uuid, new key
    expect((await jobsFor(c1)).filter((j) => j.payload.deliveryId === "k-1")).toHaveLength(1);
  });

  test("the same id on another connection is its own delivery", async () => {
    expect((await hook({ conn: c2, token: s2, uuid: "u-dup" })).json.status).toBe("queued");
  });

  test("simultaneous deliveries of one id make one job", async () => {
    const answers = await Promise.all(Array.from({ length: 8 }, () => hook({ uuid: "u-race" })));
    expect(answers.filter((a) => a.json.status === "queued")).toHaveLength(1);
    expect(answers.filter((a) => a.json.status === "duplicate")).toHaveLength(7);
    expect(await count("u-race")).toBe(1);
  });

  test("without a delivery id every request is a job", async () => {
    const before = (await jobsFor(c1)).length;
    expect((await hook({})).json.status).toBe("queued");
    expect((await hook({})).json.status).toBe("queued");
    expect((await jobsFor(c1)).length).toBe(before + 2);
  });

  test("a handler that fails is retried by the worker, and the job runs again with its payload", async () => {
    expect((await hook({ uuid: "u-retry" })).json.status).toBe("queued");
    const seen: number[] = [];
    const worker = createWorker({
      db: t.db,
      logger: createLogger({ level: "error", write: () => {} }),
      pollMs: 10,
      backoff: () => 0,
      handlers: {
        [WEBHOOK_QUEUE]: async ({ payload, attempt }) => {
          if (payload.deliveryId !== "u-retry") return;
          seen.push(attempt);
          if (attempt === 1) throw new Error("boom");
        },
      },
    });
    worker.start();
    try {
      for (let i = 0; i < 500 && seen.length < 2; i++) await Bun.sleep(10);
    } finally {
      await worker.stop();
    }
    expect(seen).toEqual([1, 2]);
    const job = (await jobsFor(c1)).find((j) => j.payload.deliveryId === "u-retry");
    expect(job).toMatchObject({ status: "done", attempts: 2 });
    expect((await hook({ uuid: "u-retry" })).json.status).toBe("duplicate"); // a retry is not a new job
  });
});

describe("nothing secret is written down", () => {
  test("no webhook secret, token header or stored hash reaches a log line, an audit row or a job", async () => {
    const written = [
      lines.join("\n"),
      JSON.stringify(await t.db.select().from(auditEvents)),
      JSON.stringify(await t.db.select().from(jobs)),
      JSON.stringify(await t.db.select().from(webhookDeliveries)),
    ].join("\n");
    expect(issued.length).toBeGreaterThan(3);
    for (const secret of [...issued, "wrong"]) {
      expect(written).not.toContain(secret);
      expect(written).not.toContain(hashToken(secret));
    }
    expect(written).not.toContain(CANARY);
    expect(lines.some((l) => l.includes("webhook refused"))).toBe(true);
    expect(lines.some((l) => l.includes("webhook received"))).toBe(true);
  });
});
