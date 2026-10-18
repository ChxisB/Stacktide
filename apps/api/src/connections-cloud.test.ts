import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  connections,
  createOrganization,
  createSession,
  openConnection,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import type { Fetch } from "@orch/sync";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { openGitlabConnection } from "./connections";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const keys = envKeyProvider(`k1:${key(1)}`);

const EXTERNAL_ID = "ext-id-CANARY-0123456789";
const KUBE_TOKEN = "kube-token-CANARY-0123456789abcdef";
const SECRET_ID = "vault-secret-id-CANARY-0123";
const BASE_SECRET = "platform-secret-key-CANARY-0123";
const aws = {
  type: "aws_assume_role",
  roleArn: "arn:aws:iam::111122223333:role/orch-sync",
  region: "eu-west-1",
  externalId: EXTERNAL_ID,
};
const kube = {
  type: "kubernetes",
  server: "https://k8s.example.test:6443",
  namespaces: ["apps", "staging"],
  token: KUBE_TOKEN,
};
const vault = {
  type: "vault_approle",
  address: "https://vault.example.test:8200",
  roleId: "role-id-1234",
  kvMount: "kv",
  prefix: "app/prod",
  secretId: SECRET_ID,
};
const SECRETS = [EXTERNAL_ID, KUBE_TOKEN, SECRET_ID, BASE_SECRET];

/** One fake for the three systems, told apart by host. `down` answers a host with a status instead. */
function fakeCloud() {
  const calls: {
    host: string;
    path: string;
    headers: Record<string, string>;
    body: string;
    tls: unknown;
  }[] = [];
  const down = new Map<string, number>();
  const fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = String(init.body ?? "");
    calls.push({ host: u.hostname, path: u.pathname, headers, body, tls: init.tls });
    const status = down.get(u.hostname);
    if (status) return new Response("leak", { status });
    if (u.hostname.startsWith("sts.")) {
      return new URLSearchParams(body).get("Action") === "AssumeRole"
        ? new Response(
            "<R><AccessKeyId>ASIA1</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken><Expiration>2030-01-01T00:15:00Z</Expiration></R>",
          )
        : new Response("<R><Arn>arn:aws:sts::111122223333:assumed-role/orch-sync/orch</Arn></R>");
    }
    if (u.pathname.endsWith("/selfsubjectaccessreviews")) {
      return Response.json({ status: { allowed: true } }, { status: 201 });
    }
    if (u.pathname.endsWith("/login")) return Response.json({ auth: { client_token: "hvs.x" } });
    if (u.pathname.endsWith("/capabilities-self")) {
      const data = Object.fromEntries(
        (JSON.parse(body).paths as string[]).map((p) => [
          p,
          p.includes("/data/") ? ["create", "read", "update"] : ["create", "update", "list"],
        ]),
      );
      return Response.json({ data });
    }
    return new Response(null, { status: 204 });
  };
  return { fetch, calls, down };
}

let t: TestDb;
let o1: string;
let cloud: ReturnType<typeof fakeCloud>;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob", { id: string; cookie: string }>;

const makeApp = (
  over: { keys?: typeof keys | undefined; aws?: boolean; loopback?: boolean } = {},
) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys: "keys" in over ? over.keys : keys,
    loopbackConnections: over.loopback ?? false,
    cloud: {
      fetch: cloud.fetch,
      aws: () =>
        over.aws === false
          ? undefined
          : { accessKeyId: "AKIAPLATFORM000000", secretAccessKey: BASE_SECRET },
    },
  });
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await createTestDb();
  cloud = fakeCloud();
  o1 = (await createOrganization(t.db, { slug: "cloud-one", name: "One" })).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [o1]: "admin" }, projectRoles: {} });
  roleTable.set(902, { orgRoles: { [o1]: "member" }, projectRoles: {} });
  app = makeApp();
});
afterAll(async () => {
  await t.drop();
});

