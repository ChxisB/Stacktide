// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${KEY}` is the reference syntax under test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  importProject,
  upsertUser,
  variables,
  variableVersions,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { count, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let down: ReturnType<typeof createMockGitlab>;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol" | "erin", { id: string; cookie: string }>;
const ids = {} as Record<"o1" | "o2" | "p1" | "plain" | "dev" | "conn" | "conn2" | "dead", string>;
let gitlabProject: { id: number };

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
    loopbackConnections: true,
  });
let app: ReturnType<typeof makeApp>;

type Who = keyof typeof people;
/** Every answer, searched for secrets at the end. */
const seen: { path: string; text: string; reveal: boolean }[] = [];
async function call(
  who: Who | null,
  method: string,
  path: string,
  body?: unknown,
  application = app,
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await application.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  seen.push({ path, text, reveal: method === "GET" && /\/value(\?|$)/.test(path) });
  return {
    status: res.status,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const base = {
  organization: (org = ids.o1) => `/organizations/${org}/variables`,
  project: (p = ids.p1, org = ids.o1) => `/organizations/${org}/projects/${p}/variables`,
  environment: (e = ids.dev, p = ids.p1, org = ids.o1) =>
    `/organizations/${org}/projects/${p}/environments/${e}/variables`,
};
const LEVELS = ["organization", "project", "environment"] as const;

/** A value that must never show up anywhere but a reveal. */
const markers: string[] = [];
let n = 0;
const sekrit = (label: string) => {
  const marker = `SEKRIT-${label}-${++n}-${Bun.randomUUIDv7()}`;
  markers.push(marker);
  return marker;
};

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  down = createMockGitlab({ scopes: ["api"] });
  ids.o1 = (await createOrganization(t.db, { slug: "one", name: "one" })).id;
  ids.o2 = (await createOrganization(t.db, { slug: "two", name: "two" })).id;
  gitlabProject = mock.addProject({ path: "fx/vars", files: {} });
  ids.p1 = (
    await importProject(t.db, {
      organizationId: ids.o1,
      gitlabProjectId: gitlabProject.id,
      name: "fx/vars",
      defaultBranch: "main",
      types: [],
    })
  ).project.id;
  ids.plain = (await createProject(t.db, { organizationId: ids.o1, name: "by-hand" })).id;
  ids.dev = (
    await createEnvironment(t.db, {
      organizationId: ids.o1,
      projectId: ids.p1,
      name: "dev",
      slug: "dev",
    })
  ).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob", "carol", "erin"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [ids.o1]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(902, {
    orgRoles: { [ids.o1]: "member" },
    projectRoles: { [ids.p1]: "maintainer" },
  }); // bob
  roleTable.set(903, { orgRoles: {}, projectRoles: { [ids.p1]: "reporter" } }); // carol
  roleTable.set(904, { orgRoles: { [ids.o2]: "admin" }, projectRoles: {} }); // erin
  app = makeApp(keys);
  const connect = async (org: string, name: string, server: typeof mock, who: Who = "alice") => {
    const res = await call(who, "POST", `/organizations/${org}/connections`, {
      type: "gitlab",
      name,
      baseUrl: server.url,
      token: server.token,
    });
    expect(res.status).toBe(201);
    return res.json.id as string;
  };
  ids.conn = await connect(ids.o1, "live", mock);
  ids.dead = await connect(ids.o1, "dead", down);
  down.stop();
  ids.conn2 = await connect(ids.o2, "other", mock, "erin");
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

const run = (path: string, body: object, who: Who | null = "alice", application = app) =>
  call(who, "POST", `${path}/import`, body, application);
const apply = (path: string, body: object, who: Who | null = "alice") =>
  run(path, { dryRun: false, ...body }, who);
const brief = (res: { json: { changes: { change: string; key: string; kind: string }[] } }) =>
  res.json.changes.map((c) => `${c.change} ${c.key} ${c.kind}`);
