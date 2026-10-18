import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createOrganization,
  createProject,
  createSession,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { createApp } from "./app";
import { auditPurgeHandler } from "./audit-purge";
import { callerPrincipal } from "./credentials";
import { hashToken, randomToken } from "./tokens";
import type { JobContext } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let o1: string;
let o2: string;
let o3: string;
let p1: string;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<
  "alice" | "bob" | "carol" | "dave" | "eve",
  { id: string; cookie: string }
>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  t = await createTestDb();
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  o3 = (await createOrganization(t.db, { slug: "three", name: "Three" })).id;
  p1 = (await createProject(t.db, { organizationId: o1, name: "api" })).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob", "carol", "dave", "eve"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { id: user.id, cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [o1]: "admin" }, projectRoles: {} }); // alice: admin of one
  roleTable.set(902, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob: member of one
  roleTable.set(903, { orgRoles: { [o1]: "viewer" }, projectRoles: {} }); // carol: viewer of one
  roleTable.set(904, { orgRoles: { [o2]: "owner" }, projectRoles: {} }); // dave: owner of two
  roleTable.set(905, { orgRoles: { [o1]: "owner", [o3]: "owner" }, projectRoles: {} }); // eve: owner of one and three
  app = createApp({
    logger: createLogger({ level: "debug", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
  });
});
afterAll(async () => {
  await t.drop();
});

type Auth = keyof typeof people | { bearer: string } | undefined;
async function call(who: Auth, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (typeof who === "string") headers.cookie = people[who].cookie;
  else if (who) headers.authorization = `Bearer ${who.bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined) as any,
  };
}

const events = (org = o1) => `/organizations/${org}/audit-events`;
const retention = (org = o1) => `/organizations/${org}/audit-retention`;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const uniq = () => crypto.randomUUID().slice(0, 8);
const seed = async (org: string | null, over: Partial<typeof auditEvents.$inferInsert> = {}) => {
  const [row] = await t.db
    .insert(auditEvents)
    .values({
      actorKind: "user",
      actorId: "u-seed",
      action: "project.create",
      resourceType: "project",
      resourceId: `p-${uniq()}`,
      organizationId: org,
      ...over,
    })
    .returning();
  if (!row) throw new Error("no row");
  return row;
};
const rowsOf = (action: string, org = o1) =>
  t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, org)));

interface Item {
  id: string;
  action: string;
  actorId: string;
  metadata: Record<string, unknown>;
}

describe("listing", () => {
  test("is for org admins: a member and a viewer are refused, a stranger finds no such organization, nobody is unauthenticated", async () => {
    for (const [who, status] of [
      ["alice", 200],
      ["eve", 200],
      ["bob", 403],
      ["carol", 403],
      ["dave", 404],
      [undefined, 401],
    ] as const) {
      expect((await call(who, "GET", events())).status).toBe(status);
    }
  });

  test("shows the organization's events, newest first, and nobody else's", async () => {
    const mine = await seed(o1, { action: "seed.mine" });
    const theirs = await seed(o2, { action: "seed.theirs", resourceId: "x" });
    const none = await seed(null, { action: "seed.none" });
    const res = await call("alice", "GET", `${events()}?limit=100`);
    const ids = (res.json.items as Item[]).map((i) => i.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(none.id);
    expect(ids).toEqual([...ids].sort().reverse());
    // naming the other organization's resource finds nothing here
    const probe = await call("alice", "GET", `${events()}?resourceId=x&action=seed.theirs`);
    expect(probe.json.items).toEqual([]);
    expect((await call("dave", "GET", `${events(o2)}?action=seed.theirs`)).json.items).toHaveLength(
      1,
    );
    expect((await call("alice", "GET", events(Bun.randomUUIDv7()))).status).toBe(404);
  });

  test("filters narrow, and a prefix action matches the family", async () => {
    const p = await seed(o1, {
      action: "filt.one",
      actorKind: "token",
      actorId: "tok-9",
      projectId: p1,
      resourceType: "filt",
      resourceId: "r-9",
      at: ago(3),
    });
    await seed(o1, { action: "filt.two", at: ago(30) });
    const ids = async (qs: string) =>
      ((await call("alice", "GET", `${events()}?${qs}`)).json.items as Item[]).map((i) => i.id);
    expect(await ids("action=filt.one")).toEqual([p.id]);
    expect((await ids("action=filt.*")).length).toBe(2);
    expect(await ids("action=filt.*&actorId=tok-9")).toEqual([p.id]);
    expect(await ids("action=filt.*&actorKind=token")).toEqual([p.id]);
    expect(await ids(`action=filt.*&projectId=${p1}`)).toEqual([p.id]);
    expect(await ids("resourceType=filt&resourceId=r-9")).toEqual([p.id]);
    expect(await ids("action=filt.*&resourceId=r-9")).toEqual([p.id]);
    expect(await ids("action=filt.*&resourceId=r-none")).toEqual([]);
    expect(await ids(`action=filt.*&since=${ago(10).toISOString()}`)).toEqual([p.id]);
    expect(await ids(`action=filt.*&until=${ago(10).toISOString()}`)).not.toContain(p.id);
    expect(await ids("action=filt.*&actorId=nobody")).toEqual([]);
  });

  test("pages with a cursor that continues after the last row", async () => {
    for (let i = 0; i < 5; i++) await seed(o1, { action: "page.row" });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Awaited<ReturnType<typeof call>> = await call(
        "alice",
        "GET",
        `${events()}?action=page.row&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(res.status).toBe(200);
      seen.push(...(res.json.items as Item[]).map((i) => i.id));
      cursor = res.json.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  test("refuses a filter or cursor it cannot read", async () => {
    for (const qs of [
      "action=Bad%20Action",
      "action=a..b",
      "action=%25",
      "projectId=nope",
      "since=yesterday",
      "limit=0",
      "limit=101",
    ]) {
      expect([qs, (await call("alice", "GET", `${events()}?${qs}`)).status]).toEqual([qs, 422]);
    }
    const res = await call("alice", "GET", `${events()}?cursor=not-a-cursor`);
    expect([res.status, res.json.code]).toEqual([400, "invalid_cursor"]);
    const wrong = Buffer.from(JSON.stringify(["x' OR 1=1"])).toString("base64url");
    expect((await call("alice", "GET", `${events()}?cursor=${wrong}`)).status).toBe(400);
  });

  test("shows what the real routes recorded, and none of the secret they were given", async () => {
    const value = `SEKRIT-${uniq()}-value`;
    const made = await call("alice", "POST", `/organizations/${o1}/variables`, {
      key: "AUDITED_SECRET",
      kind: "secret",
      value,
    });
    expect(made.status).toBe(201);
    const list = await call("alice", "GET", `${events()}?limit=100&action=variable.*`);
    const row = (list.json.items as Item[]).find((i) => i.action === "variable.create");
    expect(row).toMatchObject({ actorId: people.alice.id, metadata: { key: "AUDITED_SECRET" } });
    expect(list.text).not.toContain(value);
  });
});