async function call(
  who: keyof typeof people,
  method: string,
  path: string,
  body?: unknown,
  application = app,
) {
  const headers: Record<string, string> = { cookie: people[who].cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await application.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const url = () => `/organizations/${o1}/connections`;
let n = 0;
const make = (b: object, over: object = {}) => ({ ...b, name: `c${++n}`, ...over });
const stored = async (id: string) =>
  (await t.db.select().from(connections).where(eq(connections.id, id)))[0];

const KINDS = [
  { label: "aws_assume_role", body: aws, secret: EXTERNAL_ID, host: "sts.eu-west-1.amazonaws.com" },
  { label: "kubernetes", body: kube, secret: KUBE_TOKEN, host: "k8s.example.test" },
  { label: "vault_approle", body: vault, secret: SECRET_ID, host: "vault.example.test" },
] as const;

describe.each(KINDS)("a $label connection", ({ body, secret, host }) => {
  test("is checked, stored sealed, and answered without its secret", async () => {
    const before = cloud.calls.length;
    const res = await call("alice", "POST", url(), make(body));
    expect(res.status).toBe(201);
    expect(cloud.calls.length).toBeGreaterThan(before);
    expect(cloud.calls.slice(before).every((c) => c.host === host)).toBe(true);
    expect(res.json.type).toBe(body.type);
    expect(Object.keys(res.json).sort()).toEqual([
      "config",
      "createdAt",
      "id",
      "name",
      "organizationId",
      "type",
      "updatedAt",
    ]);
    for (const s of SECRETS) expect(res.text).not.toContain(s);

    const row = await stored(res.json.id);
    expect(Buffer.from(row?.secretEnc ?? []).toString("utf8")).not.toContain(secret);
    expect(JSON.stringify(row?.config)).not.toContain(secret);
    // and it comes back out, only to the code that talks to the system
    const opened = await openConnection(t.db, keys, o1, res.json.id);
    expect(opened?.token).toBe(secret);

    const listed = await call("alice", "GET", `${url()}?limit=100`);
    for (const s of SECRETS) expect(listed.text).not.toContain(s);
    const events = JSON.stringify(
      await t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, res.json.id)),
    );
    expect(events).toContain("connection.create");
    for (const s of SECRETS) expect(events).not.toContain(s);
    for (const s of SECRETS) expect(lines.join("\n")).not.toContain(s);
  });

  test("the test route checks it again with the stored secret and says so in an audit row", async () => {
    const c = await call("alice", "POST", url(), make(body));
    const before = cloud.calls.length;
    const res = await call("alice", "POST", `${url()}/${c.json.id}/test`);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(typeof res.json.summary).toBe("string");
    expect(
      cloud.calls
        .slice(before)
        .some((x) => x.body.includes(secret) || JSON.stringify(x.headers).includes(secret)),
    ).toBe(true);
    for (const s of SECRETS) expect(res.text).not.toContain(s);
    const events = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, c.json.id));
    const test = events.find((e) => e.action === "connection.test");
    expect(test?.metadata).toEqual({ ok: true });
  });

  test("a system that says no is a 422 in fixed words, and nothing is stored", async () => {
    const before = (await t.db.select().from(connections)).length;
    cloud.down.set(host, 403);
    try {
      const res = await call("alice", "POST", url(), make(body));
      expect([res.status, res.json.code]).toEqual([422, "connection_test_failed"]);
      for (const s of SECRETS) expect(res.text).not.toContain(s);
      expect(res.text).not.toContain(host);
      expect(res.text).not.toContain("leak");
    } finally {
      cloud.down.delete(host);
    }
    expect(await t.db.select().from(connections)).toHaveLength(before);
  });

  test("a stored connection that stops working is reported by the test route, and audited", async () => {
    const c = await call("alice", "POST", url(), make(body));
    cloud.down.set(host, 401);
    try {
      const res = await call("alice", "POST", `${url()}/${c.json.id}/test`);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: false, reason: "unauthorized" });
      expect(res.json.message).toEqual(expect.any(String));
      for (const s of SECRETS) expect(res.text).not.toContain(s);
    } finally {
      cloud.down.delete(host);
    }
    const events = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, c.json.id));
    expect(events.find((e) => e.action === "connection.test")?.metadata).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });

  test("a stored configuration the schema no longer accepts is a 422, not a 500, and never reaches the network", async () => {
    const c = await call("alice", "POST", url(), make(body));
    await t.db
      .update(connections)
      .set({ config: { stale: true } })
      .where(eq(connections.id, c.json.id));
    const sent = cloud.calls.length;
    const res = await call("alice", "POST", `${url()}/${c.json.id}/test`);
    expect([res.status, res.json.code]).toEqual([422, "connection_config"]);
    expect(cloud.calls).toHaveLength(sent);
  });

  test("members cannot create, test or delete it", async () => {
    const made = await call("alice", "POST", url(), make(body));
    expect((await call("bob", "POST", url(), make(body))).status).toBe(403);
    expect((await call("bob", "POST", `${url()}/${made.json.id}/test`)).status).toBe(403);
    expect((await call("bob", "DELETE", `${url()}/${made.json.id}`)).status).toBe(403);
  });

  test("says so when there is no master key, and stores nothing", async () => {
    const before = (await t.db.select().from(connections)).length;
    const res = await call("alice", "POST", url(), make(body), makeApp({ keys: undefined }));
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    expect(await t.db.select().from(connections)).toHaveLength(before);
  });

  test("a field that is not part of its shape is refused, and the secret is not echoed", async () => {
    for (const over of [
      { organizationId: o1 },
      { token: "x".repeat(30), baseUrl: "https://x.test" },
      { name: "" },
    ]) {
      const res = await call("alice", "POST", url(), make(body, over));
      expect([over, res.status, res.json.code]).toEqual([over, 422, "validation_failed"]);
      for (const s of SECRETS) expect(res.text).not.toContain(s);
    }
    const missing = Object.keys(body).filter((k) => k !== "type");
    for (const field of missing) {
      const { [field as keyof typeof body]: _gone, ...rest } = body as Record<string, unknown>;
      const res = await call("alice", "POST", url(), make(rest));
      expect([field, res.status]).toEqual([field, 422]);
    }
  });
});