const events = (action: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, action));
const total = async () => {
  const [vars] = await t.db.select({ n: count() }).from(variables);
  const [vers] = await t.db.select({ n: count() }).from(variableVersions);
  const [audit] = await t.db.select({ n: count() }).from(auditEvents);
  return { variables: vars?.n, versions: vers?.n, audit: audit?.n };
};
const find = async (path: string, key: string) => {
  const list = await call("alice", "GET", path);
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return list.json.items.find((v: any) => v.key === key);
};
const reveal = async (path: string, key: string) => {
  const v = await find(path, key);
  return (await call("alice", "GET", `${path}/${v.id}/value`)).json.value as string;
};

/** A level of its own for a test, so tests do not see each other's keys. */
let envN = 0;
const freshEnv = async () => {
  const slug = `t${++envN}`;
  const e = await createEnvironment(t.db, {
    organizationId: ids.o1,
    projectId: ids.p1,
    name: slug,
    slug,
  });
  return { path: base.environment(e.id), id: e.id, slug };
};

describe("a .env file", () => {
  test("is a dry run unless told otherwise: a report, no value, nothing stored", async () => {
    const { path } = await freshEnv();
    const a = sekrit("dry-a");
    const b = sekrit("dry-b");
    const content = `# comment\nA=${a}\nexport B="${b}"\nbad-key=1\nno equals\nC='open`;
    const before = await total();
    const res = await run(path, { source: "dotenv", content });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      source: "dotenv",
      dryRun: true,
      changes: [
        { change: "create", key: "A", kind: "secret", applied: false },
        { change: "create", key: "B", kind: "secret", applied: false },
      ],
      skipped: [
        { reason: "bad_key", line: 4 },
        { reason: "syntax", line: 5 },
        { reason: "unclosed_quote", line: 6 },
      ],
    });
    expect(res.text).not.toContain(a);
    expect(await total()).toEqual({ ...before, audit: (before.audit ?? 0) + 1 });
    // a dry run is on record too: it opens the level's secrets to compare
    const rows = (await events("variable.import")).filter((e) => e.metadata?.dryRun === true);
    expect(rows.at(-1)).toMatchObject({
      metadata: { source: "dotenv", plannedCount: 2, skippedCount: 3 },
    });
    expect(await run(path, { source: "dotenv", content, dryRun: true })).toMatchObject({
      status: 200,
    });
  });

  test("with dryRun false it makes the variables: secret unless asked, each audited, none readable", async () => {
    const { path, id } = await freshEnv();
    const a = sekrit("apply-a");
    const open = "not-a-secret";
    const res = await apply(path, { source: "dotenv", content: `A=${a}\nB=${a}-2\nEMPTY=` });
    expect(res.status).toBe(200);
    expect(brief(res)).toEqual(["create A secret", "create B secret", "create EMPTY secret"]);
    expect(res.json.changes.every((c: { applied: boolean }) => c.applied)).toBe(true);
    expect(res.text).not.toContain(a);

    const plain = await apply(path, { source: "dotenv", kind: "plain", content: `P=${open}` });
    expect(plain.json.changes).toEqual([
      { change: "create", key: "P", kind: "plain", applied: true },
    ]);
    expect((await find(path, "P")).value).toBe(open);
    expect((await find(path, "A")).value).toBeNull();

    expect(await reveal(path, "A")).toBe(a);
    expect(await reveal(path, "EMPTY")).toBe("");
    // one row per change and one for the import, with where and what, never a value
    const created = (await events("variable.create")).filter(
      (e) => e.metadata?.environmentId === id,
    );
    expect(created.map((e) => e.metadata?.key).sort()).toEqual(["A", "B", "EMPTY", "P"]);
    expect(created.find((e) => e.metadata?.key === "A")?.metadata).toMatchObject({
      level: "environment",
      source: "dotenv",
      version: 1,
      kind: "secret",
    });
    const summary = (await events("variable.import")).filter(
      (e) => e.metadata?.environmentId === id,
    );
    expect(summary.map((e) => e.metadata?.createdCount)).toEqual([3, 1]);
    // the version says where it came from
    const v = await find(path, "A");
    const history = await call("alice", "GET", `${path}/${v.id}/versions`);
    expect(history.json.items[0].reason).toBe("imported from dotenv");
  });

  test("again, it changes nothing: every key is unchanged, no new version, no per-change row", async () => {
    const { path } = await freshEnv();
    const content = `A=${sekrit("idem")}\nB=2`;
    await apply(path, { source: "dotenv", content });
    const before = await total();
    const again = await apply(path, { source: "dotenv", content });
    expect(brief(again)).toEqual(["unchanged A secret", "unchanged B secret"]);
    expect(again.json.changes.some((c: { applied: boolean }) => c.applied)).toBe(false);
    expect(await total()).toEqual({ ...before, audit: (before.audit ?? 0) + 1 });
  });

  test("a different value is a conflict, reported and kept; overwrite makes it a new version", async () => {
    const { path, id: envId } = await freshEnv();
    const old = sekrit("old");
    const next = sekrit("next");
    await apply(path, { source: "dotenv", content: `A=${old}\nKEEP=1\nSAME=s` });
    const first = await apply(path, { source: "dotenv", content: `A=${next}\nSAME=s\nNEW=n` });
    expect(brief(first)).toEqual([
      "conflict A secret",
      "create NEW secret",
      "unchanged SAME secret",
    ]);
    expect(await reveal(path, "A")).toBe(old);
    const rows = async () =>
      (await events("variable.import")).filter((e) => e.metadata?.environmentId === envId);
    expect((await rows()).at(-1)?.metadata).toMatchObject({
      createdCount: 1,
      updatedCount: 0,
      conflictCount: 1,
    });

    const over = await apply(path, {
      source: "dotenv",
      overwrite: true,
      content: `A=${next}\nSAME=s`,
    });
    expect(brief(over)).toEqual(["update A secret", "unchanged SAME secret"]);
    expect(over.json.changes[0].applied).toBe(true);
    expect(await reveal(path, "A")).toBe(next);
    expect((await rows()).at(-1)?.metadata).toMatchObject({
      createdCount: 0,
      updatedCount: 1,
      conflictCount: 0,
    });
    const a = await find(path, "A");
    expect(a.version).toBe(2);
    const history = await call("alice", "GET", `${path}/${a.id}/versions`);
    expect(history.json.items.map((i: { reason: string }) => i.reason)).toEqual([
      "imported from dotenv",
      "imported from dotenv",
    ]);
    const updated = (await events("variable.update")).filter((e) => e.resourceId === a.id);
    expect(updated[0]?.metadata).toMatchObject({ source: "dotenv", version: 2, kind: "secret" });
    // a key that is not in the file is never touched, and an import never deletes
    expect(await reveal(path, "KEEP")).toBe("1");
  });

  test("a key held as another kind is never changed, overwrite or not", async () => {
    const { path, id: envId } = await freshEnv();
    await apply(path, { source: "dotenv", kind: "plain", content: "A=plain" });
    for (const overwrite of [false, true]) {
      const res = await apply(path, { source: "dotenv", overwrite, content: "A=other" });
      expect(brief(res)).toEqual(["kind_mismatch A secret"]);
      expect(res.json.changes[0].applied).toBe(false);
    }
    expect((await find(path, "A")).value).toBe("plain");
    const rows = (await events("variable.import")).filter(
      (e) => e.metadata?.environmentId === envId,
    );
    expect(rows.at(-1)?.metadata).toMatchObject({ conflictCount: 1, createdCount: 0 });
  });

  test("lands at the level it was sent to and sees only that level's keys", async () => {
    const { path } = await freshEnv();
    await apply(base.project(), { source: "dotenv", content: "LEVELED=project" });
    const here = await apply(path, { source: "dotenv", content: "LEVELED=environment" });
    expect(brief(here)).toEqual(["create LEVELED secret"]);
    const org = await apply(base.organization(), { source: "dotenv", content: "LEVELED=org" });
    expect(brief(org)).toEqual(["create LEVELED secret"]);
  });

  test("lines it cannot use are named by line, and what they hold is not repeated", async () => {
    const { path } = await freshEnv();
    const s1 = sekrit("skip-1");
    const s2 = sekrit("skip-2");
    const long = "x".repeat(65_537);
    const res = await run(path, {
      source: "dotenv",
      content: [
        `${s1} no equals`,
        `bad-key=${s2}`,
        `TOO_LONG=${long}`,
        "DUP=1",
        "DUP=2",
        "OK=1",
      ].join("\n"),
    });
    expect(res.json.skipped).toEqual([
      { reason: "syntax", line: 1 },
      { reason: "bad_key", line: 2 },
      { reason: "duplicate", line: 4, key: "DUP" },
      { reason: "bad_value", key: "TOO_LONG" },
    ]);
    expect(brief(res)).toEqual(["create DUP secret", "create OK secret"]);
    expect(res.text).not.toContain(s1);
    expect(res.text).not.toContain(s2);
  });

  test("refuses what it should: unknown fields, other sources and kinds, no content, too many keys", async () => {
    const { path } = await freshEnv();
    const before = await total();
    const bodies: object[] = [
      {},
      { source: "yaml", content: "A=1" },
      { source: "dotenv" },
      { source: "dotenv", content: "" },
      { source: "dotenv", content: "A=1", kind: "file" },
      { source: "dotenv", content: "A=1", extra: true },
      { source: "dotenv", content: "A=1", dryRun: "no" },
      { source: "dotenv", content: "A=1", overwrite: 1 },
      { source: "dotenv", content: "x".repeat(1_048_577) },
      { source: "gitlab" },
      { source: "gitlab", connectionId: "nope" },
      { source: "gitlab", connectionId: ids.conn, content: "A=1" },
    ];
    for (const body of bodies) {
      const res = await apply(path, body);
      expect([JSON.stringify(body).slice(0, 60), res.status]).toEqual([
        JSON.stringify(body).slice(0, 60),
        422,
      ]);
    }
    const many = Array.from({ length: 1001 }, (_, i) => `K${i}=1`).join("\n");
    const big = await apply(path, { source: "dotenv", content: many });
    expect([big.status, big.json.code]).toEqual([422, "too_many_entries"]);
    const ok = await run(path, {
      source: "dotenv",
      content: Array.from({ length: 1000 }, (_, i) => `K${i}=1`).join("\n"),
    });
    expect([ok.status, ok.json.changes.length]).toEqual([200, 1000]);
    // lines that are no variables are answered one by one, so they are limited as well
    const junk = (n: number) => Array.from({ length: n }, () => "junk").join("\n");
    const noisy = await run(path, { source: "dotenv", content: junk(1001) });
    expect([noisy.status, noisy.json.code]).toEqual([422, "too_many_entries"]);
    const loud = await run(path, { source: "dotenv", content: junk(1000) });
    expect([loud.status, loud.json.skipped.length]).toEqual([200, 1000]);
    expect((await total()).variables).toBe(before.variables);
  });
});

