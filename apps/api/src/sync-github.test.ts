import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  createSession,
  createSyncTarget,
  syncRunItems,
  syncRuns,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGithub } from "@orch/github/mock";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { SYNC_APPLY, syncApplyHandler } from "./sync-apply";
import { hashToken, randomToken } from "./tokens";
import { createWorker, type Worker } from "./worker";

// FRG-20: a github-actions sync target is planned and applied through a GitHub connection. The secret goes up sealed to
// the scope's own key (the mock opens it with the key it handed out) and the credential goes nowhere else.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const TOKEN = "ghp_not-a-real-token-CANARY-1234";
const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });

let t: TestDb;
let hub: ReturnType<typeof createMockGithub>;
let o1: string;
let o2: string;
let cookie: string;
let worker: Worker;
let app: ReturnType<typeof createApp>;
const conns = {} as Record<"github" | "gitlab" | "other", string>;
/** Every answer of the plan and run routes, searched at the end. */
const seen: string[] = [];
const markers: string[] = [];
let n = 0;
const sekrit = (label: string) => {
  const marker = `SEKRIT-${label}-${++n}-${Bun.randomUUIDv7()}`;
  markers.push(marker);
  return marker;
};

beforeAll(async () => {
  t = await createTestDb();
  hub = createMockGithub({ token: TOKEN });
  hub.addOrg("acme");
  hub.addRepo("acme", "svc");
  hub.addEnvironment("acme", "svc", "prod", []);
  o1 = (await createOrganization(t.db, { slug: "gh-sync", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "gh-sync-2", name: "Two" })).id;
  const connect = async (org: string, type: string, token: string, baseUrl: string) =>
    (
      await createConnection(t.db, keys, {
        organizationId: org,
        type,
        name: type,
        config: { baseUrl },
        token,
      })
    ).id;
  conns.github = await connect(o1, "github", TOKEN, hub.url);
  conns.gitlab = await connect(o1, "gitlab", "glpat-not-for-github-1234", "https://gitlab.test");
  conns.other = await connect(o2, "github", TOKEN, hub.url);
  const user = await upsertUser(t.db, { gitlabId: 961, username: "alice", name: "alice" });
  const session = randomToken();
  await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
  cookie = `orch_session=${session}`;
  const roles: Pick<Subject, "orgRoles" | "projectRoles"> = {
    orgRoles: { [o1]: "admin", [o2]: "admin" },
    projectRoles: {},
  };
  app = createApp({
    logger,
    db: t.db,
    principal: callerPrincipal({ db: t.db, roles: () => roles }),
    ready: async () => {},
    keys,
    loopbackConnections: true,
  });
  worker = createWorker({
    db: t.db,
    logger,
    handlers: { [SYNC_APPLY]: syncApplyHandler({ db: t.db, keys, logger }) },
    pollMs: 10,
    backoff: () => 0,
  });
  worker.start();
});
afterAll(async () => {
  await worker.stop();
  hub.stop();
  await t.drop();
});

async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  if (/\/(plan|apply|runs\/)/.test(path)) seen.push(text);
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

/** A project with a github-actions target of the given config. */
async function world(config: Record<string, unknown>, over: { connection?: string } = {}) {
  const project = (await createProject(t.db, { organizationId: o1, name: `p${++n}` })).id;
  const base = `/organizations/${o1}/projects/${project}`;
  const targets = `${base}/sync-targets`;
  return {
    project,
    make: (b: object = {}) =>
      call("POST", targets, {
        name: "actions",
        type: "github-actions",
        connectionId: over.connection ?? conns.github,
        config,
        environmentMapping: {},
        ...b,
      }),
    put: async (key: string, kind: string, value: string) => {
      expect((await call("POST", `${base}/variables`, { key, kind, value })).status).toBe(201);
    },
    plan: (target: string) => call("POST", `${targets}/${target}/plan`),
    apply: (target: string, planId: string) =>
      call("POST", `${targets}/${target}/apply`, { planId }),
    finished: async (target: string, runId: string) => {
      for (let i = 0; i < 500; i++) {
        const res = await call("GET", `${targets}/${target}/runs/${runId}`);
        if (res.json.status !== "applying") return res;
        await Bun.sleep(20);
      }
      throw new Error("the apply did not finish");
    },
  };
}

const brief = (res: { json: { items: { action: string; key: string; scope: string }[] } }) =>
  res.json.items.map((i) => `${i.action} ${i.key} ${i.scope}`);

