import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  auditEvents,
  createApiToken,
  createCiToken,
  createOrganization,
  createProject,
  createRun,
  createSession,
  getPlanResources,
  getRun,
  listStackDrift,
  moveRunStack,
  type NewStack,
  recordStackJobs,
  runs,
  syncStacks,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { devPrincipal } from "./principal";
import { MAX_SUMMARY_BYTES } from "./routes/runs";
import { hashToken, newApiToken, newCiToken, randomToken } from "./tokens";

let t: TestDb;
let app: ReturnType<typeof makeApp>;
const ids = {} as Record<"o1" | "p1" | "p2" | "run", string>;
const people = {} as Record<"alice" | "carol", { id: string; token: string; gitlabId: number }>;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();

const logLines: string[] = [];
const makeApp = (principal = callerPrincipal({ db: t.db, roles: rolesOf })) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => logLines.push(line) }),
    db: t.db,
    principal,
    ready: async () => {},
  });
const rolesOf = (u: { gitlabId: number }) =>
  roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} };

const stack = (name: string): NewStack => ({
  name,
  path: name,
  tool: "tofu",
  version: "1.9.8",
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command",
  backend: "http",
});

const SHA = "c".repeat(40);
const REF = "feature/net";
// the GitLab ids of the summary jobs recorded for the run's stacks
const NET_JOB = 901;
const APP_JOB = 902;

beforeAll(async () => {
  t = await createTestDb();
  ids.o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  ids.p1 = (await createProject(t.db, { organizationId: ids.o1, name: "p1" })).id;
  ids.p2 = (await createProject(t.db, { organizationId: ids.o1, name: "p2" })).id;
  await syncStacks(t.db, ids.o1, ids.p1, ["net", "app", "db"].map(stack), { prune: false });
  await syncStacks(t.db, ids.o1, ids.p2, ["net"].map(stack), { prune: false });
  for (const name of ["alice", "carol"] as const) {
    const gitlabId = name === "alice" ? 601 : 602;
    const user = await upsertUser(t.db, { gitlabId, username: name, name });
    const token = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(token), ttlMs: 60_000 });
    people[name] = { id: user.id, token, gitlabId };
  }
  roleTable.set(people.alice.gitlabId, { orgRoles: { [ids.o1]: "owner" }, projectRoles: {} });
  roleTable.set(people.carol.gitlabId, { orgRoles: { [ids.o1]: "member" }, projectRoles: {} });
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

/** A run of `net` and `app` whose summary jobs are known, as the ingest of pipeline events leaves it. */
async function newRun(jobs: Record<string, number | undefined> = { net: NET_JOB, app: APP_JOB }) {
  const run = await createRun(t.db, {
    organizationId: ids.o1,
    projectId: ids.p1,
    ref: REF,
    sha: SHA,
    stacks: ["net", "app"],
  });
  for (const [name, summaryJobId] of Object.entries(jobs)) {
    if (summaryJobId !== undefined) {
      await recordStackJobs(t.db, ids.o1, ids.p1, run.id, name, { summaryJobId });
    }
  }
  return run.id;
}

/** A CI token as `/auth/ci/exchange` issues it to a job in no environment. */
async function ciToken(
  over: { projectId?: string; jobId?: number | null; ref?: string; scopes?: string[] } = {},
) {
  const fresh = newCiToken();
  const row = await createCiToken(t.db, {
    organizationId: ids.o1,
    projectId: over.projectId ?? ids.p1,
    tokenHash: fresh.tokenHash,
    scopes: over.scopes ?? ["project.read", "run.summary"],
    gitlabProjectId: 4242,
    gitlabJobId: over.jobId === null ? undefined : (over.jobId ?? NET_JOB),
    ref: over.ref ?? REF,
    refProtected: false,
    ttlMs: 60_000,
  });
  return { bearer: fresh.token, id: row.id };
}

const summaryPath = (runId: string, project = ids.p1) =>
  `/organizations/${ids.o1}/projects/${project}/runs/${runId}/plan-summary`;
const summary = (extra: Record<string, unknown> = {}) => ({
  stack: "net",
  add: 2,
  change: 1,
  destroy: 0,
  resources: [
    { address: "aws_s3_bucket.logs", actions: ["create"] },
    { address: "module.vpc.aws_subnet.a[0]", actions: ["create"] },
    { address: "aws_instance.web", actions: ["update"] },
  ],
  ...extra,
});