describe("JSON", () => {
  test("an object or a list, numbers and booleans as text", async () => {
    const { path } = await freshEnv();
    const object = await apply(path, {
      source: "json",
      kind: "plain",
      content: JSON.stringify({ A: "1", PORT: 8080, DEBUG: false }),
    });
    expect(brief(object)).toEqual(["create A plain", "create DEBUG plain", "create PORT plain"]);
    expect((await find(path, "PORT")).value).toBe("8080");
    expect((await find(path, "DEBUG")).value).toBe("false");
    const list = await run(path, {
      source: "json",
      content: JSON.stringify([
        { key: "L", value: "1", variable_type: "env_var", masked: true },
        { key: "A", value: "1" },
      ]),
    });
    expect(brief(list)).toEqual(["kind_mismatch A secret", "create L secret"]);
  });

  test("a document that is not JSON is one skipped issue and echoes nothing", async () => {
    const { path } = await freshEnv();
    const s = sekrit("json-bad");
    const before = await total();
    const res = await apply(path, { source: "json", content: `{"A": "${s}"` });
    expect(res.json).toMatchObject({ changes: [], skipped: [{ reason: "syntax" }] });
    expect(res.text).not.toContain(s);
    const odd = await run(path, {
      source: "json",
      content: JSON.stringify({ A: null, "bad-key": "x", B: { n: 1 }, OK: "1" }),
    });
    expect(odd.json.skipped).toEqual([
      { reason: "bad_value", key: "A" },
      { reason: "bad_key" },
      { reason: "bad_value", key: "B" },
    ]);
    expect((await total()).variables).toBe(before.variables);
  });
});

