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
  jobs,
  syncRunItems,
  syncRuns,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { OWNER_TAG } from "@orch/sync";
import { fakeAws } from "@orch/sync/testing";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { SYNC_APPLY, syncApplyHandler } from "./sync-apply";
import { hashToken, randomToken } from "./tokens";
import { createWorker, type Worker } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

const REGION = "eu-west-1";
const ROLE = "arn:aws:iam::111122223333:role/orch-sync";
const EXTERNAL_ID = "ext-id-CANARY-0123456789";
const BASE = {
  accessKeyId: "AKIAPLATFORM000000",
  secretAccessKey: "platform-secret-key-CANARY-01",
};
/** What no plan, row, audit event or log line may hold: the credentials at every step of the way. */
const CREDENTIALS = [EXTERNAL_ID, BASE.secretAccessKey, "assumed-secret-", "assumed-token-"];

const aws = fakeAws({ base: BASE, roleArn: ROLE, externalId: EXTERNAL_ID, region: REGION });
const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
const cloud = { fetch: aws.fetch, aws: () => BASE };

let t: TestDb;
let o1: string;
let o2: string;
const conns = {} as Record<"role" | "wrongId" | "gitlab" | "other", string>;
let worker: Worker;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob", { id: string; cookie: string }>;

const makeApp = (platform: boolean) =>
  createApp({
    logger,
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
    cloud: { fetch: aws.fetch, aws: () => (platform ? BASE : undefined) },
  });
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await createTestDb();
  o1 = (await createOrganization(t.db, { slug: "cloud-sync", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "cloud-sync-2", name: "Two" })).id;
  const connect = async (
    org: string,
    type: string,
    name: string,
    config: Record<string, unknown>,
    token: string,
  ) => (await createConnection(t.db, keys, { organizationId: org, type, name, config, token })).id;
  const role = { roleArn: ROLE, region: REGION };
  conns.role = await connect(o1, "aws_assume_role", "role", role, EXTERNAL_ID);
  conns.wrongId = await connect(o1, "aws_assume_role", "wrong-id", role, "not-the-external-id");
  conns.gitlab = await connect(o1, "gitlab", "gl", { baseUrl: "https://gitlab.example.test" }, "x");
  conns.other = await connect(o2, "aws_assume_role", "role", role, EXTERNAL_ID);
  let gitlabId = 900;
  for (const name of ["alice", "bob"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [o1]: "admin", [o2]: "admin" }, projectRoles: {} });
  roleTable.set(902, { orgRoles: { [o1]: "member" }, projectRoles: {} });
  app = makeApp(true);
  worker = createWorker({
    db: t.db,
    logger,
    handlers: { [SYNC_APPLY]: syncApplyHandler({ db: t.db, keys, logger, cloud }) },
    pollMs: 10,
    backoff: () => 0,
  });
  worker.start();
});
afterAll(async () => {
  await worker.stop();
  await t.drop();
});