describe("export", () => {
  test("is for org admins only, and a refusal records nothing", async () => {
    const before = (await rowsOf("audit.export")).length;
    for (const [who, status] of [
      ["alice", 200],
      ["bob", 403],
      ["carol", 403],
      ["dave", 404],
      [undefined, 401],
    ] as const) {
      expect((await call(who, "GET", `${events()}/export`)).status).toBe(status);
    }
    expect((await rowsOf("audit.export")).length).toBe(before + 1);
  });

  test("a token is given it by name: audit.read does not export, audit.export does", async () => {
    const mint = async (scopes: string[]) => {
      const res = await call("alice", "POST", "/tokens", { name: "audit", scopes });
      expect(res.status).toBe(201);
      return { bearer: res.json.token as string };
    };
    const reader = await mint(["organization.read", "audit.read"]);
    const exporter = await mint(["organization.read", "audit.export"]);
    expect((await call(reader, "GET", events())).status).toBe(200);
    expect((await call(reader, "GET", `${events()}/export`)).status).toBe(403);
    expect((await call(exporter, "GET", `${events()}/export`)).status).toBe(200);
    expect((await call(exporter, "GET", events())).status).toBe(403);
  });

  test("a token reads the retention by its own name, and cannot set it", async () => {
    const mint = async (scopes: string[]) => {
      const res = await call("eve", "POST", "/tokens", { name: "retention", scopes });
      expect(res.status).toBe(201);
      return { bearer: res.json.token as string };
    };
    const reader = await mint(["organization.read", "audit.retention.read"]);
    const auditor = await mint(["organization.read", "audit.read", "audit.export"]);
    const setter = await mint(["organization.read", "audit.retention.update"]);
    expect((await call(reader, "GET", retention(o1))).status).toBe(200);
    expect((await call(auditor, "GET", retention(o1))).status).toBe(403);
    expect((await call(reader, "PUT", retention(o1), { days: 90 })).status).toBe(403);
    expect((await call(setter, "GET", retention(o1))).status).toBe(403);
  });

  test("is itself audited, with who, the filters, the format and how many rows", async () => {
    await seed(o1, { action: "exp.row" });
    await seed(o1, { action: "exp.row" });
    const res = await call("alice", "GET", `${events()}/export?action=exp.*&format=json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="audit-events.json"');
    expect(res.json.items).toHaveLength(2);
    const row = (await rowsOf("audit.export")).find(
      (r) => (r.metadata as { action?: string }).action === "exp.*",
    );
    expect(row).toMatchObject({
      actorKind: "user",
      actorId: people.alice.id,
      resourceType: "audit_log",
      resourceId: o1,
      organizationId: o1,
      metadata: { format: "json", count: 2, action: "exp.*" },
    });
    // the export is in the log from then on, not in its own output
    expect(res.text).not.toContain(row?.id ?? "?");
    const after = await call("alice", "GET", `${events()}?action=audit.export`);
    expect((after.json.items as Item[]).map((i) => i.id)).toContain(row?.id as string);
  });

  test("csv has one line per event under a header, and the value of a secret is nowhere in it", async () => {
    const value = `SEKRIT-${uniq()}-csv`;
    await call("alice", "POST", `/organizations/${o1}/variables`, {
      key: "CSV_SECRET",
      kind: "secret",
      value,
    });
    const res = await call("alice", "GET", `${events()}/export?format=csv&action=variable.*`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="audit-events.csv"');
    const lines = res.text.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "id,at,actor_kind,actor_id,action,resource_type,resource_id,organization_id,project_id,request_id,ip,metadata",
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(res.text).toContain("CSV_SECRET");
    expect(res.text).not.toContain(value);
    const json = await call("alice", "GET", `${events()}/export?action=variable.*`);
    expect(json.text).not.toContain(value);
  });

  test("a spreadsheet formula in an id is made inert", async () => {
    await seed(o1, {
      action: "csv.formula",
      actorId: '=HYPERLINK("http://x")',
      resourceId: "a,b\nc",
    });
    const res = await call("alice", "GET", `${events()}/export?format=csv&action=csv.formula`);
    expect(res.text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(res.text).toContain(`"a,b\nc"`);
  });

  test("pages by x-next-cursor until the log is read", async () => {
    for (let i = 0; i < 5; i++) await seed(o1, { action: "exp.page" });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Awaited<ReturnType<typeof call>> = await call(
        "alice",
        "GET",
        `${events()}/export?action=exp.page&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      seen.push(...(res.json.items as Item[]).map((i) => i.id));
      cursor = res.headers.get("x-next-cursor");
      expect(cursor).toBe(res.json.nextCursor);
      pages++;
    } while (cursor);
    expect([pages, new Set(seen).size]).toEqual([3, 5]);
    // each export says how many rows it handed out, not how many it looked at
    const counts = (await rowsOf("audit.export"))
      .filter((r) => (r.metadata as { action?: string }).action === "exp.page")
      .map((r) => (r.metadata as { count: number }).count)
      .sort();
    expect(counts).toEqual([1, 2, 2]);
  });

  test("refuses a bad format, a limit past the cap and a cursor it cannot read", async () => {
    for (const qs of ["format=xml", "limit=5001", "limit=0", "action=A%20B"]) {
      expect([qs, (await call("alice", "GET", `${events()}/export?${qs}`)).status]).toEqual([
        qs,
        422,
      ]);
    }
    const res = await call("alice", "GET", `${events()}/export?cursor=zzz`);
    expect([res.status, res.json.code]).toEqual([400, "invalid_cursor"]);
  });
});

