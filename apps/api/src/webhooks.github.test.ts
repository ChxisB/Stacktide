import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
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
import { deploymentEvent } from "./deployments";
import { mrEvent } from "./mr-plan";
import { pipelineEvent } from "./pipeline-runs";
import { MAX_WEBHOOK_BYTES } from "./routes/webhooks";
import { hashToken, randomToken } from "./tokens";

// FRG-21: GitHub signs the body of a delivery (`X-Hub-Signature-256`), so the receiver reads the body, up to the cap,
// and checks the signature against the connection's sealed secret before it looks at anything in it.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const CANARY = "CANARY-FREE-TEXT-7781-do-not-queue";
const SECRET = "whsec-not-real-CANARY-0123456789abcdef";
const SECRET_2 = "whsec-other-org-CANARY-fedcba9876543210";
const REPO = 4242;

let t: TestDb;
let o1: string;
let o2: string;
let gh: string; // o1, GitHub, has a secret
let gh2: string; // o2, GitHub, has another secret
let bare: string; // o1, GitHub, never given a secret
let gl: string; // o1, GitLab type, has a (GitLab) secret hash
let empty: string; // o1, GitHub, a secret that is the empty string
let cookie: string;
const lines: string[] = [];
const responses: string[] = [];

const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
let api: ReturnType<typeof createApp>;

/** Every signature made here, so the leak test can look for each of them. */
const signatures: string[] = [];
const sign = (body: string, secret = SECRET) => {
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  signatures.push(hex);
  return `sha256=${hex}`;
};

