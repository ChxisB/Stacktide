// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${KEY}` is the reference syntax under test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createEnvironment,
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
import {
  type Fetch,
  MANAGED_KEY,
  MANAGED_LABEL,
  OWNER_TAG,
  PLAIN_ANNOTATION,
  PLAIN_PREFIX,
  REFERENCE_WHY,
  type ReferenceReason,
} from "@orch/sync";
import { fakeAws, fakeKube, fakeVault } from "@orch/sync/testing";
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
const KUBE_SERVER = "https://k8s.example.test:6443";
const KUBE_TOKEN = "eyJhbGciOiJSUzI1NiJ9.kube-token-CANARY-0123456789";
const NAMESPACE = "apps";
const VAULT_ADDRESS = "https://vault.example.test:8200";
const VAULT_ROLE_ID = "role-id-1234";
const VAULT_SECRET_ID = "vault-secret-id-CANARY-0123456789";
const VAULT_PREFIX = "app";

/** What no plan, row, audit event or log line may hold: the credentials at every step of the way. */
const CREDENTIALS = [
  EXTERNAL_ID,
  BASE.secretAccessKey,
  "assumed-secret-",
  "assumed-token-",
  KUBE_TOKEN,
  VAULT_SECRET_ID,
  "hvs.fake-client-token-",
];

const aws = fakeAws({ base: BASE, roleArn: ROLE, externalId: EXTERNAL_ID, region: REGION });
const kube = fakeKube({
  server: KUBE_SERVER,
  token: KUBE_TOKEN,
  namespaces: [NAMESPACE, "staging"],
});
const vault = fakeVault({
  address: VAULT_ADDRESS,
  roleId: VAULT_ROLE_ID,
  secretId: VAULT_SECRET_ID,
  kvMount: "kv",
  prefix: VAULT_PREFIX,
});
/** One cloud for the platform to reach: the cluster and the Vault are their own hosts, everything else is AWS. */
const reach: Fetch = (url, init) =>
  url.startsWith(KUBE_SERVER)
    ? kube.fetch(url, init)
    : url.startsWith(VAULT_ADDRESS)
      ? vault.fetch(url, init)
      : aws.fetch(url, init);
const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
const cloud = { fetch: reach, aws: () => BASE };

let t: TestDb;
let o1: string;
let o2: string;
const conns = {} as Record<
  | "role"
  | "wrongId"
  | "gitlab"
  | "other"
  | "kube"
  | "kubeWrongToken"
  | "kubeOther"
  | "vault"
  | "vaultWrongSecret"
  | "vaultOther",
  string
>;
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
    cloud: { fetch: reach, aws: () => (platform ? BASE : undefined) },
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
  const cluster = { server: KUBE_SERVER, namespaces: [NAMESPACE, "staging"] };
  conns.kube = await connect(o1, "kubernetes", "cluster", cluster, KUBE_TOKEN);
  conns.kubeWrongToken = await connect(
    o1,
    "kubernetes",
    "cluster-wrong",
    cluster,
    "not-the-cluster-token-0123456789",
  );
  conns.kubeOther = await connect(o2, "kubernetes", "cluster", cluster, KUBE_TOKEN);
  const store = {
    address: VAULT_ADDRESS,
    roleId: VAULT_ROLE_ID,
    kvMount: "kv",
    prefix: VAULT_PREFIX,
  };
  conns.vault = await connect(o1, "vault_approle", "vault", store, VAULT_SECRET_ID);
  conns.vaultWrongSecret = await connect(
    o1,
    "vault_approle",
    "vault-wrong",
    store,
    "not-the-vault-secret-id-0123",
  );
  conns.vaultOther = await connect(o2, "vault_approle", "vault", store, VAULT_SECRET_ID);
  // connections that variables may point at (EXT-6): only the ones created with `references: true`
  const refs = { ...store, references: true };
  await connect(o1, "vault_approle", "vault-refs", refs, VAULT_SECRET_ID);
  await connect(o1, "vault_approle", "vault-refs-wrong", refs, "not-the-vault-secret-id-0123");
  await connect(
    o1,
    "vault_approle",
    "vault-refs-denied",
    { ...refs, prefix: "other" },
    VAULT_SECRET_ID,
  );
  await connect(o1, "aws_assume_role", "aws-refs", { ...role, references: true }, EXTERNAL_ID);
  await connect(
    o1,
    "aws_assume_role",
    "aws-refs-wrong",
    { ...role, references: true },
    "not-the-id",
  );
  await connect(o2, "vault_approle", "o2-only", refs, VAULT_SECRET_ID);
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
    layout?: string;
    policy?: string;
  } = {},
) {
  const id = ++n;
  const prefix = `/orch/w${id}`;
  const secretName = `env-w${id}`;
  const cluster = over.type === "kubernetes-secret";
  const store = over.type === "vault-kv";
  /** Under the connection's prefix, a path of this world's own. */
  const path = `w${id}`;
  const project = (await createProject(t.db, { organizationId: o1, name: `p${id}` })).id;
  const base = `/organizations/${o1}/projects/${project}`;
  const targets = `${base}/sync-targets`;
  const make = (b: object = {}) =>
    call("alice", "POST", targets, {
      name: "ssm",
      type: over.type ?? "aws-ssm",
      connectionId: over.connection ?? (cluster ? conns.kube : store ? conns.vault : conns.role),
      config:
        over.config ??
        (cluster
          ? { namespace: NAMESPACE, name: secretName, protected: true }
          : store
            ? { path, protected: true }
            : {
                region: REGION,
                prefix,
                protected: true,
                ...(over.layout && { layout: over.layout }),
              }),
      environmentMapping: {},
      ...(over.policy && { unmanagedPolicy: over.policy }),
      ...b,
    });
  const w = {
    prefix,
    path,
    secretName,
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
    secret: (name: string) => aws.secrets.get(`${prefix}/${name}`),
    /** The Secret of a kubernetes-secret target, and a key of it as text. */
    held: () => kube.secrets.get(`${NAMESPACE}/${secretName}`),
    text: (key: string) => kube.value(NAMESPACE, secretName, key),
    /** The data and the custom metadata of the secret of a scope, for a vault-kv target (`_` is every environment). */
    vdata: (scope = "_") => vault.data(`${VAULT_PREFIX}/${path}/${scope}`),
    vmeta: (scope = "_") => vault.custom(`${VAULT_PREFIX}/${path}/${scope}`),
    vault: (scope: string, data: Record<string, unknown>, custom: Record<string, string> | null) =>
      vault.seed(`${VAULT_PREFIX}/${path}/${scope}`, data, custom),
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
});