describe("retention", () => {
  test("is read by admins and set only by an owner", async () => {
    expect((await call("alice", "GET", retention())).json).toEqual({ days: null });
    for (const [who, status] of [
      ["bob", 403],
      ["carol", 403],
      ["dave", 404],
      [undefined, 401],
    ] as const) {
      expect((await call(who, "GET", retention())).status).toBe(status);
    }
    expect((await call("alice", "PUT", retention(), { days: 90 })).status).toBe(403);
    expect((await call("dave", "PUT", retention(), { days: 90 })).status).toBe(404);
    expect((await call("alice", "GET", retention())).json).toEqual({ days: null });
  });

  test("an owner sets it, it is audited with the old and the new, and null keeps for ever again", async () => {
    const set = await call("eve", "PUT", retention(), { days: 90 });
    expect([set.status, set.json]).toEqual([200, { days: 90 }]);
    expect((await call("alice", "GET", retention())).json).toEqual({ days: 90 });
    const off = await call("eve", "PUT", retention(), { days: null });
    expect(off.json).toEqual({ days: null });
    const rows = await rowsOf("audit.retention.update");
    expect(rows.map((r) => r.metadata)).toEqual(
      expect.arrayContaining([
        { days: 90, previousDays: null },
        { days: null, previousDays: 90 },
      ]),
    );
    expect(rows[0]).toMatchObject({ actorId: people.eve.id, resourceId: o1, organizationId: o1 });
  });

  test("refuses fewer than 30 days, more than 3650, a fraction, a string and anything extra", async () => {
    for (const body of [
      { days: 29 },
      { days: 0 },
      { days: -1 },
      { days: 3651 },
      { days: 30.5 },
      { days: "30" },
      {},
      { days: 30, extra: 1 },
    ]) {
      expect([JSON.stringify(body), (await call("eve", "PUT", retention(), body)).status]).toEqual([
        JSON.stringify(body),
        422,
      ]);
    }
    expect((await call("eve", "PUT", retention(), { days: 30 })).status).toBe(200);
    expect((await call("eve", "PUT", retention(), { days: 3650 })).status).toBe(200);
    await call("eve", "PUT", retention(), { days: null });
  });

  test("a refused change records nothing", async () => {
    const before = (await rowsOf("audit.retention.update")).length;
    await call("eve", "PUT", retention(), { days: 5 });
    await call("alice", "PUT", retention(), { days: 90 });
    expect((await rowsOf("audit.retention.update")).length).toBe(before);
  });
});

