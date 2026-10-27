import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import {
  auditEvents,
  createCiToken,
  createOrganization,
  createProject,
  createRun,
  createSession,
  type NewStack,
  recordStackJobs,
  syncStacks,
  upsertResource,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, newCiToken, randomToken } from "./tokens";

// BLP-17: the links of a resource (where it is served, where its cloud console shows it) travel in the plan
// summary of its stack, are checked again here, and are shown on the resource. Nothing here reaches a cloud.

const URL1 = "https://files.example.com";
const CONSOLE = "https://console.cloud.google.com/storage/browser/files";

let t: TestDb;
let app: ReturnType<typeof makeApp>;
let o1: string;
let p1: string;
let owner: string;
let jobs = 7000;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();
const makeApp = () =>
  createApp({
    logger: createLogger({ level: "debug", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
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

beforeAll(async () => {
  t = await createTestDb();
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  p1 = (await createProject(t.db, { organizationId: o1, name: "infra" })).id;
  await syncStacks(t.db, o1, p1, [stack("net")], { prune: false });
  const user = await upsertUser(t.db, { gitlabId: 801, username: "owner", name: "owner" });
  const session = randomToken();
  await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
  owner = `orch_session=${session}`;
  roleTable.set(801, { orgRoles: { [o1]: "owner" }, projectRoles: {} });
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

/** A bucket resource of staging, and the stack the project's repository has for it. */
async function bucket(name: string) {
  const stackName = `staging-${name}-bucket`;
  const row = await upsertResource(t.db, {
    organizationId: o1,
    projectId: p1,
    environment: "staging",
    kind: "bucket",
    cloud: "gcp",
    name,
    inputs: {},
    stack: stackName,
    path: `infra/staging/${name}-bucket`,
    proposalUrl: null,
  });
  await syncStacks(t.db, o1, p1, [stack(stackName)], { prune: false });
  return { id: row?.id as string, stackName };
}

/** A run of `stack` whose summary job is known, and the token of that job. */
async function planOf(stackName: string, kind: "plan" | "drift" = "plan", refProtected = true) {
  const run = await createRun(t.db, {
    organizationId: o1,
    projectId: p1,
    ref: "feature/files",
    sha: "d".repeat(40),
    stacks: [stackName],
    kind,
  });
  const jobId = ++jobs;
  await recordStackJobs(t.db, o1, p1, run.id, stackName, { summaryJobId: jobId });
  const fresh = newCiToken();
  const row = await createCiToken(t.db, {
    organizationId: o1,
    projectId: p1,
    tokenHash: fresh.tokenHash,
    scopes: ["project.read", "run.summary"],
    gitlabProjectId: 4242,
    gitlabJobId: jobId,
    ref: "feature/files",
    refProtected,
    ttlMs: 60_000,
  });
  return { runId: run.id, bearer: fresh.token, tokenId: row.id };
}
type Plan = Awaited<ReturnType<typeof planOf>>;

const summary = (stackName: string, extra: Record<string, unknown> = {}) => ({
  stack: stackName,
  add: 0,
  change: 0,
  destroy: 0,
  resources: [],
  ...extra,
});
async function post(plan: Plan, body: unknown) {
  const res = await app.handle(
    new Request(
      `http://localhost/organizations/${o1}/projects/${p1}/runs/${plan.runId}/plan-summary`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${plan.bearer}` },
        body: JSON.stringify(body),
      },
    ),
  );
  const text = await res.text();
  return { status: res.status, text };
}
async function get(path: string) {
  const res = await app.handle(
    new Request(`http://localhost/organizations/${o1}/projects/${p1}/resources${path}`, {
      headers: { cookie: owner },
    }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return (await res.json()) as any;
}
const linksOf = async (id: string) => {
  const r = await get(`/${id}`);
  return { url: r.url, consoleUrl: r.consoleUrl };
};
const NONE = { url: null, consoleUrl: null };

describe("a resource shows the links its stack's plan summary carried", () => {
  test("a new resource has none; the plan after its apply shows them, on the resource and in the list", async () => {
    const { id, stackName } = await bucket("files");
    expect(await linksOf(id)).toEqual(NONE);

    // the plan before the apply: a state with nothing in it says nothing
    const before = await planOf(stackName);
    expect((await post(before, summary(stackName, { outputs: {} }))).status).toBe(204);
    expect(await linksOf(id)).toEqual(NONE);

    // the plan after a mock apply: the state has the module's outputs
    const after = await planOf(stackName);
    const sent = await post(
      after,
      summary(stackName, { outputs: { url: URL1, consoleUrl: CONSOLE } }),
    );
    expect(sent.status).toBe(204);
    expect(await linksOf(id)).toEqual({ url: URL1, consoleUrl: CONSOLE });
    const listed = (await get("")).items.find((r: { id: string }) => r.id === id);
    expect(listed).toMatchObject({ url: URL1, consoleUrl: CONSOLE });
  });

  test("a summary with no outputs at all leaves them; one with an empty set takes them away", async () => {
    const { id, stackName } = await bucket("kept");
    await post(await planOf(stackName), summary(stackName, { outputs: { url: URL1 } }));
    expect(await linksOf(id)).toEqual({ url: URL1, consoleUrl: null });

    await post(await planOf(stackName), summary(stackName));
    expect(await linksOf(id)).toEqual({ url: URL1, consoleUrl: null });

    await post(await planOf(stackName), summary(stackName, { outputs: {} }));
    expect(await linksOf(id)).toEqual(NONE);
  });

  test("the plan asked for last decides: one that was asked for earlier and arrives later is ignored", async () => {
    const { id, stackName } = await bucket("late");
    const earlier = await planOf(stackName);
    const later = await planOf(stackName);

    await post(later, summary(stackName, { outputs: { url: "https://new.example.com" } }));
    await post(earlier, summary(stackName, { outputs: { url: "https://old.example.com" } }));
    expect(await linksOf(id)).toEqual({ url: "https://new.example.com", consoleUrl: null });
  });

  test("a stack that is no resource is accepted and nothing is stored for it", async () => {
    const plan = await planOf("net");
    expect((await post(plan, summary("net", { outputs: { url: URL1 } }))).status).toBe(204);
  });

  test("a drift run's plan reports them too", async () => {
    const { id, stackName } = await bucket("drifty");
    const plan = await planOf(stackName, "drift");
    expect((await post(plan, summary(stackName, { outputs: { url: URL1 } }))).status).toBe(204);
    expect(await linksOf(id)).toEqual({ url: URL1, consoleUrl: null });
  });
});

describe("who may report them", () => {
  test("a job on a ref anyone can push to is heard, and the resource keeps the links it had", async () => {
    const { id, stackName } = await bucket("branchy");
    await post(await planOf(stackName), summary(stackName, { outputs: { url: URL1 } }));

    const branch = await planOf(stackName, "plan", false);
    const sent = await post(
      branch,
      summary(stackName, { outputs: { url: "https://evil.example.com", consoleUrl: CONSOLE } }),
    );
    expect(sent.status).toBe(204);
    expect(await linksOf(id)).toEqual({ url: URL1, consoleUrl: null });
  });

  test("its summary is kept all the same, and the audit event counts no links from it", async () => {
    const { stackName } = await bucket("branchyaudit");
    const branch = await planOf(stackName, "plan", false);
    await post(branch, summary(stackName, { add: 2, outputs: { url: URL1 } }));
    const rows = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "run.summary"), eq(auditEvents.resourceId, branch.runId)));
    expect(rows[0]?.metadata).toMatchObject({ stack: stackName, add: 2, outputs: 0 });
  });
});

describe("what a summary's outputs may hold", () => {
  const refused: [string, unknown][] = [
    ["a link that is not http(s)", { url: "javascript:alert(1)" }],
    ["a link with a space", { url: "https://a.example.com/x y" }],
    ["a link with a trailing newline", { consoleUrl: "https://a.example.com/\n" }],
    ["a link with a control character", { url: "https://a.example.com/\u0007" }],
    ["a link with a character that is not ASCII", { url: "https://a.example.com/é" }],
    ["a link over 300 characters", { url: `https://a.example.com/${"a".repeat(300)}` }],
    ["a link that is not text", { url: 42 }],
    ["an output of another name", { url: URL1, password: "hunter2" }],
    ["a list", [URL1]],
  ];
  test("is refused 422 and nothing is stored", async () => {
    const { id, stackName } = await bucket("strict");
    for (const [what, outputs] of refused) {
      const res = await post(await planOf(stackName), summary(stackName, { outputs }));
      expect([what, res.status]).toEqual([what, 422]);
      expect(res.text).not.toContain("hunter2");
    }
    expect(await linksOf(id)).toEqual(NONE);
  });

  test("300 characters exactly are kept", async () => {
    const { id, stackName } = await bucket("edge");
    const url = `https://a.example.com/${"a".repeat(300 - 22)}`;
    expect(
      (await post(await planOf(stackName), summary(stackName, { outputs: { url } }))).status,
    ).toBe(204);
    expect((await linksOf(id)).url).toBe(url);
  });

  test("the audit event says how many there were and never what they were", async () => {
    const { stackName } = await bucket("audited");
    const plan = await planOf(stackName);
    await post(plan, summary(stackName, { outputs: { url: URL1, consoleUrl: CONSOLE } }));
    const rows = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "run.summary"), eq(auditEvents.resourceId, plan.runId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ stack: stackName, outputs: 2 });
    expect(JSON.stringify(rows)).not.toContain("example.com");
  });
});