describe("who may, and what is needed", () => {
  const body = { source: "dotenv", content: "WHO=1" };
  test("the right to import at the level, a dry run included; nobody else sees the level", async () => {
    const { path } = await freshEnv();
    for (const extra of [{}, { dryRun: false }]) {
      expect((await run(path, { ...body, ...extra }, "carol")).status).toBe(403);
      expect((await run(base.project(), { ...body, ...extra }, "carol")).status).toBe(403);
      expect((await run(path, { ...body, ...extra }, "erin")).status).toBe(404);
      expect((await run(path, { ...body, ...extra }, null)).status).toBe(401);
      expect((await run(base.organization(), { ...body, ...extra }, "bob")).status).toBe(403);
    }
    expect((await run(path, body, "bob")).status).toBe(200);
    expect((await run(base.project(), body, "bob")).status).toBe(200);
    expect((await run(base.organization(), body, "alice")).status).toBe(200);
    const nowhere = base.environment(crypto.randomUUID());
    expect((await run(nowhere, body)).status).toBe(404);
    expect((await run(base.project(crypto.randomUUID()), body)).status).toBe(404);
  });

  test("without master keys it is a 503, a dry run too, and nothing is written", async () => {
    const { path } = await freshEnv();
    const bare = makeApp(undefined);
    const before = await total();
    for (const extra of [{}, { dryRun: false }]) {
      const res = await run(path, { ...body, ...extra }, "alice", bare);
      expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    }
    expect(await total()).toEqual(before);
  });
});