describe("an aws-sm target", () => {
  const tagsOf = (w: Awaited<ReturnType<typeof world>>, key: string) => w.secret(key)?.tags;

  test("is applied through the assumed role, one secret a key, and a plain value does not plan an update every time", async () => {
    const w = await world({ type: "aws-sm", policy: "prune" });
    const target = (await w.make({ name: "sm" })).json.id as string;
    const plainValue = sekrit("sm-plain");
    const secretValue = sekrit("sm-secret");
    await w.put("API_URL", "plain", plainValue);
    await w.put("DB_PASSWORD", "secret", secretValue);
    // ours but no longer wanted, and not ours at all
    aws.seedSecret(`${w.prefix}/OLD`, "old", { [OWNER_TAG]: w.prefix, "orch-layout": "per-key" });
    aws.seedSecret(`${w.prefix}/HAND`, "by hand");

    const plan = await w.plan(target);
    expect(plan.status).toBe(201);
    expect(brief(plan)).toEqual(["create API_URL *", "create DB_PASSWORD *", "delete OLD *"]);
    // planning reads; it writes nothing
    expect(w.secret("API_URL")).toBeUndefined();

    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(aws.secretValue(`${w.prefix}/API_URL`)).toBe(plainValue);
    expect(aws.secretValue(`${w.prefix}/DB_PASSWORD`)).toBe(secretValue);
    expect(tagsOf(w, "API_URL")).toEqual({
      [OWNER_TAG]: w.prefix,
      "orch-layout": "per-key",
      "orch-plain:API_URL": "1",
    });
    expect(tagsOf(w, "DB_PASSWORD")).toEqual({ [OWNER_TAG]: w.prefix, "orch-layout": "per-key" });
    // the old one is scheduled for deletion, not gone; the hand-made one is untouched
    expect(w.secret("OLD")?.deletedAt).toBeInstanceOf(Date);
    expect(aws.secretValue(`${w.prefix}/HAND`)).toBe("by hand");
    expect(w.secret("HAND")?.deletedAt).toBeUndefined();

    // every secret is encrypted in AWS, and the plain/secret flag still round-trips: nothing to do
    const again = await w.plan(target);
    expect(brief(again)).toEqual(["noop API_URL *", "noop DB_PASSWORD *"]);
  });

  test("one secret a scope keeps the keys that someone else put in it", async () => {
    const w = await world({ type: "aws-sm", layout: "per-scope" });
    const target = (await w.make({ name: "sm-scope" })).json.id as string;
    const value = sekrit("sm-scope");
    await w.put("FROM_US", "secret", value);
    aws.seedSecret(`${w.prefix}/_`, JSON.stringify({ HAND: "by hand", COUNT: 3 }), {
      [OWNER_TAG]: w.prefix,
      "orch-layout": "per-scope",
    });

    const plan = await w.plan(target);
    expect(brief(plan)).toEqual(["create FROM_US *"]);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(JSON.parse(aws.secretValue(`${w.prefix}/_`) ?? "null")).toEqual({
      HAND: "by hand",
      COUNT: 3,
      FROM_US: value,
    });
    expect(brief(await w.plan(target))).toEqual(["noop FROM_US *"]);
  });

  test("does not take over a secret that is there but not ours", async () => {
    const w = await world({ type: "aws-sm" });
    const target = (await w.make({ name: "sm" })).json.id as string;
    await w.put("CLASH", "plain", "ours");
    aws.seedSecret(`${w.prefix}/CLASH`, "by hand");
    const run = await w.finished(
      target,
      (await w.apply(target, (await w.plan(target)).json.id)).json.id,
    );
    expect(run.json.status).toBe("failed");
    expect(run.json.items[0].error).toContain(`${OWNER_TAG}=${w.prefix}`);
    expect(aws.secretValue(`${w.prefix}/CLASH`)).toBe("by hand");
  });

  test("a role AWS refuses fails the plan in the adapter's words, and a bad layout or a GitLab connection is refused at creation", async () => {
    const w = await world({ type: "aws-sm" });
    const target = (await w.make({ name: "sm" })).json.id as string;
    aws.denied.add("ListSecrets");
    try {
      const res = await w.plan(target);
      expect(res.status).toBe(502);
      expect(res.json.detail).toBe(
        "reading the secrets: AWS answered forbidden (AccessDeniedException)",
      );
    } finally {
      aws.denied.delete("ListSecrets");
    }
    const bad = await w.make({
      name: "bad",
      config: { region: REGION, prefix: "/x", layout: "per-env" },
    });
    expect(bad.status).toBe(422);
    expect((await w.make({ name: "gl", connectionId: conns.gitlab })).json.code).toBe(
      "connection_type_mismatch",
    );
  });
});

