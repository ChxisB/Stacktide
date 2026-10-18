import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  getAuditRetention,
  listAuditEvents,
  purgeExpiredAudit,
  setAuditRetention,
} from "./audit-log";
import { createDb } from "./index";
import { pgCode } from "./pg-error";
import { createOrganization, deleteOrganization } from "./repo";
import { auditEvents } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const uniq = () => crypto.randomUUID().slice(0, 8);
const org = () => createOrganization(t.db, { slug: `o-${uniq()}`, name: "O" });
const DAY = 86_400_000;
const ago = (days: number, extraMs = 0) => new Date(Date.now() - days * DAY - extraMs);
/** Inserts directly so `at` can be set: `audit()` always stamps now. */
const event = async (
  organizationId: string | null,
  over: Partial<typeof auditEvents.$inferInsert> = {},
) => {
  const [row] = await t.db
    .insert(auditEvents)
    .values({
      actorKind: "user",
      actorId: "u-1",
      action: "project.create",
      resourceType: "project",
      resourceId: `p-${uniq()}`,
      organizationId,
      ...over,
    })
    .returning();
  if (!row) throw new Error("no row");
  return row;
};
const count = async (organizationId: string) =>
  (await t.db.select().from(auditEvents).where(eq(auditEvents.organizationId, organizationId)))
    .length;