interface Send {
  bearer?: string;
  cookie?: string;
  raw?: string;
  type?: string;
  on?: typeof app;
}
async function post(path: string, body: unknown, { bearer, cookie, raw, type, on }: Send = {}) {
  const headers: Record<string, string> = { "content-type": type ?? "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (cookie) headers.cookie = `orch_session=${cookie}`;
  const res = await (on ?? app).handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body: raw ?? JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const stackRow = async (runId: string, name: string) => {
  const run = await getRun(t.db, ids.o1, ids.p1, runId);
  return run?.stacks.find((s) => s.stack === name);
};
const audits = (runId: string) =>
  t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "run.summary"), eq(auditEvents.resourceId, runId)));

describe("the summary job of a stack", () => {
  test("stores the counts and the resources, and the audit event says who and how many, not which", async () => {
    const runId = await newRun();
    const token = await ciToken();
    const res = await post(summaryPath(runId), summary(), { bearer: token.bearer });
    expect(res.status).toBe(204);
    expect(res.text).toBe("");

    expect(await stackRow(runId, "net")).toMatchObject({
      planAdd: 2,
      planChange: 1,
      planDestroy: 0,
      summarizedAt: expect.any(Date),
    });
    expect(await getPlanResources(t.db, ids.o1, ids.p1, runId, "net")).toEqual(summary().resources);
    expect(await stackRow(runId, "app")).toMatchObject({ planAdd: null, summarizedAt: null });

    const rows = await audits(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: "ci",
      actorId: token.id,
      organizationId: ids.o1,
      projectId: ids.p1,
      resourceType: "run",
      metadata: { stack: "net", add: 2, change: 1, destroy: 0, resources: 3 },
    });
    // a plan names what is built: that is for the run's readers, not for the audit trail
    expect(JSON.stringify(rows)).not.toContain("aws_s3_bucket");
  });

  test("may post again: the later summary replaces the earlier one", async () => {
    const runId = await newRun();
    const first = await ciToken();
    expect((await post(summaryPath(runId), summary(), { bearer: first.bearer })).status).toBe(204);
    const again = await ciToken();
    const next = summary({ add: 0, change: 0, destroy: 1, resources: [] });
    expect((await post(summaryPath(runId), next, { bearer: again.bearer })).status).toBe(204);
    expect(await stackRow(runId, "net")).toMatchObject({ planAdd: 0, planDestroy: 1 });
    expect(await getPlanResources(t.db, ids.o1, ids.p1, runId, "net")).toEqual([]);
    expect(await audits(runId)).toHaveLength(2);
  });

  test("each stack is posted by its own job", async () => {
    const runId = await newRun();
    const app_ = await ciToken({ jobId: APP_JOB });
    expect(
      (await post(summaryPath(runId), summary({ stack: "app", add: 9 }), { bearer: app_.bearer }))
        .status,
    ).toBe(204);
    expect(await stackRow(runId, "app")).toMatchObject({ planAdd: 9 });
    expect(await stackRow(runId, "net")).toMatchObject({ planAdd: null });
  });

  test("is accepted while the stack is planned, and no longer once an apply began or it ended", async () => {
    const runId = await newRun();
    const token = await ciToken();
    for (const [from, to] of [
      ["queued", "planning"],
      ["planning", "planned"],
    ] as const) {
      await moveRunStack(t.db, ids.o1, ids.p1, runId, "net", from, to);
      expect((await post(summaryPath(runId), summary(), { bearer: token.bearer })).status).toBe(
        204,
      );
    }
    await moveRunStack(t.db, ids.o1, ids.p1, runId, "net", "planned", "applying");
    const late = await post(summaryPath(runId), summary({ add: 77 }), { bearer: token.bearer });
    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({ code: "stack_closed" });
    expect(await stackRow(runId, "net")).toMatchObject({ planAdd: 2 });
    expect(await audits(runId)).toHaveLength(2);
  });

  test("is refused 409 for a stack whose plan failed", async () => {
    const runId = await newRun();
    await moveRunStack(t.db, ids.o1, ids.p1, runId, "net", "queued", "failed", "the plan failed");
    const res = await post(summaryPath(runId), summary(), { bearer: (await ciToken()).bearer });
    expect(res.status).toBe(409);
    expect(await stackRow(runId, "net")).toMatchObject({ planAdd: null });
    expect(await audits(runId)).toHaveLength(0);
  });
});