describe("a kubernetes-secret target", () => {
  const make = async (over: Parameters<typeof world>[0] = {}) => {
    const w = await world({ type: "kubernetes-secret", ...over });
    const made = await w.make({ name: "k8s" });
    expect(made.status).toBe(201);
    return { w, target: made.json.id as string };
  };

  test("is planned, then applied with the connection's token, into a Secret labelled as ours", async () => {
    const { w, target } = await make();
    const plainValue = sekrit("kube-plain");
    const secretValue = sekrit("kube-secret");
    await w.put("API_URL", "plain", plainValue);
    await w.put("DB_PASSWORD", "secret", secretValue);

    const plan = await w.plan(target);
    expect(plan.status).toBe(201);
    expect(brief(plan)).toEqual(["create API_URL *", "create DB_PASSWORD *"]);
    // planning reads; it writes nothing
    expect(w.held()).toBeUndefined();

    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.text("API_URL")).toBe(plainValue);
    expect(w.text("DB_PASSWORD")).toBe(secretValue);
    expect(w.held()?.labels).toEqual({ [MANAGED_LABEL]: w.secretName });
    expect(w.held()?.annotations).toEqual({ [PLAIN_ANNOTATION]: '["API_URL"]' });
    expect(w.held()?.type).toBe("Opaque");
    // the token never went anywhere but the cluster's own address
    expect(kube.calls.every((c) => c.authorization === `Bearer ${KUBE_TOKEN}`)).toBe(true);

    // applying twice changes nothing: the next plan has only no-ops, plain and secret alike
    expect(brief(await w.plan(target))).toEqual(["noop API_URL *", "noop DB_PASSWORD *"]);
  });

  test("a change is an update, and keys that someone added by hand stay", async () => {
    const { w, target } = await make();
    kube.seed(
      NAMESPACE,
      w.secretName,
      { HAND: "by hand" },
      { labels: { [MANAGED_LABEL]: w.secretName } },
    );
    await w.put("CHANGING", "plain", "first");
    await w.finished(target, (await w.apply(target, (await w.plan(target)).json.id)).json.id);
    expect(w.text("CHANGING")).toBe("first");

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
    expect(w.text("CHANGING")).toBe("second");
    expect(w.text("HAND")).toBe("by hand");
  });

  test("with the prune policy, a key of the Secret that is no longer wanted goes and the Secret stays", async () => {
    const { w, target } = await make({ policy: "prune" });
    kube.seed(
      NAMESPACE,
      w.secretName,
      { OLD: "old", WANTED: "w" },
      {
        labels: { [MANAGED_LABEL]: w.secretName },
        annotations: { [PLAIN_ANNOTATION]: '["WANTED"]' },
      },
    );
    await w.put("WANTED", "plain", "w");
    const plan = await w.plan(target);
    expect(brief(plan)).toEqual(["delete OLD *", "noop WANTED *"]);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.text("OLD")).toBeUndefined();
    expect(w.text("WANTED")).toBe("w");
    expect(w.held()?.labels).toEqual({ [MANAGED_LABEL]: w.secretName });
  });

  test("does not take over a Secret that is there but not ours", async () => {
    const { w, target } = await make();
    kube.seed(NAMESPACE, w.secretName, { CLASH: "by hand" });
    await w.put("CLASH", "plain", "ours");
    const plan = await w.plan(target);
    expect(brief(plan)).toEqual(["create CLASH *"]);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("failed");
    expect(run.json.items[0].error).toContain(`${MANAGED_LABEL}=${w.secretName}`);
    expect(w.text("CLASH")).toBe("by hand");
    expect(w.held()?.labels).toEqual({});
  });

  test("a namespace the connection does not allow is refused when the plan is made, and nothing is sent", async () => {
    const { w, target } = await make({ config: { namespace: "kube-system", name: "x" } });
    const before = kube.calls.length;
    const res = await w.plan(target);
    expect([res.status, res.json.code]).toEqual([422, "plan_invalid"]);
    expect(res.json.detail).toBe("the namespace is not one the connection allows");
    expect(kube.calls.length).toBe(before);
  });

  test("a variable of an environment, which a Secret has no scope for, refuses the plan and names it", async () => {
    const w = await world({ type: "kubernetes-secret" });
    const env = await createEnvironment(t.db, {
      organizationId: o1,
      projectId: w.project,
      name: "production",
      slug: "production",
    });
    const target = (await w.make({ name: "k8s", environmentMapping: { production: "production" } }))
      .json.id as string;
    await w.put("API_URL", "plain", "base");
    const set = await call(
      "alice",
      "POST",
      `/organizations/${o1}/projects/${w.project}/environments/${env.id}/variables`,
      { key: "API_URL", kind: "plain", value: "production-only" },
    );
    expect(set.status).toBe(201);
    const res = await w.plan(target);
    expect([res.status, res.json.code]).toEqual([422, "plan_invalid"]);
    expect(res.json.detail).toContain("a Secret has no scopes");
    expect(w.held()).toBeUndefined();
  });

  test("a cluster that rejects the token fails the plan in the adapter's words", async () => {
    const { w, target } = await make({ connection: conns.kubeWrongToken });
    const res = await w.plan(target);
    expect([res.status, res.json.code]).toEqual([502, "target_failed"]);
    expect(res.json.detail).toBe("reading the Secret: Kubernetes answered unauthorized (401)");
    expect(res.text).not.toContain("not-the-cluster-token");
  });

  test("needs a Kubernetes connection of this organization and a valid config", async () => {
    const w = await world({ type: "kubernetes-secret" });
    expect((await w.make({ connectionId: conns.gitlab })).json.code).toBe(
      "connection_type_mismatch",
    );
    expect((await w.make({ connectionId: conns.role })).json.code).toBe("connection_type_mismatch");
    expect((await w.make({ connectionId: conns.kubeOther })).json.code).toBe("unknown_connection");
    for (const config of [
      { namespace: "Apps", name: "x" },
      { namespace: NAMESPACE },
      { namespace: NAMESPACE, name: "x", token: "no" },
    ]) {
      expect((await w.make({ config })).status).toBe(422);
    }
    const wrong = await world({ connection: conns.kube });
    expect((await wrong.make()).json.code).toBe("connection_type_mismatch");
  });

  test("a connection that is not a Kubernetes one never has its secret sent to a cluster", async () => {
    const w = await world({ type: "kubernetes-secret" });
    // the route refuses this pairing; a row that got there some other way must not slip through
    const row = await createSyncTarget(t.db, {
      organizationId: o1,
      projectId: w.project,
      name: "sneaky",
      type: "kubernetes-secret",
      connectionId: conns.role,
      config: { namespace: NAMESPACE, name: w.secretName },
      environmentMapping: {},
    });
    const before = kube.calls.length;
    const res = await w.plan(row.id);
    expect([res.status, res.json.code]).toEqual([422, "connection_type"]);
    expect(kube.calls.length).toBe(before);
  });
});

