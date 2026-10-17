import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createApiToken,
  createEnvironment,
  createOrganization,
  createProject,
  createSession,
  upsertUser,
  variables,
  variableVersions,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { count, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { devPrincipal } from "./principal";
import { hashToken, newApiToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
const lines: string[] = [];
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<"alice" | "bob" | "carol" | "erin", { id: string; cookie: string }>;
const ids = {} as Record<"o1" | "o2" | "p1" | "dev", string>;
const tokens = {} as Record<"orgOnly" | "everything", string>;

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

type Who = keyof typeof people;
/** Every answer, searched for secrets at the end. */
const seen: { path: string; text: string; reveal: boolean }[] = [];
async function call(
  who: Who | null,
  method: string,
  path: string,
  body?: unknown,
  application = app,
  bearer?: string,
) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
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
  ids.o1 = (await createOrganization(t.db, { slug: "one", name: "one" })).id;
  ids.o2 = (await createOrganization(t.db, { slug: "two", name: "two" })).id;
  ids.p1 = (await createProject(t.db, { organizationId: ids.o1, name: "p1" })).id;
  ids.dev = (
    await createEnvironment(t.db, {
      organizationId: ids.o1,
      projectId: ids.p1,
      name: "dev",
      slug: "dev",
    })
  ).id;
  let gitlabId = 900;
  const users = {} as Record<Who, string>;
  for (const name of ["alice", "bob", "carol", "erin"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
    users[name] = user.id;
  }
  roleTable.set(901, { orgRoles: { [ids.o1]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(902, {
    orgRoles: { [ids.o1]: "member" },
    projectRoles: { [ids.p1]: "maintainer" },
  }); // bob
  roleTable.set(903, { orgRoles: {}, projectRoles: { [ids.p1]: "reporter" } }); // carol
  roleTable.set(904, { orgRoles: { [ids.o2]: "admin" }, projectRoles: {} }); // erin
  // alice's own tokens: one that may read the organization's variables only, one that may read all
  for (const [name, scopes] of [
    ["orgOnly", ["variable.org.read"]],
    ["everything", ["variable.org.read", "variable.read"]],
  ] as const) {
    const fresh = newApiToken();
    await createApiToken(t.db, {
      userId: users.alice,
      name,
      prefix: fresh.prefix,
      tokenHash: fresh.tokenHash,
      scopes,
      ttlMs: 60_000,
    });
    tokens[name] = fresh.token;
  }
  app = makeApp(keys);
});
afterAll(async () => {
  await t.drop();
});

const events = (action: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.action, action));
const total = async () => {
  const [vars] = await t.db.select({ n: count() }).from(variables);
  const [vers] = await t.db.select({ n: count() }).from(variableVersions);
  const [audit] = await t.db.select({ n: count() }).from(auditEvents);
  return { variables: vars?.n, versions: vers?.n, audit: audit?.n };
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
  return { path: base.environment(e.id), id: e.id };
};
const make = async (
  path: string,
  key: string,
  kind: "plain" | "secret" | "file",
  value: string,
  who: Who = "alice",
) => {
  const res = await call(who, "POST", path, { key, kind, value });
  expect(res.status).toBe(201);
  return res.json.id as string;
};
const list = async (path: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  ((await call("alice", "GET", `${path}?limit=100`)).json.items as any[]).map((v) => v.key).sort();
const reveal = async (path: string, id: string) =>
  (await call("alice", "GET", `${path}/${id}/value`)).json.value as string;

type Op = {
  op: "set" | "rename" | "delete";
  key: string;
  to?: string;
  kind?: string;
  value?: string;
};
const bulk = (path: string, ops: Op[], extra: object = {}, who: Who | null = "alice", app_ = app) =>
  call(who, "POST", `${path}/bulk`, { ops, ...extra }, app_);
const applyBulk = (path: string, ops: Op[], who: Who | null = "alice") =>
  bulk(path, ops, { dryRun: false }, who);
const set = (key: string, value: string, kind?: string): Op => ({
  op: "set",
  key,
  value,
  ...(kind && { kind }),
});
const brief = (res: {
  json: { changes: { change: string; key: string; to?: string; kind: string | null }[] };
}) => res.json.changes.map((c) => `${c.change} ${c.key}${c.to ? `>${c.to}` : ""} ${c.kind}`);

describe("bulk edit", () => {
  test("is a dry run unless told otherwise: a report, no value, nothing changed but one audit row", async () => {
    const { path, id } = await freshEnv();
    const kept = sekrit("dry-keep");
    await make(path, "B_KEEP", "secret", kept);
    await make(path, "B_OLD", "secret", sekrit("dry-old"));
    await make(path, "B_GONE", "plain", "gone");
    await make(path, "B_CHG", "plain", "old");
    const before = await total();
    const next = sekrit("dry-next");
    const res = await bulk(path, [
      set("B_NEW", next, "plain"),
      set("B_CHG", "new"),
      set("B_KEEP", kept),
      { op: "rename", key: "B_OLD", to: "B_FRESH" },
      { op: "delete", key: "B_GONE" },
    ]);
    expect(res.status).toBe(200);
    expect(res.json.dryRun).toBe(true);
    expect(brief(res)).toEqual([
      "update B_CHG plain",
      "delete B_GONE plain",
      "unchanged B_KEEP secret",
      "create B_NEW plain",
      "rename B_OLD>B_FRESH secret",
    ]);
    expect(res.json.changes.every((c: { applied: boolean }) => !c.applied)).toBe(true);
    expect(res.text).not.toContain(next);
    expect(await total()).toEqual({ ...before, audit: (before.audit ?? 0) + 1 });
    expect(await list(path)).toEqual(["B_CHG", "B_GONE", "B_KEEP", "B_OLD"]);
    const row = (await events("variable.bulk")).find((e) => e.metadata?.environmentId === id);
    expect(row?.metadata).toMatchObject({
      level: "environment",
      dryRun: true,
      plannedCount: 5,
      createdCount: 0,
      updatedCount: 0,
      renamedCount: 0,
      deletedCount: 0,
      conflictCount: 0,
      missingCount: 0,
    });
  });

  test("applied it does every step, once, audited one row per change, and keeps the history", async () => {
    const { path, id } = await freshEnv();
    const oldValue = sekrit("old");
    const oldId = await make(path, "A_OLD", "secret", oldValue);
    const changeId = await make(path, "A_CHANGE", "secret", sekrit("before"));
    await make(path, "A_GONE", "plain", "gone");
    const after = sekrit("after");
    const fresh = sekrit("fresh");
    const ops: Op[] = [
      set("A_NEW", fresh),
      set("A_CHANGE", after),
      { op: "rename", key: "A_OLD", to: "A_RENAMED" },
      { op: "delete", key: "A_GONE" },
    ];
    const before = await total();
    const res = await applyBulk(path, ops);
    expect(res.status).toBe(200);
    expect(res.json.dryRun).toBe(false);
    expect(brief(res)).toEqual([
      "update A_CHANGE secret",
      "delete A_GONE plain",
      "create A_NEW secret",
      "rename A_OLD>A_RENAMED secret",
    ]);
    expect(res.json.changes.every((c: { applied: boolean }) => c.applied)).toBe(true);
    expect(res.text).not.toContain(after);
    const now = await total();

    expect(await list(path)).toEqual(["A_CHANGE", "A_NEW", "A_RENAMED"]);
    expect(await reveal(path, oldId)).toBe(oldValue); // the same variable, its value kept
    expect(await reveal(path, changeId)).toBe(after);
    const versions = (await call("alice", "GET", `${path}/${changeId}/versions`)).json.items;
    expect(
      versions.map((v: { version: number; reason: string | null }) => [v.version, v.reason]),
    ).toEqual([
      [2, "bulk edit"],
      [1, null],
    ]);
    expect([now.variables, now.versions, now.audit]).toEqual([
      (before.variables ?? 0) + 1,
      (before.versions ?? 0) + 2, // a new variable and a new version
      (before.audit ?? 0) + 5, // four changes and the summary
    ]);

    const rows = async (action: string) =>
      (await events(action)).filter((e) => e.metadata?.environmentId === id);
    expect((await rows("variable.create")).map((e) => e.metadata)).toContainEqual(
      expect.objectContaining({ key: "A_NEW", source: "bulk", version: 1 }),
    );
    const updates = (await rows("variable.update")).map((e) => e.metadata);
    expect(updates).toContainEqual(
      expect.objectContaining({ key: "A_CHANGE", source: "bulk", fields: ["value"], version: 2 }),
    );
    expect(updates).toContainEqual(
      expect.objectContaining({ key: "A_RENAMED", previousKey: "A_OLD", fields: ["key"] }),
    );
    expect((await rows("variable.delete")).map((e) => e.metadata?.key)).toEqual(["A_GONE"]);
    expect((await rows("variable.bulk")).map((e) => e.metadata)).toEqual([
      expect.objectContaining({
        dryRun: false,
        plannedCount: 4,
        createdCount: 1,
        updatedCount: 1,
        renamedCount: 1,
        deletedCount: 1,
        conflictCount: 0,
        missingCount: 0,
      }),
    ]);

    const settled = await total();
    const again = await applyBulk(path, ops);
    expect(brief(again)).toEqual([
      "unchanged A_CHANGE secret",
      "missing A_GONE null",
      "unchanged A_NEW secret",
      "missing A_OLD null",
    ]);
    expect(again.json.changes.some((c: { applied: boolean }) => c.applied)).toBe(false);
    expect(await total()).toEqual({ ...settled, audit: (settled.audit ?? 0) + 1 });
  });

  test("a set without a kind keeps the kind of the key, a new one is secret, another kind is never applied", async () => {
    const { path } = await freshEnv();
    const plain = await make(path, "K_PLAIN", "plain", "p1");
    const secret = await make(path, "K_SECRET", "secret", "s1");
    const res = await applyBulk(path, [
      set("K_PLAIN", "p2"),
      set("K_SECRET", "s2", "plain"),
      set("K_NEW", "n"),
      set("K_FILE", "f", "file"),
    ]);
    expect(brief(res)).toEqual([
      "create K_FILE file",
      "create K_NEW secret",
      "update K_PLAIN plain",
      "kind_mismatch K_SECRET plain",
    ]);
    const stored = (await call("alice", "GET", `${path}/${plain}`)).json;
    expect([stored.kind, stored.value, stored.version]).toEqual(["plain", "p2", 2]);
    expect(await reveal(path, secret)).toBe("s1");
    expect((await call("alice", "GET", `${path}/${secret}`)).json.kind).toBe("secret");
    expect((await events("variable.bulk")).at(-1)?.metadata).toMatchObject({
      plannedCount: 4,
      createdCount: 2,
      updatedCount: 1,
      conflictCount: 1,
    });
  });

  test("a rename onto a held key, and a rename or delete of a key that is not there, change nothing", async () => {
    const { path } = await freshEnv();
    const a = await make(path, "R_A", "plain", "a");
    await make(path, "R_B", "plain", "b");
    const before = await total();
    const res = await applyBulk(path, [
      { op: "rename", key: "R_A", to: "R_B" },
      { op: "rename", key: "R_NOPE", to: "R_C" },
      { op: "delete", key: "R_MISSING" },
    ]);
    expect(brief(res)).toEqual([
      "conflict R_A>R_B plain",
      "missing R_MISSING null",
      "missing R_NOPE null",
    ]);
    expect(await list(path)).toEqual(["R_A", "R_B"]);
    expect((await call("alice", "GET", `${path}/${a}`)).json.key).toBe("R_A");
    expect(await total()).toEqual({ ...before, audit: (before.audit ?? 0) + 1 });
    const row = (await events("variable.bulk")).at(-1);
    expect(row?.metadata).toMatchObject({ conflictCount: 1, missingCount: 2, deletedCount: 0 });
  });

  test("a renamed key frees the old one and can be renamed back; a deleted key can be made again", async () => {
    const { path } = await freshEnv();
    const id = await make(path, "S_ONE", "plain", "1");
    await make(path, "S_TWO", "plain", "2");
    await applyBulk(path, [{ op: "rename", key: "S_ONE", to: "S_THREE" }]);
    expect(
      (await call("alice", "POST", path, { key: "S_ONE", kind: "plain", value: "x" })).status,
    ).toBe(201);
    await applyBulk(path, [{ op: "delete", key: "S_TWO" }]);
    expect(await make(path, "S_TWO", "plain", "again")).not.toBe(id);
    expect(await list(path)).toEqual(["S_ONE", "S_THREE", "S_TWO"]);
  });

  test("works on its own level: the same keys one level up are untouched", async () => {
    const { path } = await freshEnv();
    const up = await make(base.project(), "L_SAME", "plain", "project");
    const here = await make(path, "L_SAME", "plain", "environment");
    await applyBulk(path, [{ op: "delete", key: "L_SAME" }]);
    expect((await call("alice", "GET", `${path}/${here}`)).status).toBe(404);
    expect((await call("alice", "GET", `${base.project()}/${up}`)).json.value).toBe("project");
  });

  test("steps that name a key twice, or are too many, too big or malformed, are refused whole", async () => {
    const { path } = await freshEnv();
    await make(path, "V_A", "plain", "a");
    const before = await total();
    const same: Op[][] = [
      [set("V_A", "1"), { op: "delete", key: "V_A" }],
      [set("V_A", "1"), set("V_A", "2")],
      [{ op: "rename", key: "V_A", to: "V_B" }, set("V_B", "1")],
      [
        { op: "rename", key: "V_A", to: "V_B" },
        { op: "rename", key: "V_B", to: "V_C" },
      ],
      [{ op: "rename", key: "V_A", to: "V_A" }],
    ];
    const bad: unknown[] = [
      [],
      Array.from({ length: 1001 }, (_, i) => ({ op: "delete", key: `V_${i}` })),
      Array.from({ length: 17 }, (_, i) => set(`V_BIG_${i}`, "x".repeat(65_536))),
      [{ op: "rename", key: "V_A", to: "not a key" }],
      [{ op: "delete", key: "1BAD" }],
      [{ op: "delete", key: "V_A", extra: true }],
      [{ op: "wipe", key: "V_A" }],
      [{ op: "set", key: "V_A", kind: "other", value: "x" }],
      [{ op: "set", key: "V_A" }],
      [{ op: "rename", key: "V_A" }],
      "delete everything",
    ];
    for (const ops of [...same, ...bad]) {
      for (const extra of [{}, { dryRun: false }]) {
        const res = await call("alice", "POST", `${path}/bulk`, { ops, ...extra });
        expect([JSON.stringify(ops).slice(0, 60), res.status]).toEqual([
          JSON.stringify(ops).slice(0, 60),
          422,
        ]);
      }
    }
    expect((await call("alice", "POST", `${path}/bulk`, { dryRun: false })).status).toBe(422);
    expect(
      (await call("alice", "POST", `${path}/bulk`, { ops: [set("V_A", "1")], more: 1 })).status,
    ).toBe(422);
    expect(await total()).toEqual(before);
    expect(await list(path)).toEqual(["V_A"]);
  });

  test("the largest request is fine, and 1000 steps are planned in one go", async () => {
    const { path } = await freshEnv();
    const ops = Array.from({ length: 1000 }, (_, i) =>
      set(`M_${String(i).padStart(4, "0")}`, `${i}`),
    );
    const res = await applyBulk(path, ops);
    expect([res.status, res.json.changes.length]).toEqual([200, 1000]);
    expect(await total().then((x) => x.variables)).toBeGreaterThanOrEqual(1000);
    // exactly 1 MiB of values is fine, one character more is not
    const exact = Array.from({ length: 16 }, (_, i) => set(`X_${i}`, "x".repeat(65_536)));
    expect((await bulk(path, exact)).status).toBe(200);
    expect((await bulk(path, [...exact, set("X_16", "x")])).status).toBe(422);
    const again = await applyBulk(path, ops);
    expect(again.json.changes.every((c: { change: string }) => c.change === "unchanged")).toBe(
      true,
    );
  }, 60_000);

  test("who may: the right to bulk edit at the level, a dry run included; nobody else sees the level", async () => {
    const { path } = await freshEnv();
    const ops = [set("W_KEY", "1")];
    for (const extra of [{}, { dryRun: false }]) {
      expect((await bulk(path, ops, extra, "carol")).status).toBe(403);
      expect((await bulk(base.project(), ops, extra, "carol")).status).toBe(403);
      expect((await bulk(path, ops, extra, "erin")).status).toBe(404);
      expect((await bulk(path, ops, extra, null)).status).toBe(401);
      expect((await bulk(base.organization(), ops, extra, "bob")).status).toBe(403);
    }
    expect((await bulk(path, ops, {}, "bob")).status).toBe(200);
    expect((await bulk(base.project(), ops, {}, "bob")).status).toBe(200);
    expect((await bulk(base.organization(), ops, {}, "alice")).status).toBe(200);
    expect((await bulk(base.environment(crypto.randomUUID()), ops)).status).toBe(404);
    expect((await bulk(base.project(crypto.randomUUID()), ops)).status).toBe(404);
    // a token is held to its scopes: reading variables is not bulk editing, and a token that cannot
    // read the environment is not told it is there
    const viaToken = await call(null, "POST", `${path}/bulk`, { ops }, app, tokens.everything);
    expect(viaToken.status).toBe(404);
  });

  test("without master keys it is a 503, a dry run too, and nothing is written", async () => {
    const { path } = await freshEnv();
    const bare = makeApp(undefined);
    const before = await total();
    for (const extra of [{}, { dryRun: false }]) {
      const res = await bulk(path, [set("N_KEY", "1")], extra, "alice", bare);
      expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
    }
    expect(await total()).toEqual(before);
  });
});

describe("search", () => {
  const needle = (label: string) => `needle-${sekrit(label)}`;
  const org2 = "SRCH_O2_ONLY";
  beforeAll(async () => {
    const env = base.environment();
    await make(base.organization(), "SRCH_ORG_URL", "plain", "https://org.example/needle");
    await make(base.organization(), "SRCH_ORG_SECRET", "secret", needle("org"));
    await make(base.project(), "SRCH_PROJ_PLAIN", "plain", "project needle");
    await make(base.project(), "SRCH_PROJ_SECRET", "secret", needle("project"));
    await make(env, "SRCH_ENV_PLAIN", "plain", "env needle");
    await make(env, "SRCH_ENV_FILE", "file", needle("file"));
    await make(base.organization(ids.o2), org2, "plain", "needle", "erin");
  });
  const find = (body: object, who: Who | null = "alice", bearer?: string, application = app) =>
    call(who, "POST", `/organizations/${ids.o1}/variable-search`, body, application, bearer);
  const names = (res: { json: { items: { key: string }[] } }) => res.json.items.map((v) => v.key);

  test("finds by part of the key, in any case, over all three levels, and says where each is", async () => {
    const res = await find({ key: "srch_" });
    expect(res.status).toBe(200);
    expect(names(res)).toEqual([
      "SRCH_ENV_FILE",
      "SRCH_ENV_PLAIN",
      "SRCH_ORG_SECRET",
      "SRCH_ORG_URL",
      "SRCH_PROJ_PLAIN",
      "SRCH_PROJ_SECRET",
    ]);
    expect(res.json.truncated).toBe(false);
    const level = (key: string) =>
      res.json.items.find((v: { key: string }) => v.key === key)?.level;
    expect([level("SRCH_ORG_URL"), level("SRCH_PROJ_PLAIN"), level("SRCH_ENV_PLAIN")]).toEqual([
      "organization",
      "project",
      "environment",
    ]);
    const env = res.json.items.find((v: { key: string }) => v.key === "SRCH_ENV_PLAIN");
    expect([env.organizationId, env.projectId, env.environmentId]).toEqual([
      ids.o1,
      ids.p1,
      ids.dev,
    ]);
    expect(names(await find({ key: "ProJ_Pl" }))).toEqual(["SRCH_PROJ_PLAIN"]);
    expect(names(await find({ key: "no-such-key-anywhere" }))).toEqual([]);
  });

  test("plain values come back, secrets and files never do", async () => {
    const res = await find({ key: "SRCH_" });
    const value = (key: string) =>
      res.json.items.find((v: { key: string }) => v.key === key)?.value;
    expect([value("SRCH_ORG_URL"), value("SRCH_PROJ_PLAIN")]).toEqual([
      "https://org.example/needle",
      "project needle",
    ]);
    expect([value("SRCH_ORG_SECRET"), value("SRCH_PROJ_SECRET"), value("SRCH_ENV_FILE")]).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("looks into plain values only, so a secret holding the same words is not found", async () => {
    const res = await find({ value: "needle" });
    expect(names(res)).toEqual(["SRCH_ENV_PLAIN", "SRCH_ORG_URL", "SRCH_PROJ_PLAIN"]);
    expect(names(await find({ value: "NEEDLE" }))).toEqual([]); // case matters
    expect(names(await find({ value: "needle", key: "env" }))).toEqual(["SRCH_ENV_PLAIN"]);
    expect(names(await find({ value: "needle", kind: "plain", key: "srch_o" }))).toEqual([
      "SRCH_ORG_URL",
    ]);
    const secretText = markers.find((m) => m.includes("-org-"));
    expect(names(await find({ value: secretText ?? "-" }))).toEqual([]);
  });

  test("kind narrows", async () => {
    const res = await find({ key: "srch_", kind: "secret" });
    expect(names(res)).toEqual(["SRCH_ORG_SECRET", "SRCH_PROJ_SECRET"]);
    expect(names(await find({ key: "srch_", kind: "file" }))).toEqual(["SRCH_ENV_FILE"]);
    expect(names(await find({ kind: "file" }))).toContain("SRCH_ENV_FILE");
  });

  test("a full page says there is more; an exact one does not", async () => {
    const page = await find({ key: "srch_", limit: 4 });
    expect([page.json.items.length, page.json.truncated]).toEqual([4, true]);
    const exact = await find({ key: "srch_", limit: 6 });
    expect([exact.json.items.length, exact.json.truncated]).toEqual([6, false]);
    const one = await find({ key: "srch_", limit: 1 });
    expect(names(one)).toEqual(["SRCH_ENV_FILE"]);
  });

  test("without a limit it is 50 items, and says there is more", async () => {
    const { path } = await freshEnv();
    await applyBulk(
      path,
      Array.from({ length: 51 }, (_, i) => set(`LIM_${String(i).padStart(2, "0")}`, "v", "plain")),
    );
    const res = await find({ key: "lim_" });
    expect([res.json.items.length, res.json.truncated]).toEqual([50, true]);
  });

  test("the dev principal sees all three levels, and an organization that is not there is a 404", async () => {
    const dev = createApp({
      logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
      db: t.db,
      principal: devPrincipal,
      ready: async () => {},
      keys,
    });
    expect((await find({ key: "srch_" }, null, undefined, dev)).json.items).toHaveLength(6);
    const gone = await call(
      null,
      "POST",
      `/organizations/${crypto.randomUUID()}/variable-search`,
      { key: "srch_" },
      dev,
    );
    expect(gone.status).toBe(404);
  });

  test("a nothing, a bad or a contradicting question is a 422", async () => {
    const before = await total();
    for (const body of [
      {},
      { limit: 5 },
      { key: "" },
      { value: "" },
      { key: "x".repeat(256) },
      { value: "x".repeat(1001) },
      { key: "a", limit: 0 },
      { key: "a", limit: 101 },
      { key: "a", limit: 1.5 },
      { key: "a", kind: "other" },
      { value: "needle", kind: "secret" },
      { value: "needle", kind: "file" },
      { key: "a", extra: 1 },
    ]) {
      const res = await find(body);
      expect([JSON.stringify(body).slice(0, 50), res.status]).toEqual([
        JSON.stringify(body).slice(0, 50),
        422,
      ]);
    }
    expect(await total()).toEqual(before);
  });

  test("never leaves the organization", async () => {
    expect(names(await find({ key: "SRCH_O2" }))).toEqual([]);
    expect(names(await find({ value: "needle" }))).not.toContain(org2);
    const theirs = await call("erin", "POST", `/organizations/${ids.o2}/variable-search`, {
      key: "srch_",
    });
    expect(names(theirs)).toEqual([org2]);
  });

  test("skips what is deleted", async () => {
    const id = await make(base.project(), "SRCH_SOON_GONE", "plain", "needle");
    expect(names(await find({ key: "soon_gone" }))).toEqual(["SRCH_SOON_GONE"]);
    expect((await call("alice", "DELETE", `${base.project()}/${id}`)).status).toBe(204);
    expect(names(await find({ key: "soon_gone" }))).toEqual([]);
  });

  test("who may: anyone who can read the organization's variables, as far as their token reaches", async () => {
    const all = (await find({ key: "srch_" })).json.items.length;
    expect((await find({ key: "srch_" }, "bob")).json.items.length).toBe(all);
    // a token may read the organization's variables, and the projects' only if its scopes say so
    expect(names(await find({ key: "srch_" }, null, tokens.orgOnly))).toEqual([
      "SRCH_ORG_SECRET",
      "SRCH_ORG_URL",
    ]);
    expect((await find({ key: "srch_" }, null, tokens.everything)).json.items.length).toBe(all);
    expect(names(await find({ value: "needle" }, null, tokens.orgOnly))).toEqual(["SRCH_ORG_URL"]);
    // no right to the organization's variables, no search
    expect((await find({ key: "srch_" }, "carol")).status).toBe(404);
    expect((await find({ key: "srch_" }, "erin")).status).toBe(404);
    expect((await find({ key: "srch_" }, null)).status).toBe(401);
  });

  test("changes nothing and writes no audit row, for what it looks for stays out of the log", async () => {
    const before = await total();
    await find({ value: "needle" });
    await find({ key: "srch_" });
    expect(await total()).toEqual(before);
    expect(JSON.stringify(await t.db.select().from(auditEvents))).not.toContain("needle");
  });

  test("without master keys it is a 503", async () => {
    const res = await find({ key: "srch_" }, "alice", undefined, makeApp(undefined));
    expect([res.status, res.json.code]).toEqual([503, "secrets_unavailable"]);
  });
});

describe("secrets stay secret", () => {
  test("no answer, log line or audit row of this suite holds a value, and nothing is stored in clear", async () => {
    expect(markers.length).toBeGreaterThan(9);
    expect(seen.length).toBeGreaterThan(80);
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
  });
});