describe("a caller that is not the stack's summary job", () => {
  const nothingStored = async (runId: string) => {
    expect(await stackRow(runId, "net")).toMatchObject({ planAdd: null, summarizedAt: null });
    expect(await stackRow(runId, "app")).toMatchObject({ planAdd: null, summarizedAt: null });
    expect(await audits(runId)).toHaveLength(0);
  };

  test("is refused 403 with the same words whatever it got wrong, and nothing is stored", async () => {
    const runId = await newRun();
    const lone = await newRun({ app: APP_JOB }); // `net` has no summary job recorded
    const attempts: [string, string, unknown, string][] = [
      ["another job", runId, summary(), (await ciToken({ jobId: 999 })).bearer],
      ["the other stack's job", runId, summary(), (await ciToken({ jobId: APP_JOB })).bearer],
      ["another ref", runId, summary(), (await ciToken({ ref: "main" })).bearer],
      [
        "a ref that differs in case",
        runId,
        summary(),
        (await ciToken({ ref: "Feature/net" })).bearer,
      ],
      ["a token with no job id", runId, summary(), (await ciToken({ jobId: null })).bearer],
      [
        "a stack of the project that is not in the run",
        runId,
        summary({ stack: "db" }),
        (await ciToken()).bearer,
      ],
      ["a stack that does not exist", runId, summary({ stack: "ghost" }), (await ciToken()).bearer],
      ["a stack whose summary job is not known yet", lone, summary(), (await ciToken()).bearer],
      // two unknowns are not a match
      [
        "a token with no job id, for a stack with no summary job",
        lone,
        summary(),
        (await ciToken({ jobId: null })).bearer,
      ],
    ];
    const details = new Set<string>();
    for (const [what, run, body, bearer] of attempts) {
      const res = await post(summaryPath(run), body, { bearer });
      expect([what, res.status]).toEqual([what, 403]);
      expect(res.json).toMatchObject({ code: "forbidden" });
      details.add(res.json.detail);
    }
    expect(details.size).toBe(1);
    await nothingStored(runId);
    await nothingStored(lone);
  });

  test("a token whose job id matches but is for another project cannot reach this one", async () => {
    const runId = await newRun();
    const other = await ciToken({ projectId: ids.p2 });
    // it holds no role on p1, so p1 and its runs are not found for it
    const res = await post(summaryPath(runId), summary(), { bearer: other.bearer });
    expect(res.status).toBe(404);
    await nothingStored(runId);
  });

  test("a job in an environment holds no run.summary scope", async () => {
    const runId = await newRun();
    const env = await ciToken({ scopes: ["project.read", "environment.read", "secret.reveal"] });
    const res = await post(summaryPath(runId), summary(), { bearer: env.bearer });
    expect(res.status).toBe(403);
    expect(res.json.detail).toContain("run.summary");
    await nothingStored(runId);
  });

  test("people, API tokens and the dev stand-in are refused 403 even where they may read the run", async () => {
    const runId = await newRun();
    for (const who of ["alice", "carol"] as const) {
      const res = await post(summaryPath(runId), summary(), { cookie: people[who].token });
      expect([who, res.status]).toEqual([who, 403]);
    }
    const fresh = newApiToken();
    await createApiToken(t.db, {
      userId: people.alice.id,
      name: "t",
      prefix: fresh.prefix,
      tokenHash: fresh.tokenHash,
      scopes: ["run.summary", "run.read", "project.read"],
      ttlMs: 60_000,
    });
    expect((await post(summaryPath(runId), summary(), { bearer: fresh.token })).status).toBe(403);
    const dev = makeApp(devPrincipal);
    expect((await post(summaryPath(runId), summary(), { on: dev })).status).toBe(403);
    await nothingStored(runId);
  });

  test("nobody at all is 401, and an expired or unknown token is nobody", async () => {
    const runId = await newRun();
    expect((await post(summaryPath(runId), summary())).status).toBe(401);
    expect((await post(summaryPath(runId), summary(), { bearer: newCiToken().token })).status).toBe(
      401,
    );
    // unauthenticated callers learn nothing about the body either
    expect((await post(summaryPath(runId), { nonsense: true })).status).toBe(401);
    await nothingStored(runId);
  });

  test("a run that does not exist, or belongs to another project, is 404", async () => {
    const runId = await newRun();
    const { bearer } = await ciToken();
    expect((await post(summaryPath(crypto.randomUUID()), summary(), { bearer })).status).toBe(404);
    // the same run id under the project the token does not belong to
    const wrong = await post(summaryPath(runId, ids.p2), summary(), { bearer });
    expect(wrong.status).toBe(404);
  });
});