interface Hook {
  conn?: string;
  secret?: string;
  /** The header as sent; `null` leaves it out. Left alone, it is a good signature of the body. */
  signature?: string | null;
  event?: string | null;
  delivery?: string | null;
  body?: unknown;
  raw?: string | ReadableStream;
  type?: string;
}
async function hook(h: Hook = {}) {
  const raw = h.raw ?? JSON.stringify("body" in h ? h.body : RUN);
  const headers: Record<string, string> = { "content-type": h.type ?? "application/json" };
  if (h.signature !== null) {
    headers["x-hub-signature-256"] =
      h.signature ?? sign(typeof raw === "string" ? raw : "stream", h.secret);
  }
  if (h.event !== null) headers["x-github-event"] = h.event ?? "workflow_run";
  if (h.delivery !== null) headers["x-github-delivery"] = h.delivery ?? crypto.randomUUID();
  const init: RequestInit & { duplex?: "half" } = { method: "POST", headers, body: raw };
  if (raw instanceof ReadableStream) init.duplex = "half";
  const res = await api.handle(
    new Request(`http://localhost/webhooks/github/${h.conn ?? gh}`, init),
  );
  const text = await res.text();
  responses.push(text);
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const repository = { id: REPO, full_name: "acme/svc", description: CANARY };
const RUN = {
  action: "completed",
  repository,
  workflow_run: {
    id: 9001,
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: "a".repeat(40),
    run_attempt: 2,
    display_title: `ship it ${CANARY}`,
    head_commit: { message: `fix ${CANARY}` },
  },
};
const JOB = {
  action: "waiting",
  repository,
  workflow_job: {
    id: 77,
    run_id: 9001,
    status: "waiting",
    conclusion: null,
    name: "apply",
    head_sha: "b".repeat(40),
    head_branch: "main",
    labels: [CANARY],
  },
};
const PULL = {
  action: "synchronize",
  number: 12,
  repository,
  pull_request: {
    number: 12,
    state: "open",
    title: `title ${CANARY}`,
    body: `body ${CANARY}`,
    head: { ref: "feature", sha: "c".repeat(40), repo: { id: 999 } },
    base: { ref: "main" },
  },
};
const COMMENT = {
  action: "created",
  repository,
  issue: { number: 12, title: CANARY, pull_request: { url: "https://api.github.test/pulls/12" } },
  comment: { id: 555, body: `orch apply ${CANARY}`, user: { id: 1, login: "mallory" } },
};
const REVIEW = {
  action: "requested",
  repository,
  environment: "prod",
  comment: CANARY,
  workflow_run: { id: 9001, display_title: CANARY },
  approver: { login: "mallory" },
};

const sameButForId = (problem: { request_id?: string }) => ({ ...problem, request_id: undefined });
const allJobs = () => t.db.select().from(jobs).where(eq(jobs.queue, WEBHOOK_QUEUE));
const deliveries = () => t.db.select().from(webhookDeliveries);
const rows = async () => ({
  jobs: (await allJobs()).length,
  deliveries: (await deliveries()).length,
});

beforeAll(async () => {
  t = await createTestDb();
  o1 = (await createOrganization(t.db, { slug: "one", name: "one" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "two" })).id;
  let n = 0;
  const make = async (org: string, type: string, webhookSecret?: string) =>
    (
      await createConnection(t.db, keys, {
        organizationId: org,
        type,
        name: `c${++n}`,
        config: { baseUrl: "https://github.test" },
        token: "ghp_not-a-real-token-1234567890",
        webhookSecret,
      })
    ).id;
  gh = await make(o1, "github", SECRET);
  gh2 = await make(o2, "github", SECRET_2);
  bare = await make(o1, "github");
  // a GitLab connection never has a sealed secret; it is given one anyway, to show the type decides
  gl = await make(o1, "gitlab", SECRET);
  empty = await make(o1, "github", "");
  const user = await upsertUser(t.db, { gitlabId: 811, username: "alice", name: "alice" });
  const session = randomToken();
  await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
  cookie = `orch_session=${session}`;
  const roles: Pick<Subject, "orgRoles" | "projectRoles"> = {
    orgRoles: { [o1]: "admin", [o2]: "admin" },
    projectRoles: {},
  };
  api = createApp({
    logger,
    db: t.db,
    principal: callerPrincipal({ db: t.db, roles: () => roles }),
    ready: async () => {},
    keys,
  });
});
afterAll(async () => {
  await t.drop();
});

describe("a delivery with a good signature", () => {
  test("becomes one job with the fields picked from it, and the delivery is recorded", async () => {
    const delivery = crypto.randomUUID();
    const res = await hook({ delivery });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ status: "queued" });
    const job = (await allJobs()).find((j) => j.payload.deliveryId === delivery);
    expect(job?.payload).toEqual({
      connectionId: gh,
      organizationId: o1,
      event: "workflow_run",
      deliveryId: delivery,
      projectId: REPO,
      action: "completed",
      pipelineId: 9001,
      status: "completed",
      conclusion: "failure",
      ref: "main",
      sha: "a".repeat(40),
      attempt: 2,
    });
    const [row] = (await deliveries()).filter((d) => d.deliveryId === delivery);
    expect(row).toMatchObject({ connectionId: gh, event: "workflow_run", jobId: job?.id });
  });

  // each event is named as GitHub names it, so none of them is a GitLab event to a consumer written for GitLab
  const cases: [string, unknown, Record<string, unknown>][] = [
    [
      "workflow_job",
      JOB,
      {
        action: "waiting",
        jobId: 77,
        pipelineId: 9001,
        status: "waiting",
        name: "apply",
        ref: "main",
        sha: "b".repeat(40),
      },
    ],
    [
      "pull_request",
      PULL,
      {
        action: "synchronize",
        iid: 12,
        state: "open",
        sourceBranch: "feature",
        targetBranch: "main",
        sha: "c".repeat(40),
        headRepositoryId: 999,
      },
    ],
    ["issue_comment", COMMENT, { action: "created", noteId: 555, mrIid: 12 }],
    ["deployment_review", REVIEW, { action: "requested", environment: "prod", pipelineId: 9001 }],
  ];
  for (const [event, body, picked] of cases) {
    test(`${event}: only the picked fields reach the job`, async () => {
      const delivery = crypto.randomUUID();
      expect((await hook({ event, body, delivery })).json).toEqual({ status: "queued" });
      const job = (await allJobs()).find((j) => j.payload.deliveryId === delivery);
      expect(job?.payload).toEqual({
        connectionId: gh,
        organizationId: o1,
        event,
        deliveryId: delivery,
        projectId: REPO,
        ...picked,
      });
      // titles, bodies, messages and logins are free text from whoever wrote them
      expect(JSON.stringify(job?.payload)).not.toContain(CANARY);
      expect(JSON.stringify(job?.payload)).not.toContain("mallory");
    });
  }

  test("a job from GitHub is not an event to the consumers written for GitLab", async () => {
    for (const event of ["workflow_run", "workflow_job", "pull_request", "issue_comment"]) {
      const job = (await allJobs()).find((j) => j.payload.event === event);
      expect(job).toBeDefined();
      for (const schema of [pipelineEvent, mrEvent, deploymentEvent]) {
        expect(schema.safeParse(job?.payload).success).toBe(false);
      }
    }
  });

  test("a field of the wrong kind or too long is left out, not carried", async () => {
    const delivery = crypto.randomUUID();
    const body = {
      ...RUN,
      workflow_run: { ...RUN.workflow_run, head_branch: "x".repeat(201), status: { a: 1 } },
    };
    expect((await hook({ body, delivery })).status).toBe(200);
    const job = (await allJobs()).find((j) => j.payload.deliveryId === delivery);
    expect(job?.payload.ref).toBeUndefined();
    expect(job?.payload.status).toBeUndefined();
    expect(job?.payload.pipelineId).toBe(9001);
  });

  test("a repeated delivery id is queued once", async () => {
    const delivery = crypto.randomUUID();
    expect((await hook({ delivery })).json).toEqual({ status: "queued" });
    const before = await rows();
    expect((await hook({ delivery })).json).toEqual({ status: "duplicate" });
    expect(await rows()).toEqual(before);
  });

  test("the same delivery id on another connection is another delivery", async () => {
    const delivery = crypto.randomUUID();
    expect((await hook({ delivery })).json).toEqual({ status: "queued" });
    expect((await hook({ delivery, conn: gh2, secret: SECRET_2 })).json).toEqual({
      status: "queued",
    });
  });

  test("a ping, an event nobody asked for and a comment on an issue are acknowledged and dropped", async () => {
    const before = await rows();
    for (const [event, body] of [
      ["ping", { zen: "Keep it logically awesome.", hook_id: 1 }],
      ["push", { ref: "refs/heads/main", repository }],
      ["issue_comment", { ...COMMENT, issue: { number: 3, title: CANARY } }],
      ["constructor", {}],
    ] as const) {
      const res = await hook({ event, body });
      expect([event, res.status, res.json]).toEqual([event, 200, { status: "ignored" }]);
    }
    expect(await rows()).toEqual(before);
  });
});