describe("the AWS connection", () => {
  test("needs the platform's own identity, and makes no call without it", async () => {
    const before = [cloud.calls.length, (await t.db.select().from(connections)).length];
    const res = await call("alice", "POST", url(), make(aws), makeApp({ aws: false }));
    expect([res.status, res.json.code]).toEqual([503, "aws_identity_unavailable"]);
    expect([cloud.calls.length, (await t.db.select().from(connections)).length]).toEqual(before);
  });

  test("signs with the platform's identity and never sends its secret", async () => {
    const before = cloud.calls.length;
    await call("alice", "POST", url(), make(aws));
    const first = cloud.calls[before];
    expect(first?.headers.authorization).toContain("Credential=AKIAPLATFORM000000/");
    expect(first?.body).toContain("ExternalId=");
    expect(JSON.stringify(cloud.calls.slice(before))).not.toContain(BASE_SECRET);
  });

  test("rejects roles and regions that are not what they say", async () => {
    for (const over of [
      { roleArn: "arn:aws:iam::111122223333:user/orch" },
      { region: "eu-west-1.evil.test/" },
      { externalId: "short" },
      { externalId: `${EXTERNAL_ID} with spaces` },
    ]) {
      const res = await call("alice", "POST", url(), make(aws, over));
      expect([over, res.status]).toEqual([over, 422]);
    }
  });
});

describe("the Kubernetes and Vault connections", () => {
  test("a server that points at this machine is refused unless the app allows it", async () => {
    const before = [cloud.calls.length, (await t.db.select().from(connections)).length];
    for (const [b, field, value] of [
      [kube, "server", "https://localhost:6443"],
      [kube, "server", "https://127.0.0.1:6443"],
      [kube, "server", "https://[::1]:6443"],
      [kube, "server", "https://k8s.localhost"],
      [vault, "address", "https://localhost:8200"],
      [vault, "address", "https://0.0.0.0:8200"],
    ] as const) {
      const res = await call("alice", "POST", url(), make(b, { [field]: value }));
      expect([value, res.status, res.json.code]).toEqual([value, 422, "base_url_refused"]);
    }
    expect([cloud.calls.length, (await t.db.select().from(connections)).length]).toEqual(before);
    const allowed = await call(
      "alice",
      "POST",
      url(),
      make(kube, { server: "https://localhost:6443" }),
      makeApp({ loopback: true }),
    );
    expect(allowed.status).toBe(201);
  });

  test("a private CA is kept with the connection, trusted for its checks, and left out of the audit row", async () => {
    // longer than the audit log takes in one value: a certificate chain is
    const ca = `-----BEGIN CERTIFICATE-----\n${"MIIB".repeat(1500)}\n-----END CERTIFICATE-----\n`;
    const sent = cloud.calls.length;
    const res = await call("alice", "POST", url(), make(kube, { ca }));
    expect(res.status).toBe(201);
    expect(cloud.calls.slice(sent).every((c) => (c.tls as { ca: string }).ca === ca)).toBe(true);
    expect((await stored(res.json.id))?.config).toMatchObject({ ca });
    const events = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, res.json.id));
    const created = events.find((e) => e.action === "connection.create");
    expect(created?.metadata).toMatchObject({ type: "kubernetes", server: kube.server });
    expect(JSON.stringify(created?.metadata)).not.toContain("MIIB");
  });

  test("addresses that are not https origins are refused without being echoed", async () => {
    for (const [b, field] of [
      [kube, "server"],
      [vault, "address"],
    ] as const) {
      for (const value of [
        "http://x.test",
        "https://user:hunter2@x.test",
        "https://x.test/path",
        "nope",
      ]) {
        const res = await call("alice", "POST", url(), make(b, { [field]: value }));
        expect([value, res.status]).toEqual([value, 422]);
        expect(res.text).not.toContain("hunter2");
      }
    }
  });
});

describe("types that hold different secrets", () => {
  test("a connection of another type is never used as a GitLab connection", async () => {
    const c = await call("alice", "POST", url(), make(kube));
    const e = await openGitlabConnection(
      { db: t.db, keys, logger: createLogger({ level: "error", write: () => {} }) },
      o1,
      c.json.id,
      undefined,
    ).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "connection_type", status: 422 });
  });

  test("the type is still a closed list", async () => {
    const res = await call("alice", "POST", url(), make(kube, { type: "azure" }));
    expect([res.status, res.json.code]).toEqual([422, "validation_failed"]);
  });
});