describe("listAuditEvents", () => {
  test("one organization's events, newest first, never another's", async () => {
    const a = await org();
    const b = await org();
    const first = await event(a.id);
    const second = await event(a.id);
    await event(b.id);
    await event(null);
    const rows = await listAuditEvents(t.db, { organizationId: a.id }, { limit: 10 });
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  test("pages by id without gaps or repeats, whatever the clock says", async () => {
    const o = await org();
    const ids: string[] = [];
    // the same instant for all of them: only the id orders them
    const at = ago(1);
    for (let i = 0; i < 5; i++) ids.push((await event(o.id, { at })).id);
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await listAuditEvents(t.db, { organizationId: o.id }, { after, limit: 2 });
      seen.push(...page.map((r) => r.id));
      if (page.length < 2) break;
      after = page.at(-1)?.id;
    }
    expect(seen).toEqual([...ids].reverse());
  });

  test("filters by actor, resource, project and the time window", async () => {
    const o = await org();
    const p1 = Bun.randomUUIDv7();
    const p2 = Bun.randomUUIDv7();
    const a = await event(o.id, { actorKind: "token", actorId: "t-1", projectId: p1, at: ago(10) });
    const b = await event(o.id, {
      actorKind: "user",
      actorId: "u-2",
      resourceType: "variable",
      resourceId: "v-1",
      projectId: p2,
      at: ago(5),
    });
    const c = await event(o.id, { at: ago(1) });
    const ids = async (f: Partial<Parameters<typeof listAuditEvents>[1]>) =>
      (await listAuditEvents(t.db, { organizationId: o.id, ...f }, { limit: 10 }))
        .map((r) => r.id)
        .sort();
    const sorted = (...rows: { id: string }[]) => rows.map((r) => r.id).sort();
    expect(await ids({ actorKind: "token" })).toEqual(sorted(a));
    expect(await ids({ actorId: "u-2" })).toEqual(sorted(b));
    expect(await ids({ resourceType: "variable" })).toEqual(sorted(b));
    expect(await ids({ resourceType: "variable", resourceId: "v-1" })).toEqual(sorted(b));
    expect(await ids({ projectId: p1 })).toEqual(sorted(a));
    expect(await ids({ since: ago(6) })).toEqual(sorted(b, c));
    expect(await ids({ until: ago(6) })).toEqual(sorted(a));
    expect(await ids({ since: ago(6), until: ago(2) })).toEqual(sorted(b));
    // all of them together narrow, they do not widen
    expect(await ids({ actorKind: "token", projectId: p2 })).toEqual([]);
  });

  test("since is inclusive and until is exclusive, to the instant", async () => {
    const o = await org();
    const at = new Date(Date.now() - 3 * DAY);
    at.setMilliseconds(0);
    const e = await event(o.id, { at });
    const ids = async (f: Partial<Parameters<typeof listAuditEvents>[1]>) =>
      (await listAuditEvents(t.db, { organizationId: o.id, ...f }, { limit: 10 })).map((r) => r.id);
    expect(await ids({ since: at })).toEqual([e.id]);
    expect(await ids({ until: at })).toEqual([]);
    expect(await ids({ since: new Date(at.getTime() + 1) })).toEqual([]);
    expect(await ids({ until: new Date(at.getTime() + 1) })).toEqual([e.id]);
  });

  test("a resource id narrows on its own", async () => {
    const o = await org();
    const a = await event(o.id, { resourceId: "only-a" });
    await event(o.id, { resourceId: "only-b" });
    const found = await listAuditEvents(
      t.db,
      { organizationId: o.id, resourceId: "only-a" },
      { limit: 10 },
    );
    expect(found.map((r) => r.id)).toEqual([a.id]);
  });

  test("an action matches exactly, or by prefix with a trailing .*, and `_` is not a wildcard", async () => {
    const o = await org();
    const create = await event(o.id, { action: "variable.create" });
    const del = await event(o.id, { action: "variable.delete" });
    const other = await event(o.id, { action: "variable_x.create" });
    const sync = await event(o.id, { action: "sync.apply" });
    const ids = async (action: string) =>
      (await listAuditEvents(t.db, { organizationId: o.id, action }, { limit: 10 }))
        .map((r) => r.id)
        .sort();
    const sorted = (...rows: { id: string }[]) => rows.map((r) => r.id).sort();
    expect(await ids("variable.create")).toEqual(sorted(create));
    expect(await ids("variable.*")).toEqual(sorted(create, del));
    expect(await ids("variable_x.*")).toEqual(sorted(other));
    expect(await ids("variabl.*")).toEqual([]);
    expect(await ids("sync.apply")).toEqual(sorted(sync));
    // the prefix is plain text: no pattern characters mean anything
    expect(await ids("%.*")).toEqual([]);
    expect(await ids("variable._reate")).toEqual([]);
  });
});

describe("retention setting", () => {
  test("is empty (kept for ever) until set, and reports the previous value", async () => {
    const o = await org();
    expect(await getAuditRetention(t.db, o.id)).toBeNull();
    expect(await setAuditRetention(t.db, o.id, 90)).toEqual({ previous: null });
    expect(await getAuditRetention(t.db, o.id)).toBe(90);
    expect(await setAuditRetention(t.db, o.id, null)).toEqual({ previous: 90 });
    expect(await getAuditRetention(t.db, o.id)).toBeNull();
  });

  test("an organization that is not there has none", async () => {
    const missing = Bun.randomUUIDv7();
    expect(await getAuditRetention(t.db, missing)).toBeUndefined();
    expect(await setAuditRetention(t.db, missing, 90)).toBeUndefined();
  });

  test("the table refuses fewer than 30 days or more than 3650", async () => {
    const o = await org();
    for (const days of [0, 1, 29, 3651, -5]) {
      const err = await setAuditRetention(t.db, o.id, days).catch((e) => e);
      expect(pgCode(err)).toBe("23514");
    }
    expect(await getAuditRetention(t.db, o.id)).toBeNull();
    await setAuditRetention(t.db, o.id, 30);
    await setAuditRetention(t.db, o.id, 3650);
    expect(await getAuditRetention(t.db, o.id)).toBe(3650);
  });
});

describe("purgeExpiredAudit", () => {
  test("deletes only what is older than its own organization's retention", async () => {
    const kept = await org(); // keeps for ever
    const short = await org();
    const long = await org();
    await setAuditRetention(t.db, short.id, 30);
    await setAuditRetention(t.db, long.id, 365);
    for (const o of [kept, short, long]) {
      await event(o.id, { at: ago(400) });
      await event(o.id, { at: ago(100) });
      await event(o.id, { at: ago(31, -60_000) }); // a minute inside 31 days
      await event(o.id, { at: ago(29) });
      await event(o.id, { at: ago(30, -60_000) }); // a minute inside 30 days
      await event(o.id, { at: ago(30, 60_000) }); // a minute past it
    }
    const orphan = await event(null, { at: ago(4000) });

    const gone = await purgeExpiredAudit(t.db, 100);
    const byOrg = Object.fromEntries(gone.map((g) => [g.organizationId, g.purged]));
    // short: 400, 100, 31 (-1min), and 30 + 1min  -> 4 of 6; long: only the 400-day one
    expect(byOrg).toEqual({ [short.id]: 4, [long.id]: 1 });
    expect(await count(kept.id)).toBe(6);
    expect(await count(short.id)).toBe(2);
    expect(await count(long.id)).toBe(5);
    expect(
      (await t.db.select().from(auditEvents).where(eq(auditEvents.id, orphan.id))).length,
    ).toBe(1);

    // nothing more is due, and a second run finds nothing
    expect(await purgeExpiredAudit(t.db, 100)).toEqual([]);
  });

  test("takes at most one batch, oldest first, and the rest goes on the next run", async () => {
    const o = await org();
    await setAuditRetention(t.db, o.id, 30);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await event(o.id, { at: ago(60) })).id);
    expect(await purgeExpiredAudit(t.db, 2)).toEqual([{ organizationId: o.id, purged: 2 }]);
    expect(await count(o.id)).toBe(3);
    const left = await t.db.select().from(auditEvents).where(eq(auditEvents.organizationId, o.id));
    expect(left.map((r) => r.id).sort()).toEqual(ids.slice(2));
    expect(await purgeExpiredAudit(t.db, 10)).toEqual([{ organizationId: o.id, purged: 3 }]);
  });

  test("one batch is shared by the organizations, not given to each", async () => {
    const orgs = [await org(), await org(), await org()];
    for (const o of orgs) {
      await setAuditRetention(t.db, o.id, 30);
      for (let i = 0; i < 3; i++) await event(o.id, { at: ago(60) });
    }
    const first = await purgeExpiredAudit(t.db, 4);
    expect(first.reduce((n, g) => n + g.purged, 0)).toBe(4);
    const second = await purgeExpiredAudit(t.db, 100);
    expect(second.reduce((n, g) => n + g.purged, 0)).toBe(5);
    for (const o of orgs) expect(await count(o.id)).toBe(0);
  });

  test("a batch outside 1 to 10000 is refused", async () => {
    for (const batch of [0, -1, 10_001]) {
      expect(pgCode(await purgeExpiredAudit(t.db, batch).catch((e) => e))).toBe("22023");
    }
  });

  test("leaves the events of an organization that is gone, and of a retention switched off", async () => {
    const gone = await org();
    await setAuditRetention(t.db, gone.id, 30);
    const e = await event(gone.id, { at: ago(100) });
    expect(await deleteOrganization(t.db, gone.id)).toBe(true);
    const off = await org();
    await setAuditRetention(t.db, off.id, 30);
    await event(off.id, { at: ago(100) });
    await setAuditRetention(t.db, off.id, null);
    await purgeExpiredAudit(t.db, 1000);
    expect((await t.db.select().from(auditEvents).where(eq(auditEvents.id, e.id))).length).toBe(1);
    expect(await count(off.id)).toBe(1);
  });

  test("while the purge flag is on only DELETE is let through: UPDATE and TRUNCATE still fail", async () => {
    const o = await org();
    const e = await event(o.id);
    const on = (
      fn: (tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0]) => Promise<unknown>,
    ) =>
      t.db
        .transaction(async (tx) => {
          await tx.execute(sql`select set_config('orch.audit_purge', 'on', true)`);
          await fn(tx);
        })
        .catch((err) => err);
    expect(
      pgCode(
        await on((tx) =>
          tx.execute(sql`UPDATE audit_events SET action = 'x.y' WHERE id = ${e.id}`),
        ),
      ),
    ).toBe("55000");
    expect(pgCode(await on((tx) => tx.execute(sql`TRUNCATE audit_events`)))).toBe("55000");
    expect((await t.db.select().from(auditEvents).where(eq(auditEvents.id, e.id))).length).toBe(1);
  });

  test("the flag does not outlive the purge's transaction on the connection that ran it", async () => {
    // one connection, so the next statement is certain to be on the one the purge used
    const one = createDb(t.url, 1);
    try {
      const o = await org();
      await setAuditRetention(one, o.id, 30);
      const old = await event(o.id, { at: ago(100) });
      await one.transaction(async (tx) => {
        await purgeExpiredAudit(tx, 100);
      });
      const left = await event(o.id);
      const err = await one
        .delete(auditEvents)
        .where(eq(auditEvents.id, left.id))
        .catch((e) => e);
      expect(pgCode(err)).toBe("55000");
      expect((await t.db.select().from(auditEvents).where(eq(auditEvents.id, old.id))).length).toBe(
        0,
      );
    } finally {
      await one.$client.close();
    }
  });

  test("the log is append-only again the moment it returns, even inside the same transaction", async () => {
    const o = await org();
    await setAuditRetention(t.db, o.id, 30);
    const old = await event(o.id, { at: ago(100) });
    const fresh = await event(o.id);
    const err = await t.db
      .transaction(async (tx) => {
        await purgeExpiredAudit(tx, 100);
        await tx.delete(auditEvents).where(eq(auditEvents.id, fresh.id));
      })
      .catch((e) => e);
    expect(pgCode(err)).toBe("55000");
    // the whole transaction rolled back, the purge with it
    expect((await t.db.select().from(auditEvents).where(eq(auditEvents.id, old.id))).length).toBe(
      1,
    );
    // and the flag does not outlive the call for UPDATE or TRUNCATE either
    const more = await t.db
      .transaction(async (tx) => {
        await purgeExpiredAudit(tx, 100);
        await tx.execute(sql`UPDATE audit_events SET action = 'x.y' WHERE id = ${fresh.id}`);
      })
      .catch((e) => e);
    expect(pgCode(more)).toBe("55000");
    const truncate = await t.db
      .transaction(async (tx) => {
        await purgeExpiredAudit(tx, 100);
        await tx.execute(sql`TRUNCATE audit_events`);
      })
      .catch((e) => e);
    expect(pgCode(truncate)).toBe("55000");
  });
});