describe("what a summary may hold", () => {
  const send = async (body: unknown, raw?: string, type?: string) => {
    const runId = await newRun();
    const { bearer } = await ciToken();
    return { runId, ...(await post(summaryPath(runId), body, { bearer, raw, type })) };
  };
  const refused = async (what: string, body: unknown) => {
    const res = await send(body);
    expect([what, res.status]).toEqual([what, 422]);
    expect(await stackRow(res.runId, "net")).toMatchObject({ planAdd: null });
    // no part of the submitted value comes back
    expect(res.text).not.toContain("evil");
  };

  test("500 resources are the most, 501 is 422", async () => {
    const list = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        address: `null_resource.r${i}`,
        actions: ["create"],
      }));
    expect((await send(summary({ resources: list(500) }))).status).toBe(204);
    await refused("501 resources", summary({ resources: list(501) }));
  });

  test("an address is 1 to 1024 characters, none of them one that hides or reorders text", async () => {
    // other scripts are fine
    expect(
      (
        await send(
          summary({ resources: [{ address: 'module.m["é-ключ-鍵"].r', actions: ["create"] }] }),
        )
      ).status,
    ).toBe(204);
    for (const [what, c] of [
      ["a right-to-left override", "\u202e"],
      ["a zero-width space", "\u200b"],
      ["a bidi isolate", "\u2066"],
      ["a line separator", "\u2028"],
      ["a paragraph separator", "\u2029"],
    ] as const) {
      await refused(what, summary({ resources: [{ address: `a${c}b`, actions: ["create"] }] }));
    }
    // the largest list the route lets through is stored: 500 addresses of 1024 quote marks
    const worst = Array.from({ length: 500 }, () => ({
      address: '"'.repeat(1024),
      actions: ["create"],
    }));
    expect((await send(summary({ resources: worst }))).status).toBe(204);
  });

  test("an address is 1 to 1024 characters with no control characters", async () => {
    expect(
      (await send(summary({ resources: [{ address: "a".repeat(1024), actions: ["create"] }] })))
        .status,
    ).toBe(204);
    await refused(
      "1025 characters",
      summary({ resources: [{ address: "a".repeat(1025), actions: ["create"] }] }),
    );
    await refused("empty", summary({ resources: [{ address: "", actions: ["create"] }] }));
    await refused(
      "a newline",
      summary({ resources: [{ address: "evil\nfoo", actions: ["create"] }] }),
    );
    await refused(
      "an escape",
      summary({ resources: [{ address: "evil\u001b[31m", actions: ["create"] }] }),
    );
    await refused(
      "a NUL",
      summary({ resources: [{ address: "evil\u0000", actions: ["create"] }] }),
    );
  });

  test("actions are one to four lowercase words, as terraform names them", async () => {
    const one = (actions: unknown) => summary({ resources: [{ address: "a.b", actions }] });
    expect((await send(one(["delete", "create"]))).status).toBe(204);
    expect((await send(one(["no-op"]))).status).toBe(204);
    await refused("none", one([]));
    await refused("five", one(["create", "create", "create", "create", "create"]));
    await refused("uppercase", one(["Create"]));
    await refused("markup", one(["evil<script>"]));
    await refused("not text", one([1]));
  });

  test("counts are whole numbers from 0 to a million", async () => {
    expect(
      (await send(summary({ add: 1_000_000, change: 0, destroy: 0, resources: [] }))).status,
    ).toBe(204);
    await refused("negative", summary({ add: -1 }));
    await refused("fraction", summary({ change: 1.5 }));
    await refused("too many", summary({ destroy: 1_000_001 }));
    await refused("text", summary({ add: "2" }));
    await refused("missing", { stack: "net", add: 1, change: 0, resources: [] });
  });

  test("nothing else: no extra fields, a stack name of 1 to 63 characters", async () => {
    await refused("a plan value", summary({ values: { password: "evil" } }));
    await refused(
      "a field in a resource",
      summary({
        resources: [{ address: "a.b", actions: ["create"], after: { password: "evil" } }],
      }),
    );
    await refused("no stack", { add: 1, change: 0, destroy: 0, resources: [] });
    await refused("a long stack", summary({ stack: "s".repeat(64) }));
    await refused("an empty stack", summary({ stack: "" }));
  });

  test("a body over 1 MiB is 413 and is not read further, valid JSON or not", async () => {
    const big = `${" ".repeat(MAX_SUMMARY_BYTES)}${JSON.stringify(summary())}`;
    const res = await send(undefined, big);
    expect(res.status).toBe(413);
    expect(res.json).toMatchObject({ code: "payload_too_large" });
    expect(await stackRow(res.runId, "net")).toMatchObject({ planAdd: null });
    const header = await send(undefined, "x".repeat(MAX_SUMMARY_BYTES + 1));
    expect(header.status).toBe(413);
  });

  test("a body that is not JSON is 400, or 415 when it does not say it is", async () => {
    expect((await send(undefined, "{not json")).status).toBe(400);
    expect((await send(undefined, "")).status).toBe(400);
    expect((await send(undefined, JSON.stringify(summary()), "text/plain")).status).toBe(415);
  });
});

