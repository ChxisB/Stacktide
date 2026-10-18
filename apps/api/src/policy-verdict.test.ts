import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, judge, POLICY_RULE, type PolicyVerdict } from "@orch/core";
import {
  auditEvents,
  createCiToken,
  createOrganization,
  createProject,
  createRun,
  getRun,
  moveRunStack,
  type NewStack,
  recordStackJobs,
  ruleNames,
  syncStacks,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { POLICY_FILTER } from "@orch/iac";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { newCiToken } from "./tokens";

let t: TestDb;
let app: ReturnType<typeof makeApp>;
const ids = {} as Record<"o1" | "p1" | "p2", string>;
const logLines: string[] = [];
const makeApp = () =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => logLines.push(line) }),
    db: t.db,
    principal: callerPrincipal({ db: t.db, roles: () => ({ orgRoles: {}, projectRoles: {} }) }),
    ready: async () => {},
  });

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

const SHA = "d".repeat(40);
const REF = "feature/net";
const NET_JOB = 701;
const APP_JOB = 702;

beforeAll(async () => {
  t = await createTestDb();
  ids.o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  ids.p1 = (await createProject(t.db, { organizationId: ids.o1, name: "p1" })).id;
  ids.p2 = (await createProject(t.db, { organizationId: ids.o1, name: "p2" })).id;
  await syncStacks(t.db, ids.o1, ids.p1, ["net", "app"].map(stack), { prune: false });
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

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

const path = (runId: string, project = ids.p1) =>
  `/organizations/${ids.o1}/projects/${project}/runs/${runId}/policy-verdict`;
const verdict = (extra: Record<string, unknown> = {}) => ({
  stack: "net",
  evaluated: true,
  denied: [],
  warned: [],
  ...extra,
});

async function post(p: string, body: unknown, bearer?: string, raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await app.handle(
    new Request(`http://localhost${p}`, {
      method: "POST",
      headers,
      body: raw ?? JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
}

const stackRow = async (runId: string, name: string) =>
  (await getRun(t.db, ids.o1, ids.p1, runId))?.stacks.find((s) => s.stack === name);
const audits = (runId: string) =>
  t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "run.policy"), eq(auditEvents.resourceId, runId)));

describe("the summary job of a stack posting what the policy said", () => {
  test("a pass, a warn and a deny are stored with the names of the rules, and audited without them", async () => {
    const runId = await newRun();
    const post_ = async (body: Record<string, unknown>) =>
      post(path(runId), verdict(body), (await ciToken()).bearer);

    expect((await post_({})).status).toBe(204);
    expect(await stackRow(runId, "net")).toMatchObject({ policyVerdict: "pass" });

    expect((await post_({ warned: ["data.main.warn_tags"] })).status).toBe(204);
    expect(await stackRow(runId, "net")).toMatchObject({ policyVerdict: "warn" });

    expect(
      (
        await post_({
          denied: ["data.main.deny_public", "data.s3.deny"],
          warned: ["data.main.warn_tags"],
        })
      ).status,
    ).toBe(204);
    const row = await stackRow(runId, "net");
    expect(row).toMatchObject({ policyVerdict: "deny" });
    expect(ruleNames(row?.policyDenied)).toEqual(["data.main.deny_public", "data.s3.deny"]);
    expect(ruleNames(row?.policyWarned)).toEqual(["data.main.warn_tags"]);
    // the other stack is not judged by it
    expect(await stackRow(runId, "app")).toMatchObject({ policyVerdict: null });

    const rows = await audits(runId);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({
      actorKind: "ci",
      resourceType: "run",
      projectId: ids.p1,
      metadata: { stack: "net", verdict: "deny", denied: 2, warned: 1, evaluated: true },
    });
    expect(JSON.stringify(rows)).not.toContain("deny_public");
  });

  test("a rule named twice is one rule, in the row and in the audit", async () => {
    const runId = await newRun();
    const res = await post(
      path(runId),
      verdict({ denied: ["data.main.deny_x", "data.main.deny_x"] }),
      (await ciToken()).bearer,
    );
    expect(res.status).toBe(204);
    expect(ruleNames((await stackRow(runId, "net"))?.policyDenied)).toEqual(["data.main.deny_x"]);
    expect((await audits(runId))[0]?.metadata).toMatchObject({ verdict: "deny", denied: 1 });
  });

  test("an evaluator that gave no answer is a deny, whatever else the body says", async () => {
    const runId = await newRun();
    const res = await post(
      path(runId),
      { stack: "net", evaluated: false },
      (await ciToken()).bearer,
    );
    expect(res.status).toBe(204);
    const row = await stackRow(runId, "net");
    expect(row).toMatchObject({ policyVerdict: "deny" });
    expect(ruleNames(row?.policyDenied)).toEqual(["evaluator-failed"]);
    // the audit counts what was stored, not what was posted
    expect((await audits(runId))[0]?.metadata).toMatchObject({
      verdict: "deny",
      denied: 1,
      warned: 0,
      evaluated: false,
    });
    // a body that says it was not evaluated cannot also carry a clean report
    const both = await post(
      path(runId),
      { stack: "net", evaluated: false, denied: [], warned: [] },
      (await ciToken()).bearer,
    );
    expect(both.status).toBe(422);
  });

  test("is taken while the plan is open and no longer once an apply began", async () => {
    const runId = await newRun();
    const token = await ciToken();
    for (const [from, to] of [
      ["queued", "planning"],
      ["planning", "planned"],
    ] as const) {
      await moveRunStack(t.db, ids.o1, ids.p1, runId, "net", from, to);
      expect((await post(path(runId), verdict(), token.bearer)).status).toBe(204);
    }
    await moveRunStack(t.db, ids.o1, ids.p1, runId, "net", "planned", "applying");
    const late = await post(path(runId), verdict({ denied: ["data.main.deny_x"] }), token.bearer);
    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({ code: "stack_closed" });
    expect(await stackRow(runId, "net")).toMatchObject({ policyVerdict: "pass" });
    expect(await audits(runId)).toHaveLength(2);
  });
});

describe("a caller that is not the stack's summary job", () => {
  test("is refused 403 with one message, and nothing is stored", async () => {
    const runId = await newRun();
    const lone = await newRun({ app: APP_JOB });
    const attempts: [string, string, Record<string, unknown>, string][] = [
      ["another job", runId, verdict(), (await ciToken({ jobId: 999 })).bearer],
      ["the other stack's job", runId, verdict(), (await ciToken({ jobId: APP_JOB })).bearer],
      ["another ref", runId, verdict(), (await ciToken({ ref: "main" })).bearer],
      ["no job id", runId, verdict(), (await ciToken({ jobId: null })).bearer],
      [
        "a stack that is not in the run",
        runId,
        verdict({ stack: "ghost" }),
        (await ciToken()).bearer,
      ],
      ["a stack with no summary job yet", lone, verdict(), (await ciToken()).bearer],
    ];
    const details = new Set<string>();
    for (const [what, run, body, bearer] of attempts) {
      const res = await post(path(run), body, bearer);
      expect([what, res.status]).toEqual([what, 403]);
      details.add(res.json.detail);
    }
    expect(details.size).toBe(1);
    for (const r of [runId, lone]) {
      expect(await stackRow(r, "net")).toMatchObject({ policyVerdict: null, policyAt: null });
      expect(await audits(r)).toHaveLength(0);
    }
  });

  test("a job in an environment holds no such scope, and another project's job cannot see the run", async () => {
    const runId = await newRun();
    const env = await ciToken({ scopes: ["project.read", "environment.read", "secret.reveal"] });
    expect((await post(path(runId), verdict(), env.bearer)).status).toBe(403);
    const other = await ciToken({ projectId: ids.p2 });
    expect((await post(path(runId), verdict(), other.bearer)).status).toBe(404);
    expect(await stackRow(runId, "net")).toMatchObject({ policyVerdict: null });
  });

  test("a caller with no credentials is refused 401", async () => {
    const runId = await newRun();
    expect((await post(path(runId), verdict())).status).toBe(401);
  });
});

describe("what a verdict may say", () => {
  test("refuses anything that is not a rule name, an extra field, or too many rules", async () => {
    const runId = await newRun();
    const bad: [string, Record<string, unknown>][] = [
      ["a message in place of a name", verdict({ denied: ["Resource 'x' has password=hunter2"] })],
      ["a name with a space", verdict({ denied: ["data main"] })],
      ["an empty name", verdict({ warned: [""] })],
      ["a name that is too long", verdict({ denied: ["a".repeat(201)] })],
      ["a number", verdict({ denied: [1] })],
      ["51 names", verdict({ denied: Array.from({ length: 51 }, (_, i) => `r${i}`) })],
      ["an extra field", verdict({ messages: ["secret"] })],
      ["no stack", { evaluated: true, denied: [], warned: [] }],
      ["an unknown way of being evaluated", verdict({ evaluated: "yes" })],
    ];
    for (const [what, body] of bad) {
      const res = await post(path(runId), body, (await ciToken()).bearer);
      expect([what, res.status]).toEqual([what, 422]);
      // the refusal does not repeat what it refused
      expect(res.text).not.toContain("hunter2");
    }
    expect(await stackRow(runId, "net")).toMatchObject({ policyVerdict: null });
    expect(await audits(runId)).toHaveLength(0);
  });

  test("a body over the cap is refused 413 before it is read", async () => {
    const runId = await newRun();
    const big = JSON.stringify(verdict({ denied: ["a".repeat(70_000)] }));
    const res = await post(path(runId), undefined, (await ciToken()).bearer, big);
    expect(res.status).toBe(413);
    expect(await stackRow(runId, "net")).toMatchObject({ policyVerdict: null });
  });
});

describe("the generated job's filter, the route and the judgement are one contract", () => {
  const filter = async (input: string) => {
    const proc = Bun.spawn(["jq", "-e", "-c", "-s", "--arg", "stack", "net", POLICY_FILTER], {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out };
  };
  const conftest = (failures: string[], warnings: string[] = []) =>
    JSON.stringify([
      {
        filename: "plan.json",
        namespace: "main",
        successes: 1,
        failures: failures.map((query) => ({
          msg: "bucket x has key AKIAEXAMPLE",
          metadata: { query },
        })),
        warnings: warnings.map((query) => ({ msg: "w", metadata: { query } })),
      },
    ]);

  test("whatever the filter prints is accepted by the route as it is, and judges as the rules say", async () => {
    const cases: [string, string[], string[], PolicyVerdict][] = [
      ["a deny", ["data.main.deny_public"], [], "deny"],
      ["a warn", [], ["data.main.warn_tags"], "warn"],
      ["nothing", [], [], "pass"],
      // a name the filter must rewrite: spaces, quotes, an injection attempt, a very long one
      ["a hostile name", ['data.main.deny "x"; rm -rf /', "a b\tc", "é".repeat(300)], [], "deny"],
      // more rules than the route takes: the filter keeps 50 so the post is not refused
      ["a great many", Array.from({ length: 80 }, (_, i) => `data.main.deny_${i}`), [], "deny"],
    ];
    for (const [what, failures, warnings, expected] of cases) {
      const { code, out } = await filter(conftest(failures, warnings));
      expect([what, code]).toEqual([what, 0]);
      const body = JSON.parse(out);
      // every name it prints is a name the route accepts
      for (const n of [...body.denied, ...body.warned]) expect(POLICY_RULE.test(n)).toBe(true);
      expect(body.denied.length).toBeLessThanOrEqual(50);
      const runId = await newRun();
      const res = await post(path(runId), body, (await ciToken()).bearer);
      expect([what, res.status]).toEqual([what, 204]);
      expect(judge(body).verdict).toBe(expected);
      expect(await stackRow(runId, "net")).toMatchObject({ policyVerdict: expected });
      // a message of the policy (which may quote the plan) is nowhere in what travelled or what is stored
      expect(out).not.toContain("AKIAEXAMPLE");
      expect(JSON.stringify(await stackRow(runId, "net"))).not.toContain("AKIAEXAMPLE");
    }
  });

  test("a rule with no name is 'unnamed', and what is not a list of results prints nothing at all", async () => {
    const unnamed = await filter(JSON.stringify([{ failures: [{ msg: "m" }] }]));
    expect(JSON.parse(unnamed.out).denied).toEqual(["unnamed"]);
    for (const input of ["", "[]", "{}", "null", '"x"', "[1]", "not json"]) {
      const res = await filter(input);
      expect([input, res.code === 0, res.out]).toEqual([input, false, ""]);
    }
  });
});