describe("a vault-kv target", () => {
  const make = async (over: Parameters<typeof world>[0] = {}) => {
    const w = await world({ type: "vault-kv", ...over });
    const made = await w.make({ name: "vault" });
    expect(made.status).toBe(201);
    return { w, target: made.json.id as string };
  };
  const marker = (w: { path: string }) => `${VAULT_PREFIX}/${w.path}`;

  test("is planned, then applied through a login of its own, into a secret marked as ours", async () => {
    const { w, target } = await make();
    const plainValue = sekrit("vault-plain");
    const secretValue = sekrit("vault-secret");
    await w.put("API_URL", "plain", plainValue);
    await w.put("DB_PASSWORD", "secret", secretValue);

    const before = vault.calls.length;
    const plan = await w.plan(target);
    expect(plan.status).toBe(201);
    expect(brief(plan)).toEqual(["create API_URL *", "create DB_PASSWORD *"]);
    // planning reads; it writes nothing
    expect(
      vault.calls.slice(before).filter((c) => c.method === "POST" && c.path.startsWith("kv/")),
    ).toEqual([]);
    expect(w.vdata()).toBeUndefined();

    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.vdata()).toEqual({ API_URL: plainValue, DB_PASSWORD: secretValue });
    expect(w.vmeta()).toEqual({ [MANAGED_KEY]: marker(w), [`${PLAIN_PREFIX}API_URL`]: "1" });
    // the secret ID went to the login only, and no token outlived the call it was made for
    const logins = vault.calls.filter((c) => c.path === "auth/approle/login");
    expect(logins.length).toBeGreaterThan(0);
    for (const c of vault.calls) {
      const carried = JSON.stringify(c.body ?? "");
      expect([c.path, carried.includes(VAULT_SECRET_ID)]).toEqual([
        c.path,
        c.path === "auth/approle/login",
      ]);
    }
    expect(vault.live.size).toBe(0);
    expect(vault.calls.some((c) => c.method === "DELETE")).toBe(false);

    // applying twice changes nothing: the next plan has only no-ops, plain and secret alike
    expect(brief(await w.plan(target))).toEqual(["noop API_URL *", "noop DB_PASSWORD *"]);
  });

  test("a variable of an environment lands in the secret of that scope", async () => {
    const w = await world({ type: "vault-kv" });
    const env = await createEnvironment(t.db, {
      organizationId: o1,
      projectId: w.project,
      name: "production",
      slug: "production",
    });
    const target = (
      await w.make({ name: "vault", environmentMapping: { production: "production" } })
    ).json.id as string;
    await w.put("API_URL", "plain", "base");
    const set = await call(
      "alice",
      "POST",
      `/organizations/${o1}/projects/${w.project}/environments/${env.id}/variables`,
      { key: "API_URL", kind: "plain", value: "production-only" },
    );
    expect(set.status).toBe(201);
    const plan = await w.plan(target);
    expect(brief(plan)).toEqual(["create API_URL *", "create API_URL production"]);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.vdata()).toEqual({ API_URL: "base" });
    expect(w.vdata("production")).toEqual({ API_URL: "production-only" });
  });

  test("a change is an update, and fields that someone added by hand stay", async () => {
    const { w, target } = await make();
    w.vault("_", { HAND: "by hand" }, { [MANAGED_KEY]: marker(w), team: "ops" });
    await w.put("CHANGING", "plain", "first");
    await w.finished(target, (await w.apply(target, (await w.plan(target)).json.id)).json.id);
    expect(w.vdata()).toEqual({ HAND: "by hand", CHANGING: "first" });

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
    expect(w.vdata()).toEqual({ HAND: "by hand", CHANGING: "second" });
    expect(w.vmeta()).toEqual({
      [MANAGED_KEY]: marker(w),
      team: "ops",
      [`${PLAIN_PREFIX}CHANGING`]: "1",
    });
  });

  test("with the prune policy, a field that is no longer wanted goes in a new version, and the secret stays", async () => {
    const { w, target } = await make({ policy: "prune" });
    w.vault(
      "_",
      { OLD: "old", WANTED: "w" },
      { [MANAGED_KEY]: marker(w), [`${PLAIN_PREFIX}WANTED`]: "1" },
    );
    await w.put("WANTED", "plain", "w");
    const plan = await w.plan(target);
    expect(brief(plan)).toEqual(["delete OLD *", "noop WANTED *"]);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.vdata()).toEqual({ WANTED: "w" });
    expect(vault.secrets.get(`${VAULT_PREFIX}/${w.path}/_`)?.versions).toHaveLength(2);
    expect(
      vault.secrets
        .get(`${VAULT_PREFIX}/${w.path}/_`)
        ?.versions.some((v) => v.deleted || v.destroyed),
    ).toBe(false);
    expect(vault.calls.some((c) => c.method === "DELETE" || /destroy|delete/.test(c.path))).toBe(
      false,
    );
  });

  test("does not take over a secret that is there but not ours", async () => {
    const { w, target } = await make();
    w.vault("_", { CLASH: "by hand" }, null);
    await w.put("CLASH", "plain", "ours");
    const plan = await w.plan(target);
    expect(brief(plan)).toEqual(["create CLASH *"]);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("failed");
    expect(run.json.items[0].error).toContain(`${MANAGED_KEY}=${marker(w)}`);
    expect(w.vdata()).toEqual({ CLASH: "by hand" });
    expect(w.vmeta()).toBeNull();
  });

  test("a Vault that rejects the secret ID fails the plan in fixed words", async () => {
    const { w, target } = await make({ connection: conns.vaultWrongSecret });
    const res = await w.plan(target);
    expect([res.status, res.json.code]).toEqual([502, "target_failed"]);
    expect(res.json.detail).toContain("role ID or secret ID");
    expect(res.text).not.toContain("not-the-vault-secret-id");
    expect(vault.live.size).toBe(0);
  });

  test("needs a Vault connection of this organization and a valid config", async () => {
    const w = await world({ type: "vault-kv" });
    expect((await w.make({ connectionId: conns.gitlab })).json.code).toBe(
      "connection_type_mismatch",
    );
    expect((await w.make({ connectionId: conns.kube })).json.code).toBe("connection_type_mismatch");
    expect((await w.make({ connectionId: conns.vaultOther })).json.code).toBe("unknown_connection");
    for (const config of [
      { path: "../other" },
      { path: "a/b/c/d/e" },
      {},
      { path: "ok", token: "no" },
    ]) {
      expect((await w.make({ config })).status).toBe(422);
    }
    const wrong = await world({ connection: conns.vault });
    expect((await wrong.make()).json.code).toBe("connection_type_mismatch");
  });

  test("a connection that is not a Vault one never has its secret sent to a Vault", async () => {
    const w = await world({ type: "vault-kv" });
    // the route refuses this pairing; a row that got there some other way must not slip through
    const row = await createSyncTarget(t.db, {
      organizationId: o1,
      projectId: w.project,
      name: "sneaky",
      type: "vault-kv",
      connectionId: conns.role,
      config: { path: w.path },
      environmentMapping: {},
    });
    const before = vault.calls.length;
    const res = await w.plan(row.id);
    expect([res.status, res.json.code]).toEqual([422, "connection_type"]);
    expect(vault.calls.length).toBe(before);
  });
});