describe("what a summary leaks", () => {
  test("a refusal is logged with its reason, and with nothing of the caller's token or body", async () => {
    const runId = await newRun();
    const wrong = await ciToken({ jobId: 999 });
    logLines.length = 0;
    const secret = summary({
      resources: [{ address: "aws_secretsmanager_secret.evil_name", actions: ["create"] }],
    });
    expect((await post(summaryPath(runId), secret, { bearer: wrong.bearer })).status).toBe(403);
    const mine = logLines.filter((l) => l.includes("plan summary refused"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain("the job is not the stack's summary job");
    for (const line of logLines) {
      expect(line).not.toContain("evil_name");
      expect(line).not.toContain(wrong.bearer);
    }
    // a person gets the same refusal and the log says why
    logLines.length = 0;
    expect((await post(summaryPath(runId), secret, { cookie: people.alice.token })).status).toBe(
      403,
    );
    expect(logLines.filter((l) => l.includes("the caller is not a CI job"))).toHaveLength(1);
  });

  test("a refused summary says nothing of what it held, and no response or audit row holds an address", async () => {
    const runId = await newRun();
    const wrong = await ciToken({ jobId: 999 });
    const secret = summary({
      resources: [{ address: "aws_secretsmanager_secret.evil_name", actions: ["create"] }],
    });
    const refusal = await post(summaryPath(runId), secret, { bearer: wrong.bearer });
    expect(refusal.status).toBe(403);
    expect(refusal.text).not.toContain("evil_name");
    const ok = await post(summaryPath(runId), secret, { bearer: (await ciToken()).bearer });
    expect(ok.status).toBe(204);
    expect(JSON.stringify(await audits(runId))).not.toContain("evil_name");
    // the run's own read does not carry the resource list: it has its own place, and its own reader
    const read = await app.handle(
      new Request(`http://localhost/organizations/${ids.o1}/projects/${ids.p1}/runs/${runId}`, {
        headers: { cookie: `orch_session=${people.alice.token}` },
      }),
    );
    expect(await read.text()).not.toContain("evil_name");
  });
});

describe("the summary of a drift run", () => {
  const DRIFT_REF = "main";
  const driftAudits = () =>
    t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "stack.drift"), eq(auditEvents.projectId, ids.p2)));
  const known = () => listStackDrift(t.db, ids.o1, ids.p2);
  const counts = (add: number, change = 0, destroy = 0) =>
    summary({ add, change, destroy, resources: [] });
  /** A run of `net` in the second project, and a token of its summary job. */
  async function driftRun(kind: "plan" | "drift", job: number) {
    const run = await createRun(t.db, {
      organizationId: ids.o1,
      projectId: ids.p2,
      ref: DRIFT_REF,
      sha: SHA,
      kind,
      stacks: ["net"],
    });
    await recordStackJobs(t.db, ids.o1, ids.p2, run.id, "net", { summaryJobId: job });
    const token = await ciToken({ projectId: ids.p2, ref: DRIFT_REF, jobId: job });
    return { runId: run.id, bearer: token.bearer, tokenId: token.id };
  }

  test("the summary of a plan run says nothing of drift", async () => {
    const r = await driftRun("plan", 910);
    const res = await post(summaryPath(r.runId, ids.p2), counts(3), { bearer: r.bearer });
    expect(res.status).toBe(204);
    expect(await known()).toEqual([]);
    expect(await driftAudits()).toEqual([]);
  });

  test("a stack that drifted is news once, however often it is found again, and so is its end", async () => {
    const first = await driftRun("drift", 911);
    expect(
      (await post(summaryPath(first.runId, ids.p2), counts(2, 1), { bearer: first.bearer })).status,
    ).toBe(204);
    expect(await known()).toMatchObject([
      { stack: "net", status: "drifted", planAdd: 2, planChange: 1, planDestroy: 0 },
    ]);
    const [detected] = await driftAudits();
    expect(detected).toMatchObject({
      actorKind: "ci",
      actorId: first.tokenId,
      organizationId: ids.o1,
      projectId: ids.p2,
      resourceType: "stack",
      resourceId: "net",
      metadata: { stack: "net", status: "drifted", add: 2, change: 1, destroy: 0 },
    });
    // a second run of the stack finds it still drifted: no second event, the counts are the latest
    const again = await driftRun("drift", 912);
    await post(summaryPath(again.runId, ids.p2), counts(0, 5), { bearer: again.bearer });
    expect(await driftAudits()).toHaveLength(1);
    expect(await known()).toMatchObject([{ status: "drifted", planAdd: 0, planChange: 5 }]);
    // the run's own summary is still audited, drift or not
    expect(
      await t.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "run.summary"), eq(auditEvents.resourceId, again.runId))),
    ).toHaveLength(1);

    const gone = await driftRun("drift", 913);
    await post(summaryPath(gone.runId, ids.p2), counts(0), { bearer: gone.bearer });
    expect(await known()).toMatchObject([{ status: "clean", since: null, planAdd: 0 }]);
    const events = await driftAudits();
    expect(events.map((e) => (e.metadata as { status: string }).status).sort()).toEqual([
      "clean",
      "drifted",
    ]);
  });

  test("a summary that is refused or arrives too late records nothing", async () => {
    const before = await known();
    const wrong = await driftRun("drift", 914);
    const other = await ciToken({ projectId: ids.p2, ref: DRIFT_REF, jobId: 999 });
    expect(
      (await post(summaryPath(wrong.runId, ids.p2), counts(9), { bearer: other.bearer })).status,
    ).toBe(403);
    await moveRunStack(t.db, ids.o1, ids.p2, wrong.runId, "net", "queued", "failed", "it failed");
    const late = await post(summaryPath(wrong.runId, ids.p2), counts(9), { bearer: wrong.bearer });
    expect(late.status).toBe(409);
    expect(await known()).toEqual(before);
    expect(await driftAudits()).toHaveLength(2);
  });

  test("a run that finishes after a newer one does not undo what the newer one found", async () => {
    const events = (await driftAudits()).length;
    const older = await driftRun("drift", 920);
    const newer = await driftRun("drift", 921);
    // asked for an hour apart, as they would be, not within the same millisecond
    await t.db
      .update(runs)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(runs.id, older.runId));
    expect(
      (await post(summaryPath(newer.runId, ids.p2), counts(3), { bearer: newer.bearer })).status,
    ).toBe(204);
    expect(
      (await post(summaryPath(older.runId, ids.p2), counts(0), { bearer: older.bearer })).status,
    ).toBe(204);
    expect(await known()).toMatchObject([{ status: "drifted", planAdd: 3 }]);
    expect(await driftAudits()).toHaveLength(events + 1);
  });
});