describe("a github-actions target", () => {
  test("is planned, then applied: a plain value as a variable, a secret sealed to the repository's key", async () => {
    const w = await world({ repository: "acme/svc", protected: true });
    const target = (await w.make()).json.id as string;
    const plain = sekrit("plain");
    const secret = sekrit("secret");
    await w.put("API_URL", "plain", plain);
    await w.put("DB_PASSWORD", "secret", secret);

    const plan = await w.plan(target);
    expect(plan.status).toBe(201);
    expect(brief(plan)).toEqual(["create API_URL *", "create DB_PASSWORD *"]);
    // planning reads; it writes nothing
    expect(hub.actions({ repository: "acme/svc" }).variables.API_URL).toBeUndefined();

    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    const held = hub.actions({ repository: "acme/svc" });
    expect(held.variables.API_URL?.value).toBe(plain);
    // the mock opens it with its own private key, so what it holds is what was sealed
    expect(held.secrets.DB_PASSWORD?.value).toBe(secret);
    expect(held.variables.DB_PASSWORD).toBeUndefined();

    // a variable is read back and compared; a secret cannot be, so it is written again (the PUT is idempotent)
    // shortcut: nothing stores what was last applied yet, so a secret is always an update, until it does
    const again = await w.plan(target);
    expect(brief(again)).toEqual(["noop API_URL *", "update DB_PASSWORD *"]);
  });

  test("an environment's items stay in that environment", async () => {
    const w = await world({ repository: "acme/svc", environment: "prod" });
    const target = (await w.make()).json.id as string;
    await w.put("PROD_ONLY", "plain", "x");
    const plan = await w.plan(target);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(
      hub.actions({ repository: "acme/svc", environment: "prod" }).variables.PROD_ONLY,
    ).toBeDefined();
    expect(hub.actions({ repository: "acme/svc" }).variables.PROD_ONLY).toBeUndefined();
  });

  test("an organization's items are for its private repositories unless the config says otherwise", async () => {
    const w = await world({ organization: "acme" });
    const target = (await w.make()).json.id as string;
    await w.put("ORG_WIDE", "plain", "x");
    const plan = await w.plan(target);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(hub.actions({ organization: "acme" }).variables.ORG_WIDE?.visibility).toBe("private");
  });

  test("a failed write fails the run, and the line names the key and not the value, the token or GitHub's reply", async () => {
    const w = await world({ repository: "acme/svc" });
    const target = (await w.make()).json.id as string;
    const secret = sekrit("refused");
    await w.put("REFUSED", "secret", secret);
    const plan = await w.plan(target);
    hub.inject({
      method: "PUT",
      path: "/repos/acme/svc/actions/secrets/REFUSED",
      status: 403,
      // the apply is tried again by the worker, so GitHub keeps refusing
      times: 20,
      body: { message: `no, ${secret} ${TOKEN}` },
    });
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("failed");
    expect(run.json.items[0].error).toBe(`"REFUSED" (*): GitHub answered forbidden`);
    expect(hub.actions({ repository: "acme/svc" }).secrets.REFUSED).toBeUndefined();
  });

  test("needs a GitHub connection of this organization and a config that is valid", async () => {
    const w = await world({ repository: "acme/svc" });
    expect((await w.make({ connectionId: conns.gitlab })).json.code).toBe(
      "connection_type_mismatch",
    );
    expect((await w.make({ connectionId: conns.other })).json.code).toBe("unknown_connection");
    for (const config of [{}, { repository: "acme" }, { repository: "acme/svc", token: "x" }]) {
      expect((await w.make({ config })).status).toBe(422);
    }
  });

  test("a connection that is not a GitHub one never has its secret sent to GitHub", async () => {
    const w = await world({ repository: "acme/svc" });
    // the route refuses this pairing; a row that got there some other way must not slip through
    const row = await createSyncTarget(t.db, {
      organizationId: o1,
      projectId: w.project,
      name: "sneaky",
      type: "github-actions",
      connectionId: conns.gitlab,
      config: { repository: "acme/svc" },
      environmentMapping: {},
    });
    const before = hub.requests.length;
    const res = await w.plan(row.id);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("connection_type");
    expect(hub.requests.length).toBe(before);
  });

  test("a value GitHub cannot hold stops the plan, naming the key", async () => {
    const w = await world({ repository: "acme/svc" });
    const target = (await w.make()).json.id as string;
    await w.put("TOO_BIG", "plain", "x".repeat(49 * 1024));
    const res = await w.plan(target);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("plan_invalid");
    expect(res.json.detail).toContain("TOO_BIG");
    expect(res.json.detail).toContain("48 KB");
  });

  test("no plan, run, audit event or log line holds the token or a value", async () => {
    const run = await t.db.select().from(syncRuns);
    const items = await t.db.select().from(syncRunItems);
    const audit = await t.db.select().from(auditEvents);
    const haystack = JSON.stringify([seen, run, items, audit, lines]);
    expect(markers.length).toBeGreaterThanOrEqual(3);
    for (const needle of [TOKEN, ...markers]) expect(haystack).not.toContain(needle);
  });
});