describe("the purge job", () => {
  const ctx = (): JobContext => ({
    id: "job",
    queue: "audit.purge",
    payload: {},
    attempt: 1,
    maxAttempts: 1,
    log: createLogger({ level: "debug", write: () => {} }),
    signal: new AbortController().signal,
  });
  const has = async (id: string) =>
    (await t.db.select().from(auditEvents).where(eq(auditEvents.id, id))).length === 1;

  test("deletes what an owner's retention has expired, leaves the rest and says so in the log", async () => {
    const o = o3;
    expect((await call("eve", "PUT", retention(o), { days: 30 })).status).toBe(200);

    const old = await seed(o, { at: ago(45) });
    const fresh = await seed(o, { at: ago(5) });
    const kept = await createOrganization(t.db, { slug: `kept-${uniq()}`, name: "K" });
    const keptOld = await seed(kept.id, { at: ago(4000) });
    const orphan = await seed(null, { at: ago(4000) });

    await auditPurgeHandler({ db: t.db })(ctx());

    expect(await has(old.id)).toBe(false);
    expect(await has(fresh.id)).toBe(true);
    expect(await has(keptOld.id)).toBe(true);
    expect(await has(orphan.id)).toBe(true);
    const [record] = await rowsOf("audit.purge", o);
    expect(record).toMatchObject({
      actorKind: "system",
      actorId: "audit-purge",
      resourceType: "audit_log",
      resourceId: o,
      metadata: { count: 1 },
    });
    expect(await rowsOf("audit.purge", kept.id)).toEqual([]);

    // nothing is due now, so the next run changes nothing and says nothing
    await auditPurgeHandler({ db: t.db })(ctx());
    expect(await rowsOf("audit.purge", o)).toHaveLength(1);
  });

  test("a purge that cannot be recorded is not done: the events stay", async () => {
    const o = (await createOrganization(t.db, { slug: `atomic-${uniq()}`, name: "A" })).id;
    await t.db.execute(sql`update organizations set audit_retention_days = 30 where id = ${o}`);
    const old = await seed(o, { at: ago(60), action: "atomic.row" });
    // a log that refuses the record of the purge (this test database only)
    await t.db.execute(sql`
      CREATE FUNCTION refuse_purge_record() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'no record'; END; $$`);
    await t.db.execute(sql`
      CREATE TRIGGER refuse_purge_record BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (NEW.action = 'audit.purge') EXECUTE FUNCTION refuse_purge_record()`);
    try {
      await expect(auditPurgeHandler({ db: t.db })(ctx())).rejects.toThrow();
      expect(await has(old.id)).toBe(true);
    } finally {
      await t.db.execute(sql`DROP TRIGGER refuse_purge_record ON audit_events`);
      await t.db.execute(sql`DROP FUNCTION refuse_purge_record()`);
    }
    await auditPurgeHandler({ db: t.db })(ctx());
    expect(await has(old.id)).toBe(false);
  });

  test("works through a backlog a batch at a time and stops at the round limit", async () => {
    const o = (await createOrganization(t.db, { slug: `backlog-${uniq()}`, name: "B" })).id;
    await t.db.execute(sql`update organizations set audit_retention_days = 30 where id = ${o}`);
    for (let i = 0; i < 5; i++) await seed(o, { at: ago(60), action: "backlog.row" });
    const left = async () =>
      (
        await t.db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.organizationId, o), eq(auditEvents.action, "backlog.row")))
      ).length;
    await auditPurgeHandler({ db: t.db, batch: 2, rounds: 2 })(ctx());
    expect(await left()).toBe(1);
    await auditPurgeHandler({ db: t.db, batch: 2, rounds: 2 })(ctx());
    expect(await left()).toBe(0);
    const records = await rowsOf("audit.purge", o);
    expect(records.map((r) => (r.metadata as { count: number }).count).sort()).toEqual([1, 2, 2]);
  });
});