describe("external references", () => {
  const make = async (over: Parameters<typeof world>[0] = {}) => {
    const w = await world(over);
    const made = await w.make({ name: "refs" });
    expect(made.status).toBe(201);
    return { w, target: made.json.id as string };
  };
  /** A source of values of this test's own, under the Vault prefix. */
  const source = () => `ref${++n}`;
  const runs = async () => (await t.db.select().from(syncRuns)).length;
  const gets = () => vault.calls.filter((c) => c.method === "GET" && c.path.startsWith("kv/data/"));

  test("a variable that points at a Vault field is synced as that value, as a secret", async () => {
    const { w, target } = await make();
    const src = source();
    const value = sekrit("ref-vault");
    vault.seed(`${VAULT_PREFIX}/${src}/db`, { password: value, other: "unused" });
    const pointer = `vault://vault-refs/${src}/db#password`;
    await w.put("DB_PASSWORD", "plain", pointer);
    await w.put("API_URL", "plain", "https://api.example.test");

    const plan = await w.plan(target);
    expect(plan.status).toBe(201);
    expect(brief(plan)).toEqual(["create API_URL *", "create DB_PASSWORD *"]);
    // planning read the secret and wrote nothing
    expect(w.param("DB_PASSWORD")).toBeUndefined();
    expect(vault.live.size).toBe(0);

    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    // a plain variable that held a pointer is a secret where it lands
    expect(w.param("DB_PASSWORD")).toMatchObject({ type: "SecureString", value });
    expect(w.param("API_URL")).toMatchObject({ type: "String", value: "https://api.example.test" });
    expect(vault.live.size).toBe(0);
    // nothing changed since: the next plan has only no-ops
    expect(brief(await w.plan(target))).toEqual(["noop API_URL *", "noop DB_PASSWORD *"]);

    // everywhere else the variable is still the pointer, and listing it asks no store anything
    const before = gets().length;
    const listed = await call(
      "alice",
      "GET",
      `/organizations/${o1}/projects/${w.project}/variables`,
    );
    expect(listed.text).toContain(pointer);
    expect(listed.text).not.toContain(value);
    expect(gets().length).toBe(before);
  });

  test("the value read when the apply runs is the one written, not the one at plan time", async () => {
    const { w, target } = await make();
    const src = source();
    const first = sekrit("ref-first");
    const second = sekrit("ref-second");
    vault.seed(`${VAULT_PREFIX}/${src}/db`, { password: first });
    await w.put("DB_PASSWORD", "plain", `vault://vault-refs/${src}/db#password`);
    const plan = await w.plan(target);
    vault.seed(`${VAULT_PREFIX}/${src}/db`, { password: second });
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.param("DB_PASSWORD")).toMatchObject({ value: second });
  });

  test("a Secrets Manager secret, whole or by a JSON field, can be synced to another kind of target", async () => {
    const { w, target } = await make({ type: "vault-kv" });
    const src = source();
    const whole = sekrit("ref-aws-whole");
    const field = sekrit("ref-aws-field");
    aws.seedSecret(`${src}/token`, whole);
    aws.seedSecret(`${src}/db`, JSON.stringify({ password: field, user: "u" }));
    await w.put("TOKEN", "plain", `aws-sm://aws-refs/${src}/token`);
    await w.put("DB_PASSWORD", "secret", `aws-sm://aws-refs/${src}/db#password`);
    const plan = await w.plan(target);
    expect(brief(plan)).toEqual(["create DB_PASSWORD *", "create TOKEN *"]);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.vdata()).toEqual({ TOKEN: whole, DB_PASSWORD: field });
    // both are secrets there: neither is flagged plain
    expect(w.vmeta()).toEqual({ [MANAGED_KEY]: `${VAULT_PREFIX}/${w.path}` });
  });

  test("a variable that reads a pointer is a secret too, and what the store holds is never read as references", async () => {
    const { w, target } = await make();
    const src = source();
    const value = [sekrit("ref-odd"), "${NOPE}", "$${LITERAL}", "$"].join("");
    vault.seed(`${VAULT_PREFIX}/${src}/db`, { password: value });
    await w.put("DB_PASSWORD", "plain", `vault://vault-refs/${src}/db#password`);
    await w.put("DB_URL", "plain", "postgres://app:${DB_PASSWORD}@db.example.test/app");
    const plan = await w.plan(target);
    expect(plan.status).toBe(201);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.param("DB_PASSWORD")).toMatchObject({ type: "SecureString", value });
    expect(w.param("DB_URL")).toMatchObject({
      type: "SecureString",
      value: `postgres://app:${value}@db.example.test/app`,
    });
  });

  test("a pointer of an environment lands in the scope of that environment", async () => {
    const w = await world({ type: "vault-kv" });
    const env = await createEnvironment(t.db, {
      organizationId: o1,
      projectId: w.project,
      name: "production",
      slug: "production",
    });
    const target = (
      await w.make({ name: "refs", environmentMapping: { production: "production" } })
    ).json.id as string;
    const src = source();
    const base = sekrit("ref-base");
    const prod = sekrit("ref-prod");
    vault.seed(`${VAULT_PREFIX}/${src}/base`, { key: base });
    vault.seed(`${VAULT_PREFIX}/${src}/prod`, { key: prod });
    await w.put("API_KEY", "plain", `vault://vault-refs/${src}/base#key`);
    const set = await call(
      "alice",
      "POST",
      `/organizations/${o1}/projects/${w.project}/environments/${env.id}/variables`,
      { key: "API_KEY", kind: "plain", value: `vault://vault-refs/${src}/prod#key` },
    );
    expect(set.status).toBe(201);
    const plan = await w.plan(target);
    expect(brief(plan)).toEqual(["create API_KEY *", "create API_KEY production"]);
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("applied");
    expect(w.vdata()).toEqual({ API_KEY: base });
    expect(w.vdata("production")).toEqual({ API_KEY: prod });
  });

  test("a pointer used by several variables is read once, on one login", async () => {
    const { w, target } = await make();
    const src = source();
    vault.seed(`${VAULT_PREFIX}/${src}/db`, { password: sekrit("ref-shared") });
    vault.seed(`${VAULT_PREFIX}/${src}/other`, { password: sekrit("ref-other") });
    const pointer = `vault://vault-refs/${src}/db#password`;
    await w.put("A", "plain", pointer);
    await w.put("B", "secret", pointer);
    await w.put("C", "plain", `vault://vault-refs/${src}/other#password`);
    const [loggedIn, read] = [vault.logins, gets().length];
    const plan = await w.plan(target);
    expect(plan.status).toBe(201);
    expect([vault.logins - loggedIn, gets().length - read]).toEqual([1, 2]);
    expect(vault.live.size).toBe(0);
  });

  const failing: [string, string, number, string, ReferenceReason][] = [
    [
      "a secret that is not there",
      "vault://vault-refs/{src}/gone#f",
      502,
      "reference_failed",
      "not_found",
    ],
    [
      "a field that is not there",
      "vault://vault-refs/{src}/db#absent",
      502,
      "reference_failed",
      "not_found",
    ],
    [
      "a path the credential may not read",
      "vault://vault-refs-denied/{src}/db#f",
      502,
      "reference_failed",
      "denied",
    ],
    [
      "a Vault that refuses the secret ID",
      "vault://vault-refs-wrong/{src}/db#f",
      502,
      "reference_failed",
      "credential",
    ],
    [
      "an AWS role that refuses the external ID",
      "aws-sm://aws-refs-wrong/{src}/db",
      502,
      "reference_failed",
      "credential",
    ],
    [
      "an AWS secret that is not there",
      "aws-sm://aws-refs/{src}/gone",
      502,
      "reference_failed",
      "not_found",
    ],
    [
      "a connection that is not there",
      "vault://nope/{src}/db#f",
      422,
      "reference_invalid",
      "unknown_connection",
    ],
    [
      "a connection of another organization",
      "vault://o2-only/{src}/db#f",
      422,
      "reference_invalid",
      "unknown_connection",
    ],
    [
      "a connection that does not allow references",
      "vault://vault/{src}/db#f",
      422,
      "reference_invalid",
      "not_enabled",
    ],
    [
      "a connection of a kind that holds no secrets",
      "vault://gl/{src}/db#f",
      422,
      "reference_invalid",
      "wrong_connection",
    ],
    [
      "a reference that is not one",
      "vault://vault-refs/{src}",
      422,
      "reference_invalid",
      "malformed",
    ],
  ];
  for (const [what, template, status, code, reason] of failing) {
    test(`${what} fails the whole plan, in fixed words, and stores nothing`, async () => {
      const { w, target } = await make();
      const src = source();
      vault.seed(`${VAULT_PREFIX}/${src}/db`, { f: "present" });
      vault.seed(`other/${src}/db`, { f: "present" });
      aws.seedSecret(`${src}/db`, "present");
      await w.put("FINE", "plain", `vault://vault-refs/${src}/db#f`);
      await w.put("BROKEN", "plain", template.replace("{src}", src));
      const before = await runs();
      const res = await w.plan(target);
      expect([res.status, res.json.code]).toEqual([status, code]);
      expect(res.json.detail).toContain(`BROKEN ${REFERENCE_WHY[reason]}`);
      // the variable that was fine is not named, and nothing of the stores is
      expect(res.json.detail).not.toContain("FINE");
      for (const leaked of [src, "present", VAULT_SECRET_ID, EXTERNAL_ID]) {
        expect(res.text).not.toContain(leaked);
      }
      expect(await runs()).toBe(before);
      expect(vault.live.size).toBe(0);
    });
  }

  test("more different references than one plan reads is refused before any store is asked", async () => {
    const { w, target } = await make();
    const src = source();
    for (let i = 0; i < 51; i++) await w.put(`K${i}`, "plain", `vault://vault-refs/${src}/s${i}#f`);
    const [loggedIn, read] = [vault.logins, gets().length];
    const res = await w.plan(target);
    expect([res.status, res.json.code]).toEqual([422, "reference_invalid"]);
    expect([vault.logins, gets().length]).toEqual([loggedIn, read]);
  });

  test("a value that cannot be read when the apply runs fails the run and writes nothing", async () => {
    const { w, target } = await make();
    const src = source();
    vault.seed(`${VAULT_PREFIX}/${src}/db`, { password: sekrit("ref-late") });
    await w.put("DB_PASSWORD", "plain", `vault://vault-refs/${src}/db#password`);
    await w.put("API_URL", "plain", "https://api.example.test");
    const plan = await w.plan(target);
    expect(plan.status).toBe(201);
    vault.remove(`${VAULT_PREFIX}/${src}/db`, "destroy");
    const run = await w.finished(target, (await w.apply(target, plan.json.id)).json.id);
    expect(run.json.status).toBe("failed");
    expect(run.json.error).toContain(`DB_PASSWORD ${REFERENCE_WHY.not_found}`);
    expect(run.text).not.toContain(src);
    expect(w.param("DB_PASSWORD")).toBeUndefined();
    expect(w.param("API_URL")).toBeUndefined();
    expect(vault.live.size).toBe(0);
  });
});

describe("across every target type", () => {
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
