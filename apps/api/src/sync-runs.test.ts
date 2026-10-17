// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${KEY}` is the reference syntax under test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  claimSyncRun,
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  deleteEnvironment,
  enqueue,
  jobs,
  recordSyncItem,
  syncRunItems,
  syncRuns,
  syncTargets,
  updateSyncTarget,
  upsertUser,
  variableKeys,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { asc, count, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { SYNC_APPLY, syncApplyHandler } from "./sync-apply";
import { hashToken, randomToken } from "./tokens";
import { createWorker, type JobContext, type Worker } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const OTHER_KEYS = envKeyProvider(`k9:${Buffer.alloc(32, 9).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let down: ReturnType<typeof createMockGitlab>;
let o1: string;
let o3: string;
const conns = {} as Record<"o1" | "o3" | "dead", string>;
const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
let worker: Worker;
/** The worker's apply handler waits for this; a test holds it to keep an apply running. */
let hold: Promise<void> = Promise.resolve();
const pause = () => {
  const gate = Promise.withResolvers<void>();
  hold = gate.promise;
  return gate.resolve;
};
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const reporterOn: Record<string, "reporter" | "maintainer"> = {};
const maintainerOn: Record<string, "reporter" | "maintainer"> = {};
const people = {} as Record<
  "alice" | "bob" | "carol" | "dan" | "erin",
  { id: string; cookie: string }
>;
type Who = keyof typeof people;

const makeApp = (provider: typeof keys | undefined) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys: provider,
  });
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  down = createMockGitlab({ scopes: ["api"] });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o3 = (await createOrganization(t.db, { slug: "three", name: "Three" })).id;
  const connect = async (organizationId: string, name: string, server: typeof mock) =>
    (
      await createConnection(t.db, keys, {
        organizationId,
        type: "gitlab",
        name,
        config: { baseUrl: server.url },
        token: server.token,
      })
    ).id;
  conns.o1 = await connect(o1, "live", mock);
  conns.o3 = await connect(o3, "live", mock);
  conns.dead = await connect(o1, "dead", down);
  down.stop();
  let gitlabId = 900;
  for (const name of ["alice", "bob", "carol", "dan", "erin"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [o1]: "admin", [o3]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(902, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob
  roleTable.set(903, { orgRoles: {}, projectRoles: reporterOn }); // carol
  roleTable.set(904, { orgRoles: {}, projectRoles: maintainerOn }); // dan
  // erin: nothing
  app = makeApp(keys);
  const applying = syncApplyHandler({ db: t.db, keys, logger });
  worker = createWorker({
    db: t.db,
    logger,
    handlers: {
      [SYNC_APPLY]: async (ctx) => {
        await hold;
        await applying(ctx);
      },
    },
    pollMs: 10,
    backoff: () => 0,
  });
  worker.start();
});
afterAll(async () => {
  await worker.stop();
  mock.stop();
  await t.drop();
});

/** Every answer of the plan routes, searched for secrets at the end. */
const seen: string[] = [];
async function call(who: Who | null, method: string, path: string, body?: unknown, a = app) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await a.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  // plain values are shown by the variables routes; the plan routes must show none
  if (/\/(plan|apply|runs\/)/.test(path)) seen.push(text);
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

/** A value that must never show up in a plan, a row, an audit event or a log line. */
const markers: string[] = [];
let n = 0;
const sekrit = (label: string) => {
  const marker = `SEKRIT-${label}-${++n}-${Bun.randomUUIDv7()}`;
  markers.push(marker);
  return marker;
};

/** A project with a target on a GitLab project of its own, and the means to fill both sides. */
async function world(
  over: {
    org?: string;
    connection?: string;
    mapping?: Record<string, string>;
    policy?: string;
  } = {},
) {
  const org = over.org ?? o1;
  const id = ++n;
  const project = (await createProject(t.db, { organizationId: org, name: `p${id}` })).id;
  const envs = {} as Record<"prod" | "stage", string>;
  for (const slug of ["prod", "stage"] as const) {
    envs[slug] = (
      await createEnvironment(t.db, { organizationId: org, projectId: project, name: slug, slug })
    ).id;
  }
  reporterOn[project] = "reporter";
  maintainerOn[project] = "maintainer";
  const gl = mock.addProject({ path: `fx/p${id}` });
  mock.addMember({ project: gl.id }, mock.tokenUser.id, 40);
  const gitlab = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const of = { project: gl.path };
  const targets = `/organizations/${org}/projects/${project}/sync-targets`;
  const made = await call("alice", "POST", targets, {
    name: "main",
    type: "gitlab-variables",
    connectionId: over.connection ?? (org === o1 ? conns.o1 : conns.o3),
    config: { project: gl.path },
    environmentMapping: over.mapping ?? { prod: "production" },
    ...(over.policy && { unmanagedPolicy: over.policy }),
  });
  expect(made.status).toBe(201);
  const target = made.json.id as string;
  const w = {
    org,
    project,
    envs,
    target,
    gitlab,
    of,
    targets,
    plan: (who: Who | null = "alice", a = app) =>
      call(who, "POST", `${targets}/${target}/plan`, undefined, a),
    run: (runId: string, who: Who | null = "alice") =>
      call(who, "GET", `${targets}/${target}/runs/${runId}`),
    /** A variable here: at the project, or in an environment. */
    put: async (at: "project" | "prod" | "stage", key: string, kind: string, value: string) => {
      const path =
        at === "project"
          ? `/organizations/${org}/projects/${project}/variables`
          : `/organizations/${org}/projects/${project}/environments/${envs[at]}/variables`;
      const res = await call("alice", "POST", path, { key, kind, value });
      expect(res.status).toBe(201);
      return res.json as { id: string };
    },
    /** A variable on the target, as if put there by hand. */
    seed: (
      key: string,
      value: string,
      o: { scope?: string; masked?: boolean; file?: boolean } = {},
    ) =>
      gitlab.variables.create(of, key, {
        value,
        masked: o.masked,
        scope: o.scope,
        type: o.file ? "file" : "env_var",
      }),
    apply: (planId: string, who: Who | null = "alice", a = app) =>
      call(who, "POST", `${targets}/${target}/apply`, { planId }, a),
    /** Waits for the worker to settle a run. */
    finished: async (runId: string) => {
      for (let i = 0; i < 500; i++) {
        const res = await call("alice", "GET", `${targets}/${target}/runs/${runId}`);
        if (res.json.status !== "applying") return res;
        await Bun.sleep(20);
      }
      throw new Error("the apply did not finish");
    },
    /** What was sent to this GitLab project to change it, in order: `POST`, `PUT /KEY`, `DELETE /KEY`. */
    writes: () =>
      mock.requests
        .filter(
          (r) =>
            r.method !== "GET" &&
            r.path.includes(`/projects/${encodeURIComponent(of.project)}/variables`),
        )
        .map((r) => `${r.method}${r.path.split("/variables")[1] ?? ""}`.trim()),
    /** The next requests of this kind to this GitLab project are refused with `status`. */
    refuse: (method: string, status: number, times = 1) =>
      mock.inject({
        method,
        path: new RegExp(`/projects/${encodeURIComponent(of.project)}/variables`),
        status,
        times,
      }),
    patchTarget: (body: object) => call("alice", "PATCH", `${targets}/${target}`, body),
    // by id (uuidv7), so oldest first: a table has no order of its own
    runs: () =>
      t.db.select().from(syncRuns).where(eq(syncRuns.targetId, target)).orderBy(asc(syncRuns.id)),
  };
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

const brief = (res: { json: { items: { action: string; key: string; scope: string }[] } }) =>
  res.json.items.map((i) => `${i.action} ${i.key} ${i.scope}`);
const events = (action: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, action));
const eventsOf = async (action: string, runId: string) =>
  (await events(action)).filter((e) => e.resourceId === runId);
const emptyCounts = { create: 0, update: 0, delete: 0, noop: 0, adopt: 0 };

describe("an empty plan", () => {
  test("is stored with its expiry, and nothing is written to the target", async () => {
    const w = await world();
    const before = Date.now();
    const res = await w.plan();
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      organizationId: w.org,
      projectId: w.project,
      targetId: w.target,
      status: "planned",
      counts: emptyCounts,
      skipped: { unresolved: [], missingEnvironments: [] },
      items: [],
    });
    const left = Date.parse(res.json.expiresAt) - before;
    expect(left).toBeGreaterThan(14 * 60_000);
    expect(left).toBeLessThan(16 * 60_000);

    expect((await w.runs()).map((r) => r.id)).toEqual([res.json.id]);
    expect(await w.run(res.json.id)).toMatchObject({ status: 200, json: res.json });
    const listed: unknown[] = [];
    for await (const v of w.gitlab.variables.list(w.of)) listed.push(v);
    expect(listed).toEqual([]);

    const [event] = await events("sync_run.plan");
    expect(event).toMatchObject({
      resourceType: "sync_run",
      resourceId: res.json.id,
      organizationId: w.org,
      projectId: w.project,
      metadata: { targetId: w.target, name: "main", counts: emptyCounts },
    });
  });

  test("is also what a target that already matches gets: every line a noop", async () => {
    const w = await world();
    await w.put("project", "SAME", "plain", "same-value");
    await w.seed("SAME", "same-value");
    const res = await w.plan();
    expect(brief(res)).toEqual(["noop SAME *"]);
    expect(res.json.counts).toEqual({ ...emptyCounts, noop: 1 });
  });
});

describe("a mixed plan", () => {
  test("creates, updates and leaves alone, ordered by key and scope, with no value", async () => {
    const w = await world();
    const secret = sekrit("secret");
    const wrong = sekrit("wrong");
    await w.put("project", "A_NEW", "plain", "a-new-value");
    await w.put("project", "B_SECRET", "secret", secret);
    await w.put("project", "C_SAME", "plain", "c-same");
    await w.put("project", "D_CHANGED", "plain", "d-now");
    await w.put("project", "E_UNMASKED", "secret", wrong);
    await w.put("project", "F_FILE", "file", "file body");
    await w.put("project", "G_FILE_ONCE", "file", "file body");
    await w.put("project", "H_NOT_A_FILE", "plain", "same text");
    await w.seed("C_SAME", "c-same");
    await w.seed("D_CHANGED", "d-before");
    await w.seed("E_UNMASKED", wrong, { masked: false });
    await w.seed("G_FILE_ONCE", "file body", { file: true });
    await w.seed("H_NOT_A_FILE", "same text", { file: true });
    await w.seed("Z_OTHER", "not-ours");

    const res = await w.plan();
    expect(res.status).toBe(201);
    expect(res.json.items).toEqual([
      { key: "A_NEW", scope: "*", action: "create", changed: [], result: null, error: null },
      { key: "B_SECRET", scope: "*", action: "create", changed: [], result: null, error: null },
      { key: "C_SAME", scope: "*", action: "noop", changed: [], result: null, error: null },
      {
        key: "D_CHANGED",
        scope: "*",
        action: "update",
        changed: ["value"],
        result: null,
        error: null,
      },
      {
        key: "E_UNMASKED",
        scope: "*",
        action: "update",
        changed: ["secret"],
        result: null,
        error: null,
      },
      { key: "F_FILE", scope: "*", action: "create", changed: [], result: null, error: null },
      { key: "G_FILE_ONCE", scope: "*", action: "noop", changed: [], result: null, error: null },
      {
        key: "H_NOT_A_FILE",
        scope: "*",
        action: "update",
        changed: ["file"],
        result: null,
        error: null,
      },
    ]);
    expect(res.json.counts).toEqual({ ...emptyCounts, create: 3, update: 3, noop: 2 });
    // what is stored is what was answered, and nothing else
    expect((await w.run(res.json.id)).json).toEqual(res.json);
    // planning writes nothing
    const kept = await w.gitlab.variables.get(w.of, { key: "D_CHANGED" });
    expect(kept.value).toBe("d-before");
  });

  test("what the target holds that nothing wants follows the policy", async () => {
    const w = await world();
    await w.put("project", "WANTED", "plain", "wanted-value");
    await w.seed("OTHER", "x");
    await w.seed("OTHER", "y", { scope: "review/*" });
    const ignore = await w.plan();
    expect(brief(ignore)).toEqual(["create WANTED *"]);

    expect((await w.patchTarget({ unmanagedPolicy: "adopt" })).status).toBe(200);
    expect(brief(await w.plan())).toEqual([
      "adopt OTHER *",
      "adopt OTHER review/*",
      "create WANTED *",
    ]);

    expect((await w.patchTarget({ unmanagedPolicy: "prune" })).status).toBe(200);
    const pruned = await w.plan();
    expect(brief(pruned)).toEqual(["delete OTHER *", "delete OTHER review/*", "create WANTED *"]);
    expect(pruned.json.counts).toEqual({ ...emptyCounts, create: 1, delete: 2 });
    // a plan is not an apply
    expect((await w.gitlab.variables.get(w.of, { key: "OTHER" })).value).toBe("x");
  });
});

describe("environments", () => {
  test("a mapped environment's overrides go to its scope, and only those", async () => {
    const w = await world({ mapping: { prod: "production", stage: "staging" } });
    await w.put("project", "HOST", "plain", "base.example");
    await w.put("project", "URL", "plain", "https://${HOST}/");
    await w.put("project", "KEEP", "plain", "kept");
    await w.put("prod", "HOST", "plain", "prod.example");
    await w.put("prod", "ONLY_PROD", "plain", "p");
    await w.put("stage", "KEEP", "plain", "kept"); // same as the project's: nothing to override

    const res = await w.plan();
    expect(brief(res)).toEqual([
      "create HOST *",
      "create HOST production",
      "create KEEP *",
      "create ONLY_PROD production",
      // reads HOST, which production overrides
      "create URL *",
      "create URL production",
    ]);
  });

  test("an override that differs only in kind is still an override", async () => {
    const w = await world();
    await w.put("project", "K", "plain", "samevalue1");
    await w.put("prod", "K", "secret", "samevalue1");
    await w.put("project", "F", "plain", "same text");
    await w.put("prod", "F", "file", "same text");
    await w.seed("K", "samevalue1");
    await w.seed("K", "samevalue1", { scope: "production", masked: true });
    await w.seed("F", "same text");
    await w.seed("F", "same text", { scope: "production", file: true });
    // each is there with the right kind: a noop, not a missing line or a change of kind
    expect(brief(await w.plan())).toEqual([
      "noop F *",
      "noop F production",
      "noop K *",
      "noop K production",
    ]);
  });

  test("an environment that is not mapped adds nothing", async () => {
    const w = await world({ mapping: {} });
    await w.put("project", "A", "plain", "a");
    await w.put("prod", "B", "plain", "b");
    expect(brief(await w.plan())).toEqual(["create A *"]);
  });

  test("a variable that reads what only the environments define is not wanted at *", async () => {
    const w = await world();
    await w.put("project", "DB_URL", "plain", "postgres://${DB_HOST}/app");
    await w.put("prod", "DB_HOST", "plain", "db.prod");
    const res = await w.plan();
    expect(brief(res)).toEqual(["create DB_HOST production", "create DB_URL production"]);
    expect(res.json.skipped.unresolved).toEqual([]);
  });

  test("an organization's variables are in the plan of its projects", async () => {
    const w = await world({ org: o3 });
    await call("alice", "POST", `/organizations/${o3}/variables`, {
      key: "FROM_ORG",
      kind: "secret",
      value: sekrit("org"),
    });
    await w.put("project", "READS", "plain", "${FROM_ORG}");
    expect(brief(await w.plan())).toEqual(["create FROM_ORG *", "create READS *"]);
  });
});

describe("what cannot be planned", () => {
  test("a secret the target cannot mask fails the whole plan, naming it and not its value", async () => {
    const w = await world();
    const short = "tiny-1"; // 6 characters: GitLab masks 8 or more
    const spaced = "has a space in it";
    markers.push(short, spaced);
    await w.put("project", "OK_ONE", "plain", "fine");
    await w.put("project", "SHORT", "secret", short);
    await w.put("prod", "SPACED", "secret", spaced);
    const res = await w.plan();
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("plan_invalid");
    expect(res.json.detail).toContain("SHORT");
    expect(res.json.detail).toContain("SPACED");
    expect(res.json.detail).toContain("production");
    expect(res.json.detail).toContain("2 variable(s)");
    expect(res.text).not.toContain(short);
    expect(res.text).not.toContain(spaced);
    // not "unmasked and written anyway", and not half a plan
    expect(await w.runs()).toEqual([]);
    expect((await events("sync_run.plan")).filter((e) => e.projectId === w.project)).toEqual([]);
  });

  test("names ten of the variables the target cannot hold and counts the rest", async () => {
    const names = (n: number) =>
      Array.from({ length: n }, (_, i) => `SHORT_${String(i + 1).padStart(2, "0")}`);
    const fill = async (w: World, n: number) => {
      for (const key of names(n)) await w.put("project", key, "secret", "tiny");
      return w.plan();
    };
    const twelve = await fill(await world(), 12);
    expect(twelve.status).toBe(422);
    expect(twelve.json.detail).toContain("12 variable(s)");
    expect(twelve.json.detail).toContain("SHORT_10");
    expect(twelve.json.detail).not.toContain("SHORT_11");
    expect(twelve.json.detail).toContain("and 2 more");
    const ten = await fill(await world(), 10);
    expect(ten.json.detail).toContain("10 variable(s)");
    expect(ten.json.detail).toContain("SHORT_10");
    expect(ten.json.detail).not.toMatch(/and \d+ more/);
  });

  test("a stored config the target type does not accept is a 422, not a call", async () => {
    const w = await world();
    await updateSyncTarget(t.db, w.org, w.project, w.target, { config: { nothing: "here" } });
    const res = await w.plan();
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("plan_invalid");
    expect(await w.runs()).toEqual([]);
  });

  test("a plain variable that reads a secret is a secret to the target, so it must be maskable", async () => {
    const w = await world();
    const hidden = sekrit("read");
    await w.put("project", "THE_SECRET", "secret", hidden);
    await w.put("project", "READS", "plain", "has ${THE_SECRET} in it");
    const res = await w.plan();
    expect(res.status).toBe(422);
    expect(res.json.detail).toContain("READS");
    expect(res.json.detail).not.toContain("THE_SECRET");
    expect(res.text).not.toContain(hidden);
    await w.put("project", "OTHER", "plain", "${THE_SECRET}");
    expect((await w.plan()).status).toBe(422);
  });

  test("a value longer than the target takes fails the plan, naming the key", async () => {
    const w = await world();
    await w.put("project", "OK_KEY", "plain", "v");
    await w.put("project", "TOO_LONG", "plain", "x".repeat(10_001));
    const res = await w.plan();
    expect(res.status).toBe(422);
    expect(res.json.detail).toContain("TOO_LONG");
    expect(res.json.detail).toContain("10000");
    expect(res.json.detail).not.toContain("OK_KEY");
  });

  test("a key that cannot be resolved is reported, left out, and kept safe from prune", async () => {
    const w = await world({ policy: "prune" });
    await w.put("project", "BROKEN", "plain", "needs ${NOPE}");
    await w.put("project", "FINE", "plain", "fine-value");
    await w.seed("BROKEN", "still-working-value");
    await w.seed("GONE", "unwanted");
    const res = await w.plan();
    expect(res.status).toBe(201);
    // broken in the base and in the mapped environment, which inherits it
    expect(res.json.skipped.unresolved).toEqual([
      { key: "BROKEN", scope: "*", code: "missing" },
      { key: "BROKEN", scope: "production", code: "missing" },
    ]);
    // BROKEN is neither created, updated nor deleted; the unwanted one is
    expect(brief(res)).toEqual(["create FINE *", "delete GONE *"]);
  });

  test("a mapped environment that is gone is skipped, and so is its scope on the target", async () => {
    const w = await world({ policy: "prune" });
    await w.put("project", "A", "plain", "a");
    await w.seed("A", "a");
    await w.seed("OLD", "old", { scope: "production" });
    expect(await deleteEnvironment(t.db, w.org, w.project, w.envs.prod)).toBe(true);
    const res = await w.plan();
    expect(res.status).toBe(201);
    expect(res.json.skipped.missingEnvironments).toEqual(["prod"]);
    expect(brief(res)).toEqual(["noop A *"]);
  });

  test("a target that cannot be read is a 502 and plans nothing", async () => {
    const w = await world({ connection: conns.dead });
    await w.put("project", "A", "plain", "a");
    const res = await w.plan();
    expect(res.status).toBe(502);
    expect(res.json.code).toBe("target_failed");
    expect(await w.runs()).toEqual([]);
  });

  test("without master keys it answers 503", async () => {
    const w = await world();
    const res = await w.plan("alice", makeApp(undefined));
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("secrets_unavailable");
    expect(await w.runs()).toEqual([]);
  });

  test("an unknown target is a 404", async () => {
    const w = await world();
    const res = await call("alice", "POST", `${w.targets}/${crypto.randomUUID()}/plan`);
    expect(res.status).toBe(404);
  });
});

describe("who may plan and read", () => {
  test("planning takes a maintainer; reading a stored plan takes a reporter", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    const planned = await w.plan("dan");
    expect(planned.status).toBe(201);
    const id = planned.json.id as string;

    for (const who of ["bob", "carol"] as const)
      expect([who, (await w.plan(who)).status]).toEqual([who, 403]);
    expect((await w.plan("erin")).status).toBe(404);
    expect((await w.plan(null)).status).toBe(401);

    for (const who of ["alice", "carol", "dan"] as const) {
      expect([who, (await w.run(id, who)).status]).toEqual([who, 200]);
    }
    expect((await w.run(id, "erin")).status).toBe(404);
    expect((await w.run(id, null)).status).toBe(401);
    // refused plans leave nothing behind
    expect(await w.runs()).toHaveLength(1);
  });

  test("a run is found only through its own target, project and organization", async () => {
    const a = await world();
    const b = await world();
    const planned = await a.plan();
    const id = planned.json.id as string;
    expect((await a.run(id)).status).toBe(200);
    // the same id under another project's target, and under a made-up target of its own project
    expect((await b.run(id)).status).toBe(404);
    const other = await call("alice", "GET", `${a.targets}/${crypto.randomUUID()}/runs/${id}`);
    expect(other.status).toBe(404);
    expect((await a.run(crypto.randomUUID())).status).toBe(404);
  });
});

describe("the digest of what a plan was made from", () => {
  const digests = async (w: World) => (await w.runs()).map((r) => r.desiredDigest);

  test("is the same for the same state, and moves with every change of it", async () => {
    const w = await world();
    const a = await w.put("project", "A", "plain", "first");
    await w.put("prod", "B", "plain", "b");
    await w.plan();
    await w.plan();
    const [one, two] = await digests(w);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(two).toBe(one);

    const base = `/organizations/${w.org}/projects/${w.project}/variables`;
    const seenDigests = new Set([one]);
    const step = async (what: string, change: () => Promise<unknown>) => {
      await change();
      await w.plan();
      const all = await digests(w);
      const last = all[all.length - 1] as string;
      expect([what, seenDigests.has(last)]).toEqual([what, false]);
      seenDigests.add(last);
    };
    await step("a value changes", () =>
      call("alice", "PATCH", `${base}/${a.id}`, { value: "second" }),
    );
    await step("a variable is added", () => w.put("project", "C", "plain", "c"));
    await step("an environment's variable is added", () => w.put("prod", "D", "plain", "d"));
    await step("the mapping changes", () =>
      w.patchTarget({ environmentMapping: { prod: "prod-scope" } }),
    );
    await step("the policy changes", () => w.patchTarget({ unmanagedPolicy: "prune" }));
    await step("the target's config changes", () =>
      w.patchTarget({ config: { project: w.of.project, protected: true } }),
    );
    await step("the connection changes", async () => {
      const other = await createConnection(t.db, keys, {
        organizationId: w.org,
        type: "gitlab",
        name: `other-${n}`,
        config: { baseUrl: mock.url },
        token: mock.token,
      });
      await w.patchTarget({ connectionId: other.id });
    });
    await step("a variable is deleted", () => call("alice", "DELETE", `${base}/${a.id}`));
  });
});

describe("the digest, in the cases the mapping alone shows", () => {
  const last = async (w: World) =>
    ((await w.runs()).at(-1) as { desiredDigest: string }).desiredDigest;

  test("a variable's change moves it when nothing is mapped", async () => {
    const w = await world({ mapping: {} });
    const a = await w.put("project", "A", "plain", "first");
    await w.plan();
    const before = await last(w);
    const path = `/organizations/${w.org}/projects/${w.project}/variables/${a.id}`;
    expect((await call("alice", "PATCH", path, { value: "second" })).status).toBe(200);
    await w.plan();
    expect(await last(w)).not.toBe(before);
  });

  test("the scope of an environment that is gone moves it, as that scope is left alone", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    await deleteEnvironment(t.db, w.org, w.project, w.envs.prod);
    await w.plan();
    const before = await last(w);
    await updateSyncTarget(t.db, w.org, w.project, w.target, {
      environmentMapping: { prod: "elsewhere" },
    });
    await w.plan();
    expect(await last(w)).not.toBe(before);
  });
});

describe("runs and their target", () => {
  test("go with the target when it is deleted", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    await w.plan();
    await w.plan();
    const items = () => t.db.select({ n: count() }).from(syncRunItems);
    const before = (await items())[0]?.n ?? 0;
    expect(before).toBeGreaterThanOrEqual(2);
    expect((await call("alice", "DELETE", `${w.targets}/${w.target}`)).status).toBe(204);
    expect(await w.runs()).toEqual([]);
    expect((await items())[0]?.n).toBe(before - 2);
  });
});

/** What a worker is given for a run, to call the handler without the queue. */
/** The apply jobs queued for a run. Found in code: the driver stores a jsonb payload as a JSON string, so SQL's `->>` finds nothing. */
const jobsFor = async (runId: string) =>
  (await t.db.select().from(jobs).where(eq(jobs.queue, SYNC_APPLY))).filter(
    (j) => j.payload.runId === runId,
  );

const jobFor = (w: World, runId: string, over: Partial<JobContext> = {}): JobContext => ({
  id: crypto.randomUUID(),
  queue: SYNC_APPLY,
  payload: { organizationId: w.org, projectId: w.project, targetId: w.target, runId },
  attempt: 1,
  maxAttempts: 5,
  log: logger,
  signal: new AbortController().signal,
  ...over,
});
/** Marks a plan as applying, as the endpoint does, but leaves the work to the test. */
async function claim(w: World, runId: string) {
  const job = await enqueue(t.db, {
    queue: SYNC_APPLY,
    runAt: new Date(Date.now() + 3_600_000),
    payload: { runId },
  });
  expect(await claimSyncRun(t.db, w.org, w.project, w.target, runId, job.id)).toBeDefined();
  return job;
}
const handler = (provider = keys) => syncApplyHandler({ db: t.db, keys: provider, logger });
const resultsOf = (res: { json: { items: { action: string; result: string | null }[] } }) =>
  res.json.items.map((i) => `${i.action}:${i.result}`);

describe("applying a plan", () => {
  test("writes what was planned, records every line, and the next plan has nothing to do", async () => {
    const w = await world({ policy: "prune" });
    const secret = sekrit("apply-secret");
    await w.put("project", "A_PLAIN", "plain", "a-plain");
    await w.put("project", "B_SECRET", "secret", secret);
    await w.put("project", "C_FILE", "file", "file body");
    await w.put("project", "D_CHANGED", "plain", "d-now");
    await w.put("project", "E_SAME", "plain", "e-same");
    await w.put("prod", "F_PROD", "plain", "f-prod");
    await w.seed("D_CHANGED", "d-before");
    await w.seed("E_SAME", "e-same");
    await w.seed("G_EXTRA", "not-wanted");
    const planned = await w.plan();
    expect(brief(planned)).toEqual([
      "create A_PLAIN *",
      "create B_SECRET *",
      "create C_FILE *",
      "update D_CHANGED *",
      "noop E_SAME *",
      "create F_PROD production",
      "delete G_EXTRA *",
    ]);
    const id = planned.json.id as string;
    const sent = w.writes().length;

    const started = await w.apply(id);
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({ id, status: "applying", error: null });
    const done = await w.finished(id);
    expect(done.json).toMatchObject({ status: "applied", error: null });
    expect(resultsOf(done)).toEqual([
      "create:applied",
      "create:applied",
      "create:applied",
      "update:applied",
      "noop:null",
      "create:applied",
      "delete:applied",
    ]);
    expect(done.json.items.every((i: { error: unknown }) => i.error === null)).toBe(true);
    // creates, then updates, then deletes; the noop is not touched
    expect(w.writes().slice(sent)).toEqual([
      "POST",
      "POST",
      "POST",
      "POST",
      "PUT/D_CHANGED",
      "DELETE/G_EXTRA",
    ]);

    const there = new Map<string, { value: string | null; masked: boolean; type: string }>();
    for await (const v of w.gitlab.variables.list(w.of)) there.set(`${v.key}@${v.scope}`, v);
    expect([...there.keys()].sort()).toEqual([
      "A_PLAIN@*",
      "B_SECRET@*",
      "C_FILE@*",
      "D_CHANGED@*",
      "E_SAME@*",
      "F_PROD@production",
    ]);
    expect(there.get("A_PLAIN@*")).toMatchObject({ value: "a-plain", masked: false });
    expect(there.get("B_SECRET@*")).toMatchObject({ value: secret, masked: true });
    expect(there.get("C_FILE@*")).toMatchObject({ value: "file body", type: "file" });
    expect(there.get("D_CHANGED@*")?.value).toBe("d-now");
    expect(there.get("F_PROD@production")?.value).toBe("f-prod");

    const again = await w.plan();
    expect(again.json.items.every((i: { action: string }) => i.action === "noop")).toBe(true);
    expect(w.writes().slice(sent)).toHaveLength(6);

    // who asked, and what finished it: the job, by its own id, with counts only
    const run = (await w.runs()).find((r) => r.id === id);
    expect(await eventsOf("sync_run.apply", id)).toMatchObject([
      {
        actorKind: "user",
        actorId: people.alice.id,
        resourceType: "sync_run",
        organizationId: w.org,
        projectId: w.project,
        metadata: { targetId: w.target, name: "main", counts: planned.json.counts },
      },
    ]);
    expect(await eventsOf("sync_run.applied", id)).toMatchObject([
      {
        actorKind: "job",
        actorId: run?.jobId,
        metadata: { targetId: w.target, name: "main", applied: 6, failed: 0 },
      },
    ]);
    expect(await eventsOf("sync_run.failed", id)).toEqual([]);
    const [job] = await t.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, run?.jobId ?? ""));
    expect(job).toMatchObject({ queue: SYNC_APPLY, status: "done", attempts: 1 });
    // ids only
    expect(job?.payload).toEqual({
      organizationId: w.org,
      projectId: w.project,
      targetId: w.target,
      runId: id,
    });
  });

  test("is refused when the variables changed since the plan, and writes nothing", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    const planned = await w.plan();
    const id = planned.json.id as string;
    await w.put("project", "B", "plain", "b");

    const res = await w.apply(id);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("plan_stale");
    expect(w.writes()).toEqual([]);
    expect(await jobsFor(id)).toEqual([]);
    expect((await w.run(id)).json.status).toBe("planned");
    expect(await eventsOf("sync_run.apply", id)).toEqual([]);

    // a new plan is of what is true now
    const fresh = await w.plan();
    expect((await w.apply(fresh.json.id)).status).toBe(202);
    expect((await w.finished(fresh.json.id)).json.status).toBe("applied");
  });

  test("is refused when the plan has expired, and when the target's settings changed", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    const expired = (await w.plan()).json.id as string;
    await t.db
      .update(syncRuns)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(syncRuns.id, expired));
    const res = await w.apply(expired);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("plan_expired");

    const planned = (await w.plan()).json.id as string;
    expect((await w.patchTarget({ unmanagedPolicy: "prune" })).status).toBe(200);
    expect((await w.apply(planned)).json.code).toBe("plan_stale");
    expect(w.writes()).toEqual([]);
    expect((await w.run(expired)).json.status).toBe("planned");
  });

  test("applies a plan once; an unknown plan, or one of another target, is not found", async () => {
    const w = await world();
    const other = await world();
    await w.put("project", "A", "plain", "a");
    const id = (await w.plan()).json.id as string;
    expect((await other.apply(id)).status).toBe(404);
    expect((await w.apply(crypto.randomUUID())).status).toBe(404);

    expect((await w.apply(id)).status).toBe(202);
    await w.finished(id);
    // said before the plan is compared with the variables, so a change since does not hide it
    await w.put("project", "B", "plain", "b");
    const again = await w.apply(id);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("plan_not_applicable");
    expect(w.writes()).toEqual(["POST"]);
    expect(await eventsOf("sync_run.apply", id)).toHaveLength(1);
  });

  test("one apply at a time per target: the second says so, and may go once the first is done", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    const one = (await w.plan()).json.id as string;
    const two = (await w.plan()).json.id as string;
    const release = pause();
    let winner = "";
    let loser = "";
    try {
      const both = await Promise.all([w.apply(one), w.apply(two)]);
      expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
      [winner, loser] = both[0]?.status === 202 ? [one, two] : [two, one];
      const lost = both.find((r) => r.status === 409);
      expect(lost?.json.code).toBe("apply_in_progress");
      // the loser is still a plan, with no job of its own
      expect((await w.run(loser)).json.status).toBe("planned");
      expect(await eventsOf("sync_run.apply", loser)).toEqual([]);
      expect(await jobsFor(loser)).toEqual([]);
    } finally {
      release();
    }
    expect((await w.finished(winner)).json.status).toBe("applied");

    // what it says is still true; the variable is there already, so the create becomes an update
    expect((await w.apply(loser)).status).toBe(202);
    expect((await w.finished(loser)).json.status).toBe("applied");
    expect(w.writes()).toEqual(["POST", "POST", "PUT/A"]);
  });

  test("the same plan applied twice at once: one goes, the other finds it taken and queues nothing", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    const id = (await w.plan()).json.id as string;
    // the first request is held where the plan is compared with the variables, after it saw `planned`
    const gate = Promise.withResolvers<void>();
    const slow = makeApp({
      currentKeyId: keys.currentKeyId,
      wrap: (plain, aad) => keys.wrap(plain, aad),
      unwrap: async (wrapped, aad) => {
        await gate.promise;
        return keys.unwrap(wrapped, aad);
      },
    });
    const release = pause();
    try {
      const first = w.apply(id, "alice", slow);
      expect((await w.apply(id)).status).toBe(202);
      gate.resolve();
      const lost = await first;
      expect([lost.status, lost.json.code]).toEqual([409, "plan_not_applicable"]);
      expect(await jobsFor(id)).toHaveLength(1);
    } finally {
      gate.resolve();
      release();
    }
    expect(await eventsOf("sync_run.apply", id)).toHaveLength(1);
    expect((await w.finished(id)).json.status).toBe("applied");
  });

  test("an apply whose job is dead is ended by the next one", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    const one = (await w.plan()).json.id as string;
    const two = (await w.plan()).json.id as string;
    const job = await claim(w, one);
    expect((await w.apply(two)).json.code).toBe("apply_in_progress");

    await t.db.update(jobs).set({ status: "dead" }).where(eq(jobs.id, job.id));
    expect((await w.apply(two)).status).toBe(202);
    expect((await w.run(one)).json).toMatchObject({
      status: "failed",
      error: "the apply did not finish: its job died or was never taken",
    });
    // the apply that found it says so, as itself
    expect(await eventsOf("sync_run.failed", one)).toMatchObject([
      {
        actorKind: "user",
        actorId: people.alice.id,
        metadata: { targetId: w.target, reason: "stuck" },
      },
    ]);
    expect((await w.finished(two)).json.status).toBe("applied");
  });

  test("takes a maintainer; a plan is named by a well-formed id and nothing else", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    const id = (await w.plan("dan")).json.id as string;

    for (const who of ["bob", "carol"] as const)
      expect([who, (await w.apply(id, who)).status]).toEqual([who, 403]);
    expect((await w.apply(id, "erin")).status).toBe(404);
    expect((await w.apply(id, null)).status).toBe(401);
    const noKeys = await w.apply(id, "dan", makeApp(undefined));
    expect([noKeys.status, noKeys.json.code]).toEqual([503, "secrets_unavailable"]);
    for (const body of [{}, { planId: "nope" }, { planId: id, extra: 1 }]) {
      const res = await call("dan", "POST", `${w.targets}/${w.target}/apply`, body);
      expect([res.status, res.json.code]).toEqual([422, "validation_failed"]);
    }
    // none of that touched the plan
    expect((await w.run(id)).json.status).toBe("planned");
    expect(await eventsOf("sync_run.apply", id)).toEqual([]);

    expect((await w.apply(id, "dan")).status).toBe(202);
    expect((await w.finished(id)).json.status).toBe("applied");
  });
});

test("a line can be written twice: what vanished from the target since the plan is taken in stride", async () => {
  const w = await world({ policy: "prune" });
  await w.put("project", "GONE_UPDATE", "plain", "now");
  await w.seed("GONE_UPDATE", "before");
  await w.seed("GONE_DELETE", "extra");
  const planned = await w.plan();
  expect(brief(planned)).toEqual(["delete GONE_DELETE *", "update GONE_UPDATE *"]);
  await w.gitlab.variables.delete(w.of, { key: "GONE_UPDATE" });
  await w.gitlab.variables.delete(w.of, { key: "GONE_DELETE" });

  expect((await w.apply(planned.json.id)).status).toBe(202);
  const done = await w.finished(planned.json.id);
  expect(done.json).toMatchObject({ status: "applied", error: null });
  expect(resultsOf(done)).toEqual(["delete:applied", "update:applied"]);
  const there: string[] = [];
  for await (const v of w.gitlab.variables.list(w.of)) there.push(`${v.key}=${v.value}`);
  expect(there).toEqual(["GONE_UPDATE=now"]);
});

describe("an apply that does not go all the way", () => {
  test("one refused line is failed and reported; the others are applied; a new plan has only that line left", async () => {
    const w = await world();
    const hidden = sekrit("refused");
    await w.put("project", "KEEP_ME", "plain", "kept-now");
    await w.put("project", "NEW_ONE", "secret", hidden);
    await w.seed("KEEP_ME", "kept-before");
    const id = (await w.plan()).json.id as string;
    w.refuse("POST", 400);

    expect((await w.apply(id)).status).toBe(202);
    const done = await w.finished(id);
    expect(done.json).toMatchObject({ status: "failed", error: "1 of 2 changes failed" });
    expect(done.json.items).toMatchObject([
      { key: "KEEP_ME", action: "update", result: "applied", error: null },
      {
        key: "NEW_ONE",
        action: "create",
        result: "failed",
        error: '"NEW_ONE" (*): GitLab refused the variable',
      },
    ]);
    expect((await w.gitlab.variables.get(w.of, { key: "KEEP_ME" })).value).toBe("kept-now");
    // a refusal is final: the queue did not bring it back
    const run = (await w.runs()).find((r) => r.id === id);
    const [job] = await t.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, run?.jobId ?? ""));
    expect(job).toMatchObject({ status: "done", attempts: 1 });
    expect(await eventsOf("sync_run.failed", id)).toMatchObject([
      { actorKind: "job", metadata: { applied: 1, failed: 1 } },
    ]);
    expect(await eventsOf("sync_run.applied", id)).toEqual([]);

    const fixed = await w.plan();
    expect(brief(fixed)).toEqual(["noop KEEP_ME *", "create NEW_ONE *"]);
    expect((await w.apply(fixed.json.id)).status).toBe(202);
    expect((await w.finished(fixed.json.id)).json.status).toBe("applied");
    const last = await w.plan();
    expect(last.json.items.every((i: { action: string }) => i.action === "noop")).toBe(true);
  });

  test("a target that does not answer is tried again by the queue, and applied lines are not written twice", async () => {
    const w = await world();
    await w.put("project", "NEW_A", "plain", "a");
    await w.put("project", "NEW_B", "plain", "b");
    const id = (await w.plan()).json.id as string;
    w.refuse("POST", 403);

    expect((await w.apply(id)).status).toBe(202);
    const done = await w.finished(id);
    expect(done.json).toMatchObject({ status: "applied", error: null });
    expect(resultsOf(done)).toEqual(["create:applied", "create:applied"]);
    expect(done.json.items.every((i: { error: unknown }) => i.error === null)).toBe(true);
    // A refused, B written, A written on the second try: B was not sent again
    expect(w.writes()).toEqual(["POST", "POST", "POST"]);
    const run = (await w.runs()).find((r) => r.id === id);
    const [job] = await t.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, run?.jobId ?? ""));
    expect(job).toMatchObject({ status: "done", attempts: 2 });
  });

  test("a target that never answers is given up on at the last try, the line failed in words that name no value", async () => {
    const w = await world();
    await w.put("project", "NEVER_A", "secret", sekrit("never"));
    await w.put("project", "KEEP", "plain", "kept-now");
    await w.seed("KEEP", "kept-before");
    const id = (await w.plan()).json.id as string;
    w.refuse("POST", 403, 100);

    expect((await w.apply(id)).status).toBe(202);
    const done = await w.finished(id);
    expect(done.json).toMatchObject({ status: "failed", error: "1 of 2 changes failed" });
    expect(done.json.items).toMatchObject([
      { key: "KEEP", result: "applied", error: null },
      { key: "NEVER_A", result: "failed", error: '"NEVER_A" (*): GitLab answered forbidden' },
    ]);
    const run = (await w.runs()).find((r) => r.id === id);
    const [job] = await t.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, run?.jobId ?? ""));
    expect(job).toMatchObject({ status: "done", attempts: 5 });
    // the update went out once, the create five times
    expect(w.writes().filter((x) => x.startsWith("PUT"))).toEqual(["PUT/KEEP"]);
    expect(w.writes().filter((x) => x === "POST")).toHaveLength(5 + 1);
  });
});

describe("the apply job on its own", () => {
  test("a job delivered again for a run that is done writes nothing", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    const id = (await w.plan()).json.id as string;
    await w.apply(id);
    const done = await w.finished(id);
    const sent = w.writes().length;

    await handler()(jobFor(w, id));
    expect(w.writes()).toHaveLength(sent);
    expect((await w.run(id)).json).toEqual(done.json);
    expect(await eventsOf("sync_run.applied", id)).toHaveLength(1);
    // nor does one for a plan that was never applied, even with something in it to write
    await w.put("project", "B", "plain", "b");
    const never = (await w.plan()).json.id as string;
    await handler()(jobFor(w, never));
    expect(w.writes()).toHaveLength(sent);
    expect((await w.run(never)).json.status).toBe("planned");
  });

  test("a job delivered again carries on with the lines not yet recorded", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    await w.put("project", "B", "plain", "b");
    const id = (await w.plan()).json.id as string;
    await claim(w, id);
    await recordSyncItem(t.db, id, 0, { result: "applied", error: null });

    await handler()(jobFor(w, id));
    expect(w.writes()).toEqual(["POST"]);
    const names: string[] = [];
    for await (const v of w.gitlab.variables.list(w.of)) names.push(v.key);
    expect(names).toEqual(["B"]);
    const done = await w.run(id);
    expect(done.json.status).toBe("applied");
    expect(resultsOf(done)).toEqual(["create:applied", "create:applied"]);
    expect(await eventsOf("sync_run.applied", id)).toMatchObject([
      { metadata: { applied: 2, failed: 0 } },
    ]);
  });

  test("fails a run whose variables changed after the plan, and writes nothing", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    const id = (await w.plan()).json.id as string;
    await claim(w, id);
    await w.put("project", "B", "plain", "b");

    const ctx = jobFor(w, id);
    await handler()(ctx);
    expect(w.writes()).toEqual([]);
    const done = await w.run(id);
    expect(done.json.status).toBe("failed");
    expect(done.json.error).toContain("changed after the plan was made");
    expect(resultsOf(done)).toEqual(["create:null"]);
    expect(await eventsOf("sync_run.failed", id)).toMatchObject([
      { actorKind: "job", actorId: ctx.id, metadata: { applied: 0, failed: 0 } },
    ]);
  });

  test("fails a run it can never carry out, in words that name no secret", async () => {
    const w = await world();
    await w.put("project", "A", "secret", sekrit("unreadable"));
    const unreadable = (await w.plan()).json.id as string;
    await claim(w, unreadable);
    await handler(OTHER_KEYS)(jobFor(w, unreadable));
    expect((await w.run(unreadable)).json).toMatchObject({
      status: "failed",
      error: "The stored secret cannot be opened: check ORCH_MASTER_KEYS",
    });

    // the connection opens, a variable's key does not: the same fixed words, not the error's
    const keyed = (await w.plan()).json.id as string;
    await claim(w, keyed);
    const [dek] = await t.db
      .select()
      .from(variableKeys)
      .where(eq(variableKeys.projectId, w.project));
    await t.db
      .update(variableKeys)
      .set({ dekWrapped: Buffer.from(dek?.dekWrapped.map((b) => b ^ 1) ?? []) })
      .where(eq(variableKeys.projectId, w.project));
    await handler()(jobFor(w, keyed));
    expect((await w.run(keyed)).json).toMatchObject({
      status: "failed",
      error: "A stored secret cannot be opened: check ORCH_MASTER_KEYS",
    });
    await t.db
      .update(variableKeys)
      .set({ dekWrapped: dek?.dekWrapped })
      .where(eq(variableKeys.projectId, w.project));

    const misconfigured = (await w.plan()).json.id as string;
    await claim(w, misconfigured);
    await t.db
      .update(syncTargets)
      .set({ config: { nonsense: true } })
      .where(eq(syncTargets.id, w.target));
    await handler()(jobFor(w, misconfigured));
    const done = await w.run(misconfigured);
    expect(done.json.status).toBe("failed");
    expect(done.json.error).toContain("the config is { project } or { group }");
    expect(w.writes()).toEqual([]);
  });

  test("gives up the lock to the queue until the last try, then fails the run", async () => {
    const w = await world();
    await w.put("project", "A", "plain", "a");
    const id = (await w.plan()).json.id as string;
    await claim(w, id);
    const cut = new AbortController();
    cut.abort(new Error("job lock timeout"));

    await expect(handler()(jobFor(w, id, { signal: cut.signal, attempt: 4 }))).rejects.toThrow();
    expect((await w.run(id)).json.status).toBe("applying");

    await handler()(jobFor(w, id, { signal: cut.signal, attempt: 5 }));
    expect((await w.run(id)).json).toMatchObject({
      status: "failed",
      error: "The apply could not be completed",
    });
    expect(w.writes()).toEqual([]);
  });
});

describe("no secret anywhere", () => {
  test("a plan, its stored rows, the audit log and the log lines hold no value and no token", async () => {
    const w = await world({ policy: "prune" });
    const a = sekrit("leak-a");
    const b = sekrit("leak-b");
    const c = sekrit("leak-c");
    await w.put("project", "LEAK_SECRET", "secret", a);
    await w.put("prod", "LEAK_FILE", "file", b);
    await w.put("project", "LEAK_PLAIN", "plain", c);
    await w.seed("LEAK_PLAIN", sekrit("leak-remote"));
    await w.seed("LEAK_SECRET", sekrit("leak-remote-secret"), { masked: true });
    await w.seed("LEAK_GONE", sekrit("leak-gone"));
    const res = await w.plan();
    expect(res.status).toBe(201);
    expect(brief(res)).toEqual([
      "create LEAK_FILE production",
      "delete LEAK_GONE *",
      "update LEAK_PLAIN *",
      "update LEAK_SECRET *",
    ]);
    await w.run(res.json.id);
    expect((await w.apply(res.json.id)).status).toBe(202);
    expect((await w.finished(res.json.id)).json.status).toBe("applied");
    // and the failures
    await w.put("project", "TOO_SHORT", "secret", sekrit("x").slice(0, 5));
    expect((await w.plan()).status).toBe(422);
    expect((await w.plan("dan", makeApp(undefined))).status).toBe(503);

    const haystack = [
      ...seen,
      JSON.stringify(await t.db.select().from(syncRuns)),
      JSON.stringify(await t.db.select().from(syncRunItems)),
      JSON.stringify(await t.db.select().from(jobs)),
      JSON.stringify(await t.db.select().from(auditEvents)),
      ...lines,
    ].join("\n");
    expect(markers.length).toBeGreaterThan(5);
    for (const marker of [...markers, mock.token]) {
      expect([marker, haystack.includes(marker)]).toEqual([marker, false]);
    }
    expect(haystack).not.toContain("glpat");
  });
});