async function call(
  who: keyof typeof people,
  method: string,
  path: string,
  body?: unknown,
  a = app,
) {
  const headers: Record<string, string> = { cookie: people[who].cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await a.handle(
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
/** Every answer of the plan routes, searched at the end. */
const seen: string[] = [];
const markers: string[] = [];
let n = 0;
const sekrit = (label: string) => {
  const marker = `SEKRIT-${label}-${++n}-${Bun.randomUUIDv7()}`;
  markers.push(marker);
  return marker;
};

/** A project with a target under a prefix of its own, so one fake serves every test. */
async function world(
  over: {
    connection?: string;
    type?: string;
    config?: Record<string, unknown>;
    policy?: string;
  } = {},
) {
  const id = ++n;
  const prefix = `/orch/w${id}`;
  const project = (await createProject(t.db, { organizationId: o1, name: `p${id}` })).id;
  const base = `/organizations/${o1}/projects/${project}`;
  const targets = `${base}/sync-targets`;
  const make = (b: object = {}) =>
    call("alice", "POST", targets, {
      name: "ssm",
      type: over.type ?? "aws-ssm",
      connectionId: over.connection ?? conns.role,
      config: over.config ?? { region: REGION, prefix, protected: true },
      environmentMapping: {},
      ...(over.policy && { unmanagedPolicy: over.policy }),
      ...b,
    });
  const w = {
    prefix,
    project,
    targets,
    make,
    put: async (key: string, kind: string, value: string) => {
      const res = await call("alice", "POST", `${base}/variables`, { key, kind, value });
      expect(res.status).toBe(201);
    },
    plan: (target: string, a = app) =>
      call("alice", "POST", `${targets}/${target}/plan`, undefined, a),
    apply: (target: string, planId: string) =>
      call("alice", "POST", `${targets}/${target}/apply`, { planId }),
    finished: async (target: string, runId: string) => {
      for (let i = 0; i < 500; i++) {
        const res = await call("alice", "GET", `${targets}/${target}/runs/${runId}`);
        if (res.json.status !== "applying") return res;
        await Bun.sleep(20);
      }
      throw new Error("the apply did not finish");
    },
    param: (name: string) => aws.params.get(`${prefix}/${name}`),
    patch: (target: string, b: object) => call("alice", "PATCH", `${targets}/${target}`, b),
  };
  return w;
}

const brief = (res: { json: { items: { action: string; key: string; scope: string }[] } }) =>
  res.json.items.map((i) => `${i.action} ${i.key} ${i.scope}`);

describe("an aws-ssm target", () => {
  test("is planned, then applied through the assumed role, tagged as ours", async () => {
    const w = await world();
    const made = await w.make();
    expect(made.status).toBe(201);
    const target = made.json.id as string;
    const plainValue = sekrit("plain");
    const secretValue = sekrit("secret");
    await w.put("API_URL", "plain", plainValue);
    await w.put("DB_PASSWORD", "secret", secretValue);

    const plan = await w.plan(target);
    expect(plan.status).toBe(201);
    expect(brief(plan)).toEqual(["create API_URL *", "create DB_PASSWORD *"]);
    // planning reads; it writes nothing
    expect(aws.params.has(`${w.prefix}/API_URL`)).toBe(false);

    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.param("API_URL")).toMatchObject({ type: "String", value: plainValue });
    expect(w.param("DB_PASSWORD")).toMatchObject({ type: "SecureString", value: secretValue });
    for (const key of ["API_URL", "DB_PASSWORD"]) {
      expect(w.param(key)?.tags).toEqual({ [OWNER_TAG]: w.prefix });
    }
    // the role was assumed with the connection's external ID, by the platform's identity
    expect(aws.calls.filter((c) => c.action === "AssumeRole").length).toBeGreaterThan(0);

    // applying twice changes nothing: the next plan has only no-ops
    const again = await w.plan(target);
    expect(brief(again)).toEqual(["noop API_URL *", "noop DB_PASSWORD *"]);
  });

  test("never touches a parameter it did not make, whatever the policy says", async () => {
    const w = await world({ policy: "prune" });
    const made = await w.make();
    const target = made.json.id as string;
    await w.put("WANTED", "plain", "w-value");
    aws.seed(`${w.prefix}/HAND`, "by hand");
    // another target's, under an overlapping prefix
    aws.seed(`${w.prefix}/THEIRS`, "theirs", { tags: { [OWNER_TAG]: "/orch" } });
    // ours, but no longer wanted
    aws.seed(`${w.prefix}/OLD`, "old", { tags: { [OWNER_TAG]: w.prefix } });

    const plan = await w.plan(target);
    expect(brief(plan)).toEqual(["delete OLD *", "create WANTED *"]);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.param("OLD")).toBeUndefined();
    expect(w.param("HAND")).toMatchObject({ value: "by hand", tags: {} });
    expect(w.param("THEIRS")).toMatchObject({ value: "theirs" });
    expect(w.param("WANTED")?.value).toBe("w-value");
  });

  test("does not overwrite a parameter that is there but not ours", async () => {
    const w = await world();
    const target = (await w.make()).json.id as string;
    await w.put("CLASH", "plain", "ours");
    aws.seed(`${w.prefix}/CLASH`, "by hand");

    const plan = await w.plan(target);
    expect(brief(plan)).toEqual(["create CLASH *"]);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("failed");
    // the line says what to do about it, not merely that the parameter is missing
    expect(run.json.items[0].error).toContain(`${OWNER_TAG}=${w.prefix}`);
    expect(w.param("CLASH")).toMatchObject({ value: "by hand", tags: {} });
  });

  test("a change is an update through the same role", async () => {
    const w = await world();
    const target = (await w.make()).json.id as string;
    await w.put("CHANGING", "plain", "first");
    const first = await w.plan(target);
    await w.finished(target, (await w.apply(target, first.json.id)).json.id);
    expect(w.param("CHANGING")?.version).toBe(1);

    const vars = await call("alice", "GET", `/organizations/${o1}/projects/${w.project}/variables`);
    const variable = vars.json.items.find((v: { key: string }) => v.key === "CHANGING");
    await call(
      "alice",
      "PATCH",
      `/organizations/${o1}/projects/${w.project}/variables/${variable.id}`,
      { value: "second" },
    );
    const second = await w.plan(target);
    expect(brief(second)).toEqual(["update CHANGING *"]);
    const run = await w.finished(target, (await w.apply(target, second.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.param("CHANGING")).toMatchObject({ value: "second", version: 2 });
    expect(w.param("CHANGING")?.tags).toEqual({ [OWNER_TAG]: w.prefix });
  });

  test("with no platform AWS identity nothing is sent, and the answer says why", async () => {
    const w = await world();
    const target = (await w.make()).json.id as string;
    const before = aws.calls.length;
    const res = await w.plan(target, makeApp(false));
    expect(res.status).toBe(503);
    expect(res.json.code).toBe("aws_identity_unavailable");
    expect(aws.calls.length).toBe(before);
  });

  test("a role that does not trust this connection's external ID fails the plan, saying nothing of AWS's reply", async () => {
    const w = await world({ connection: conns.wrongId });
    const target = (await w.make()).json.id as string;
    const res = await w.plan(target);
    expect(res.status).toBe(502);
    expect(res.json.code).toBe("target_failed");
    expect(res.json.detail).toBe("reading the parameters: AWS could not be asked (forbidden)");
    expect(res.text).not.toContain("not-the-external-id");
  });

  test("needs an AWS connection, of this organization, and a config that is valid", async () => {
    const w = await world();
    expect((await w.make({ connectionId: conns.gitlab })).json.code).toBe(
      "connection_type_mismatch",
    );
    expect((await w.make({ connectionId: conns.other })).json.code).toBe("unknown_connection");
    const bad = await w.make({ config: { region: REGION, prefix: "/aws/x" } });
    expect(bad.status).toBe(422);
    const wrong = await world({
      type: "gitlab-variables",
      connection: conns.role,
      config: { project: "g/p" },
    });
    expect((await wrong.make()).json.code).toBe("connection_type_mismatch");
  });

  test("a connection that is not an AWS one never has its secret used as an external ID", async () => {
    const w = await world();
    // the route refuses this pairing; a row that got there some other way must not slip through
    const row = await createSyncTarget(t.db, {
      organizationId: o1,
      projectId: w.project,
      name: "sneaky",
      type: "aws-ssm",
      connectionId: conns.gitlab,
      config: { region: REGION, prefix: w.prefix },
      environmentMapping: {},
    });
    const before = aws.calls.length;
    const res = await w.plan(row.id);
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("connection_type");
    expect(aws.calls.length).toBe(before);
  });

  test("nothing secret reaches a plan, a row, an audit event, a job or a log line", async () => {
    const all = JSON.stringify([
      await t.db.select().from(syncRuns),
      await t.db.select().from(syncRunItems),
      await t.db.select().from(auditEvents),
      await t.db.select().from(jobs),
    ]);
    const text = [...seen, ...lines, all].join("\n");
    expect(markers.length).toBeGreaterThan(0);
    for (const secret of [...markers, ...CREDENTIALS]) expect(text).not.toContain(secret);
    expect(seen.length).toBeGreaterThan(0);
  });
});