describe("from GitLab", () => {
  const gl = () =>
    createGitlab({ baseUrl: mock.url, auth: { type: "private-token", token: mock.token } });
  const seed = async (key: string, value: string, over: object = {}) =>
    gl().variables.create({ project: gitlabProject.id }, key, { value, ...over });
  const from = (path: string, extra: object = {}, connectionId = ids.conn) =>
    apply(path, { source: "gitlab", connectionId, ...extra });
  const secrets: Record<string, string> = {};

  beforeAll(async () => {
    for (const key of ["G_PLAIN", "G_MASKED", "G_FILE", "G_HIDDEN", "G_STAGING", "G_DEV", "1BAD"]) {
      secrets[key] = sekrit(key.toLowerCase());
    }
    await seed("G_PLAIN", secrets.G_PLAIN ?? "", { description: "from gitlab" });
    await seed("G_MASKED", secrets.G_MASKED ?? "", { masked: true, protected: true });
    await seed("G_FILE", secrets.G_FILE ?? "", { type: "file" });
    await seed("G_HIDDEN", secrets.G_HIDDEN ?? "", { hidden: true, masked: true });
    await seed("G_STAGING", secrets.G_STAGING ?? "", { scope: "staging" });
    await seed("G_DEV", secrets.G_DEV ?? "", { scope: "dev" });
    await seed("1BAD", secrets["1BAD"] ?? "");
  });

  test("a dry run says what would happen, notes GitLab's flags, names what it skips", async () => {
    const before = await total();
    const res = await run(base.project(), { source: "gitlab", connectionId: ids.conn });
    expect(res.status).toBe(200);
    expect(res.json.dryRun).toBe(true);
    expect(res.json.changes).toEqual([
      {
        change: "create",
        key: "G_FILE",
        kind: "file",
        applied: false,
        masked: false,
        protected: false,
      },
      {
        change: "create",
        key: "G_MASKED",
        kind: "secret",
        applied: false,
        masked: true,
        protected: true,
      },
      {
        change: "create",
        key: "G_PLAIN",
        kind: "secret",
        applied: false,
        masked: false,
        protected: false,
      },
    ]);
    expect(res.json.skipped).toEqual(
      expect.arrayContaining([
        { reason: "hidden", key: "G_HIDDEN" },
        { reason: "other_scope", key: "G_STAGING" },
        { reason: "other_scope", key: "G_DEV" },
        { reason: "bad_key", key: "1BAD" },
      ]),
    );
    expect(res.json.skipped).toHaveLength(4);
    expect(await total()).toEqual({ ...before, audit: (before.audit ?? 0) + 1 });
  });

  test("applied it brings the values, with descriptions, once: the second time nothing changes", async () => {
    const path = base.project();
    const res = await from(path);
    expect(brief(res)).toEqual([
      "create G_FILE file",
      "create G_MASKED secret",
      "create G_PLAIN secret",
    ]);
    for (const key of ["G_FILE", "G_MASKED", "G_PLAIN"]) {
      expect(await reveal(path, key)).toBe(secrets[key] ?? "");
    }
    expect((await find(path, "G_PLAIN")).description).toBe("from gitlab");
    expect(res.text).not.toContain(secrets.G_PLAIN ?? "-");
    const before = await total();
    const again = await from(path);
    expect(brief(again)).toEqual([
      "unchanged G_FILE file",
      "unchanged G_MASKED secret",
      "unchanged G_PLAIN secret",
    ]);
    expect(await total()).toEqual({ ...before, audit: (before.audit ?? 0) + 1 });
    const row = (await events("variable.import")).at(-1);
    expect(row?.metadata).toMatchObject({
      source: "gitlab",
      connectionId: ids.conn,
      skippedCount: 4,
    });
    const made = (await events("variable.create")).find((e) => e.metadata?.key === "G_MASKED");
    expect(made?.metadata).toMatchObject({ source: "gitlab", level: "project" });
  });

  test("a value changed in GitLab is a conflict until overwrite", async () => {
    const path = base.project();
    const next = sekrit("gl-next");
    await gl().variables.update(
      { project: gitlabProject.id },
      { key: "G_MASKED" },
      { value: next },
    );
    const first = await from(path);
    expect(brief(first)).toContain("conflict G_MASKED secret");
    expect(await reveal(path, "G_MASKED")).toBe(secrets.G_MASKED ?? "");
    const over = await from(path, { overwrite: true });
    expect(brief(over)).toContain("update G_MASKED secret");
    expect(await reveal(path, "G_MASKED")).toBe(next);
  });

  test("an environment gets the variables scoped to its name", async () => {
    const path = base.environment();
    const res = await from(path);
    expect(brief(res)).toEqual(["create G_DEV secret"]);
    expect(await reveal(path, "G_DEV")).toBe(secrets.G_DEV ?? "");
    expect(res.json.skipped.map((s: { reason: string }) => s.reason)).toContain("other_scope");
  });

  test("what cannot work is told: an organization, an unlinked project, a connection that is not there", async () => {
    const org = await from(base.organization());
    expect([org.status, org.json.code]).toEqual([422, "unsupported_source"]);
    const unlinked = await from(base.project(ids.plain));
    expect([unlinked.status, unlinked.json.code]).toEqual([422, "not_linked"]);
    const nobody = await from(base.project(), {}, crypto.randomUUID());
    expect([nobody.status, nobody.json.code]).toEqual([404, "not_found"]);
    const foreign = await from(base.project(), {}, ids.conn2);
    expect([foreign.status, foreign.json.code]).toEqual([404, "not_found"]);
  });

  test("a GitLab that does not answer is a 502 that names no token, and nothing is written", async () => {
    const before = await total();
    const res = await from(base.project(), {}, ids.dead);
    expect([res.status, res.json.code]).toEqual([502, "gitlab_failed"]);
    expect(res.text).not.toContain(down.token);
    expect(await total()).toEqual(before);
  });

  test("it uses the organization's credential, so it needs the right to read connections too", async () => {
    const body = { source: "gitlab", connectionId: ids.conn };
    // a project maintainer may import a file into the project, but not through a connection
    expect((await run(base.project(), { source: "dotenv", content: "M=1" }, "bob")).status).toBe(
      200,
    );
    for (const who of ["bob", "carol"] as const) {
      const res = await run(base.project(), body, who);
      expect([who, res.status, res.json.code]).toEqual([who, 403, "forbidden"]);
    }
    expect((await run(base.project(), body, "alice")).status).toBe(200);
    const bare = makeApp(undefined);
    const res = await run(base.project(), body, "alice", bare);
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
  });

  test("a description the variables would refuse skips that variable, not the import", async () => {
    const { path, slug } = await freshEnv();
    await seed("D_OK", "1", { scope: slug, description: "fine" });
    await seed("D_LONG", "1", { scope: slug, description: "d".repeat(1001) });
    const res = await run(path, { source: "gitlab", connectionId: ids.conn });
    expect(brief(res)).toEqual(["create D_OK secret"]);
    expect(res.json.skipped).toContainEqual({ reason: "bad_value", key: "D_LONG" });
  });

  test("the limit counts what would be imported, not the variables of other scopes", async () => {
    const big = mock.addProject({ path: "fx/big", files: {} });
    const bigId = (
      await importProject(t.db, {
        organizationId: ids.o1,
        gitlabProjectId: big.id,
        name: "fx/big",
        defaultBranch: "main",
        types: [],
      })
    ).project.id;
    const staging = await createEnvironment(t.db, {
      organizationId: ids.o1,
      projectId: bigId,
      name: "staging",
      slug: "staging",
    });
    const specs = [
      ...Array.from({ length: 1001 }, (_, i) => ({ key: `ALL_${i}`, scope: "*" })),
      ...Array.from({ length: 100 }, (_, i) => ({ key: `STG_${i}`, scope: "staging" })),
    ];
    // a few at a time: the mock does not take a thousand connections at once
    for (let at = 0; at < specs.length; at += 20) {
      await Promise.all(
        specs
          .slice(at, at + 20)
          .map((v) =>
            gl().variables.create({ project: big.id }, v.key, { value: "1", scope: v.scope }),
          ),
      );
    }
    const body = { source: "gitlab", connectionId: ids.conn };
    const project = await run(base.project(bigId), body);
    expect([project.status, project.json.code]).toEqual([422, "too_many_entries"]);
    const env = await run(base.environment(staging.id, bigId), body);
    expect([env.status, env.json.changes.length]).toEqual([200, 100]);
  }, 60_000);
});

describe("secrets stay secret", () => {
  test("no answer, log line or audit row of this suite holds a value, and nothing is stored in clear", async () => {
    expect(markers.length).toBeGreaterThan(8);
    expect(seen.length).toBeGreaterThan(60);
    for (const marker of markers) {
      for (const s of seen.filter((x) => !x.reveal))
        expect([s.path, s.text.includes(marker)]).toEqual([s.path, false]);
      for (const line of lines) expect(line.includes(marker)).toBe(false);
    }
    const audit = JSON.stringify(await t.db.select().from(auditEvents));
    const stored = (await t.db.select().from(variableVersions)).map((r) =>
      Buffer.from(r.valueEnc).toString("latin1"),
    );
    for (const marker of markers) {
      expect(audit.includes(marker)).toBe(false);
      expect(stored.some((s) => s.includes(marker))).toBe(false);
    }
    for (const level of LEVELS) expect(base[level]()).toContain("/variables");
  });
});