describe("a delivery that cannot be verified", () => {
  const refusals: [string, Hook][] = [
    ["signed with another secret", { secret: "whsec-wrong" }],
    ["signed with another connection's secret", { secret: SECRET_2 }],
    ["a signature of another body", { signature: sign("{}") }],
    ["no signature", { signature: null }],
    ["an empty signature", { signature: "" }],
    ["the old sha1 header's form", { signature: `sha1=${"0".repeat(40)}` }],
    ["no algorithm prefix", { signature: createHmac("sha256", SECRET).update("{}").digest("hex") }],
    ["a signature of the wrong length", { signature: `sha256=${"0".repeat(63)}` }],
    ["a signature that is not hex", { signature: `sha256=${"z".repeat(64)}` }],
    ["a signature in capitals", { signature: sign(JSON.stringify(RUN)).toUpperCase() }],
  ];
  for (const [what, h] of refusals) {
    test(`${what} is a 401, and nothing is stored`, async () => {
      const before = await rows();
      const res = await hook(h);
      expect(res.status).toBe(401);
      expect(res.json.code).toBe("invalid_webhook_token");
      expect(await rows()).toEqual(before);
    });
  }

  test("a body changed after it was signed is a 401", async () => {
    const before = await rows();
    const signed = JSON.stringify(RUN);
    const tampered = signed.replace("9001", "9002");
    expect(tampered).not.toBe(signed);
    expect((await hook({ raw: tampered, signature: sign(signed) })).status).toBe(401);
    expect(await rows()).toEqual(before);
  });

  test("a body with whitespace the signature did not cover is a 401", async () => {
    const before = await rows();
    const signed = JSON.stringify(RUN);
    expect((await hook({ raw: `${signed}\n`, signature: sign(signed) })).status).toBe(401);
    expect((await hook({ raw: ` ${signed}`, signature: sign(signed) })).status).toBe(401);
    expect(await rows()).toEqual(before);
  });

  test("a signature of the wrong form is refused before the body is read: a 401, not a 413", async () => {
    const big = JSON.stringify({ ...RUN, pad: "x".repeat(MAX_WEBHOOK_BYTES) });
    const hex = createHmac("sha256", SECRET).update(big).digest("hex");
    for (const signature of [
      "nope",
      `sha256=${hex.toUpperCase()}`,
      `sha256=${hex}0`,
      `v1 sha256=${hex}`,
      `sha256=${hex.slice(1)}`,
    ]) {
      expect([signature, (await hook({ raw: big, signature })).status]).toEqual([signature, 401]);
    }
    // a good one gets as far as the cap
    expect((await hook({ raw: big, signature: `sha256=${hex}` })).status).toBe(413);
  });

  test("an event or a delivery that nobody can vouch for is a 401, not ignored", async () => {
    const before = await rows();
    expect((await hook({ event: "ping", signature: null })).status).toBe(401);
    expect((await hook({ event: "push", secret: "whsec-wrong" })).status).toBe(401);
    expect((await hook({ delivery: null, secret: "whsec-wrong" })).status).toBe(401);
    expect(await rows()).toEqual(before);
  });

  test("an unknown connection, one that is not GitHub's and one with no secret answer the same 401", async () => {
    const before = await rows();
    const wrong = await hook({ secret: "whsec-wrong" });
    expect(wrong.status).toBe(401);
    for (const h of [
      { conn: crypto.randomUUID() },
      { conn: "not-a-uuid" },
      { conn: gl },
      { conn: bare },
      { conn: bare, secret: "" },
      // an empty key would sign anything: it counts as no secret
      { conn: empty, secret: "" },
    ]) {
      const res = await hook(h);
      expect([h.conn, res.status, sameButForId(res.json)]).toEqual([
        h.conn,
        401,
        sameButForId(wrong.json),
      ]);
    }
    expect(await rows()).toEqual(before);
  });

  test("a GitLab webhook token does not open the GitHub receiver, nor the other way round", async () => {
    const before = await rows();
    const body = JSON.stringify(RUN);
    const res = await api.handle(
      new Request(`http://localhost/webhooks/github/${gh}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-token": SECRET,
          "x-github-event": "workflow_run",
          "x-github-delivery": crypto.randomUUID(),
        },
        body,
      }),
    );
    expect(res.status).toBe(401);
    const back = await api.handle(
      new Request(`http://localhost/webhooks/gitlab/${gh}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-token": SECRET,
          "x-gitlab-event": "Push Hook",
          "x-hub-signature-256": sign(body),
        },
        body,
      }),
    );
    expect(back.status).toBe(401);
    expect(await rows()).toEqual(before);
  });
});

describe("a delivery that is signed but not usable", () => {
  test("no delivery id, or one that is not printable text of a sane length, is a 400", async () => {
    const before = await rows();
    for (const delivery of [null, "", "has space", "x".repeat(129), "tab\there"]) {
      expect([delivery, (await hook({ delivery })).status]).toEqual([delivery, 400]);
    }
    expect(await rows()).toEqual(before);
  });

  test("a body that is not JSON, or has no repository, is a 400", async () => {
    const before = await rows();
    expect((await hook({ raw: "not json" })).status).toBe(400);
    expect((await hook({ body: { action: "completed" } })).status).toBe(400);
    expect((await hook({ body: { repository: { id: "7" } } })).status).toBe(400);
    expect((await hook({ body: { repository: { id: 0 } } })).status).toBe(400);
    expect((await hook({ body: [] })).status).toBe(400);
    expect(await rows()).toEqual(before);
  });

  test("only JSON bodies are accepted", async () => {
    expect(
      (await hook({ type: "application/x-www-form-urlencoded", raw: "payload=%7B%7D" })).status,
    ).toBe(415);
  });

  test("a body over the cap is a 413, declared or streamed; one that fits is read", async () => {
    const before = await rows();
    const big = JSON.stringify({ ...RUN, pad: "x".repeat(MAX_WEBHOOK_BYTES) });
    expect((await hook({ raw: big })).status).toBe(413);
    const stream = new ReadableStream({
      start(c) {
        const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
        for (let i = 0; i < MAX_WEBHOOK_BYTES / chunk.length + 2; i++) c.enqueue(chunk);
        c.close();
      },
    });
    expect((await hook({ raw: stream, signature: sign("x") })).status).toBe(413);
    expect(await rows()).toEqual(before);
    const fits = JSON.stringify({ ...RUN, pad: "x".repeat(MAX_WEBHOOK_BYTES - 1000) });
    expect((await hook({ raw: fits })).status).toBe(200);
  });
});

describe("the secret", () => {
  test("a GitHub connection's webhook secret is set when it is made, not issued by the platform", async () => {
    const res = await api.handle(
      new Request(`http://localhost/organizations/${o1}/connections/${gh}/webhook-secret`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("webhook_secret_set_at_creation");
    // the one it has still works
    expect((await hook()).status).toBe(200);
  });

  test("another organization's admin is told nothing of a GitHub connection", async () => {
    const res = await api.handle(
      new Request(`http://localhost/organizations/${o2}/connections/${gh}/webhook-secret`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("appears in no response, job, delivery, audit event or log line", async () => {
    expect(signatures.length).toBeGreaterThan(10);
    const haystack = JSON.stringify([
      responses,
      await t.db.select().from(jobs),
      await deliveries(),
      await t.db.select().from(auditEvents),
      lines,
    ]);
    expect(lines.some((l) => l.includes("webhook refused"))).toBe(true);
    for (const needle of [SECRET, SECRET_2, ...signatures]) expect(haystack).not.toContain(needle);
    // nor does free text from a delivery reach a job or a log line
    expect(JSON.stringify([await t.db.select().from(jobs), lines])).not.toContain(CANARY);
  });
});
