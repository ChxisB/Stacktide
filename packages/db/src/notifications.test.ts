import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { aad, CryptoError, encrypt, envKeyProvider, unwrapDek, wrapDek } from "@orch/crypto";
import { eq, sql } from "drizzle-orm";
import {
  createSink,
  deleteSink,
  getSink,
  listSinks,
  listSubscriptions,
  NOTIFY_QUEUE,
  notifyRotationFailing,
  notifyStackDrift,
  openSink,
  removeSubscriptions,
  setSubscriptions,
} from "./notifications";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import { jobs, notificationSinks } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const keys = envKeyProvider(`k2:${key(2)},k1:${key(1)}`);
const SECRET =
  '{"url":"https://hooks.slack.com/services/T000/B000/SECRETSECRET","secret":"whsec_ZZZ"}';

let n = 0;
const org = () => createOrganization(t.db, { slug: `o${++n}`, name: "O" });
const project = (organizationId: string, name = `p${++n}`) =>
  createProject(t.db, { organizationId, name });
const sink = (
  organizationId: string,
  over: { name?: string; kind?: "webhook" | "slack"; secret?: string } = {},
) =>
  createSink(t.db, keys, {
    organizationId,
    kind: over.kind ?? "slack",
    name: over.name ?? `s${++n}`,
    host: "hooks.slack.com",
    secret: over.secret ?? SECRET,
  });
const raw = async (id: string) =>
  (await t.db.execute(sql`SELECT * FROM notification_sinks WHERE id = ${id}`))[0] as Record<
    string,
    unknown
  >;
const refusedBy = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return pgConstraint(e) ?? e;
  }
  return undefined;
};

describe("sinks at rest", () => {
  test("the address and secret are encrypted: a raw read of the row holds neither", async () => {
    const s = await sink((await org()).id);
    const row = await raw(s.id);
    const bytes = (v: unknown) => Buffer.from(v as Uint8Array).toString("latin1");
    for (const value of Object.values(row).filter((v) => v !== null)) {
      const text = JSON.stringify(value) + bytes(value);
      expect(text).not.toContain("SECRETSECRET");
      expect(text).not.toContain("whsec_ZZZ");
    }
    expect(row.dek_key_id).toBe("k2");
  });

  test("the secret comes back through openSink, and only there", async () => {
    const o = await org();
    const s = await sink(o.id);
    expect(s).not.toHaveProperty("secretEnc");
    expect(JSON.stringify(await getSink(t.db, o.id, s.id))).not.toContain("SECRETSECRET");
    expect(JSON.stringify(await listSinks(t.db, o.id, { limit: 10 }))).not.toContain(
      "SECRETSECRET",
    );
    const opened = await openSink(t.db, keys, o.id, s.id);
    expect(opened?.secret).toBe(SECRET);
    expect(opened?.sink).toEqual(s);
  });

  test("a sink asked for through another organization is not found, and its secret does not open", async () => {
    const a = await org();
    const b = await org();
    const s = await sink(a.id);
    expect(await getSink(t.db, b.id, s.id)).toBeUndefined();
    expect(await openSink(t.db, keys, b.id, s.id)).toBeUndefined();
    expect(await deleteSink(t.db, b.id, s.id)).toBe(false);
  });

  test("a ciphertext moved to another sink does not open", async () => {
    const o = await org();
    const one = await sink(o.id, { secret: "one" });
    const two = await sink(o.id, { secret: "two" });
    await t.db.execute(
      sql`UPDATE notification_sinks SET secret_enc = (SELECT secret_enc FROM notification_sinks WHERE id = ${one.id}) WHERE id = ${two.id}`,
    );
    await expect(openSink(t.db, keys, o.id, two.id)).rejects.toBeInstanceOf(CryptoError);
  });

  test("a wrapped key moved to another sink does not unwrap", async () => {
    const o = await org();
    const one = await sink(o.id);
    const two = await sink(o.id);
    await t.db.execute(
      sql`UPDATE notification_sinks SET dek_wrapped = (SELECT dek_wrapped FROM notification_sinks WHERE id = ${one.id}) WHERE id = ${two.id}`,
    );
    await expect(openSink(t.db, keys, o.id, two.id)).rejects.toBeInstanceOf(CryptoError);
  });

  // Each binding is tested alone: the other one is made to pass, so only this one can refuse.
  const keyOf = async (id: string) => {
    const [row] = await t.db.select().from(notificationSinks).where(eq(notificationSinks.id, id));
    if (!row) throw new Error("no such sink");
    const dek = await unwrapDek(
      keys,
      { keyId: row.dekKeyId, wrapped: row.dekWrapped },
      `notification_sink:${id}`,
    );
    return { row, dek };
  };

  test("a ciphertext is bound to its own sink even under a key that opens for the other", async () => {
    const o = await org();
    const one = await sink(o.id, { secret: "one" });
    const two = await sink(o.id, { secret: "two" });
    const { row, dek } = await keyOf(one.id);
    const wrap = await wrapDek(keys, dek, `notification_sink:${two.id}`);
    await t.db
      .update(notificationSinks)
      .set({ secretEnc: row.secretEnc, dekKeyId: wrap.keyId, dekWrapped: wrap.wrapped })
      .where(eq(notificationSinks.id, two.id));
    await expect(openSink(t.db, keys, o.id, two.id)).rejects.toBeInstanceOf(CryptoError);
  });

  test("a wrapped key is bound to its own sink even under a ciphertext that opens for the other", async () => {
    const o = await org();
    const one = await sink(o.id);
    const two = await sink(o.id);
    const { row, dek } = await keyOf(one.id);
    await t.db
      .update(notificationSinks)
      .set({
        secretEnc: encrypt(dek, "forged", aad("notification_sink", o.id, two.id)),
        dekKeyId: row.dekKeyId,
        dekWrapped: row.dekWrapped,
      })
      .where(eq(notificationSinks.id, two.id));
    await expect(openSink(t.db, keys, o.id, two.id)).rejects.toBeInstanceOf(CryptoError);
  });

  test("names are unique per organization, kinds are checked, and the list is in creation order", async () => {
    const a = await org();
    const b = await org();
    const first = await sink(a.id, { name: "ops" });
    expect(await refusedBy(sink(a.id, { name: "ops" }))).toBe("notification_sinks_org_name_key");
    await sink(b.id, { name: "ops" });
    expect(
      await refusedBy(
        t.db.execute(sql`UPDATE notification_sinks SET kind = 'email' WHERE id = ${first.id}`),
      ),
    ).toBe("notification_sinks_kind_check");
    const second = await sink(a.id, { name: "later" });
    const page = await listSinks(t.db, a.id, { limit: 1 });
    expect(page.map((s) => s.id)).toEqual([first.id]);
    expect((await listSinks(t.db, a.id, { after: first.id, limit: 5 })).map((s) => s.id)).toEqual([
      second.id,
    ]);
  });
});

describe("subscriptions", () => {
  test("setting replaces what a project asked of a sink, and each event once", async () => {
    const o = await org();
    const p = await project(o.id);
    const s = await sink(o.id);
    const scope = { organizationId: o.id, projectId: p.id, sinkId: s.id };
    await setSubscriptions(t.db, { ...scope, events: ["stack.drift", "stack.drift"] });
    const listed = await listSubscriptions(t.db, o.id, p.id, { limit: 10 });
    expect(listed.map((r) => [r.sinkId, r.name, r.kind, r.host, r.event])).toEqual([
      [s.id, s.name, "slack", "hooks.slack.com", "stack.drift"],
    ]);
    await setSubscriptions(t.db, { ...scope, events: [] });
    expect(await listSubscriptions(t.db, o.id, p.id, { limit: 10 })).toEqual([]);
  });

  test("two settings at once end the same way, and neither fails", async () => {
    const o = await org();
    const p = await project(o.id);
    const s = await sink(o.id);
    const scope = { organizationId: o.id, projectId: p.id, sinkId: s.id };
    for (let round = 0; round < 5; round++) {
      await t.db.transaction((tx) => setSubscriptions(tx, { ...scope, events: [] }));
      const set = () =>
        t.db.transaction((tx) => setSubscriptions(tx, { ...scope, events: ["stack.drift"] }));
      await Promise.all([set(), set()]);
      expect(await listSubscriptions(t.db, o.id, p.id, { limit: 10 })).toHaveLength(1);
    }
  });

  test("removing says whether anything was there", async () => {
    const o = await org();
    const p = await project(o.id);
    const s = await sink(o.id);
    const scope = { organizationId: o.id, projectId: p.id, sinkId: s.id };
    expect(await removeSubscriptions(t.db, o.id, p.id, s.id)).toBe(false);
    await setSubscriptions(t.db, { ...scope, events: ["stack.drift"] });
    expect(await removeSubscriptions(t.db, o.id, p.id, s.id)).toBe(true);
    expect(await removeSubscriptions(t.db, o.id, p.id, s.id)).toBe(false);
  });

  test("a project cannot use another organization's sink, nor name a project of another organization", async () => {
    const a = await org();
    const b = await org();
    const p = await project(a.id);
    const theirs = await sink(b.id);
    expect(
      await refusedBy(
        setSubscriptions(t.db, {
          organizationId: a.id,
          projectId: p.id,
          sinkId: theirs.id,
          events: ["stack.drift"],
        }),
      ),
    ).toBe("notification_subscriptions_sink_org_fk");
    expect(
      await refusedBy(
        t.db.execute(
          sql`INSERT INTO notification_subscriptions (organization_id, project_id, sink_id, event)
              VALUES (${b.id}, ${p.id}, ${theirs.id}, 'stack.drift')`,
        ),
      ),
    ).toBe("notification_subscriptions_project_org_fk");
  });

  test("an event nobody sends is refused", async () => {
    const o = await org();
    const p = await project(o.id);
    const s = await sink(o.id);
    expect(
      await refusedBy(
        t.db.execute(
          sql`INSERT INTO notification_subscriptions (organization_id, project_id, sink_id, event)
              VALUES (${o.id}, ${p.id}, ${s.id}, 'run.apply')`,
        ),
      ),
    ).toBe("notification_subscriptions_event_check");
  });

  test("deleting a sink or a project takes its subscriptions with it", async () => {
    const o = await org();
    const p = await project(o.id);
    const q = await project(o.id);
    const s = await sink(o.id);
    const gone = await sink(o.id);
    for (const [pr, sk] of [
      [p, s],
      [q, s],
      [p, gone],
    ] as const) {
      await setSubscriptions(t.db, {
        organizationId: o.id,
        projectId: pr.id,
        sinkId: sk.id,
        events: ["stack.drift"],
      });
    }
    expect(await deleteSink(t.db, o.id, gone.id)).toBe(true);
    expect((await listSubscriptions(t.db, o.id, p.id, { limit: 10 })).map((r) => r.sinkId)).toEqual(
      [s.id],
    );
    await deleteProject(t.db, o.id, q.id);
    expect(await listSubscriptions(t.db, o.id, q.id, { limit: 10 })).toEqual([]);
    expect(await getSink(t.db, o.id, s.id)).toBeDefined();
  });

  test("a page continues after the last sink and event it ended on", async () => {
    const o = await org();
    const p = await project(o.id);
    const sinks = [await sink(o.id), await sink(o.id), await sink(o.id)];
    for (const s of sinks) {
      await setSubscriptions(t.db, {
        organizationId: o.id,
        projectId: p.id,
        sinkId: s.id,
        events: ["stack.drift"],
      });
    }
    const first = await listSubscriptions(t.db, o.id, p.id, { limit: 2 });
    const last = first.at(-1);
    const rest = await listSubscriptions(t.db, o.id, p.id, {
      after: last && [last.sinkId, last.event],
      limit: 2,
    });
    expect([...first, ...rest].map((r) => r.sinkId)).toEqual(sinks.map((s) => s.id));
  });
});

describe("telling the subscribers of a drifted stack", () => {
  const news = (o: { id: string }, p: { id: string }, over: object = {}) => ({
    organizationId: o.id,
    projectId: p.id,
    stack: "net",
    status: "drifted" as const,
    add: 1,
    change: 2,
    destroy: 3,
    at: new Date(Date.UTC(2026, 9, 18, 12)),
    ...over,
  });
  const queued = () => t.db.select().from(jobs).where(eq(jobs.queue, NOTIFY_QUEUE));

  test("one delivery per subscribed sink of that project, as ids and counts and nothing else", async () => {
    const o = await org();
    const p = await project(o.id, "api");
    const other = await project(o.id);
    const hears = await sink(o.id, { name: "a" });
    const alsoHears = await sink(o.id, { name: "b", kind: "webhook" });
    const deaf = await sink(o.id, { name: "c" });
    const otherOnly = await sink(o.id, { name: "d" });
    const sub = (project: { id: string }, s: { id: string }) =>
      setSubscriptions(t.db, {
        organizationId: o.id,
        projectId: project.id,
        sinkId: s.id,
        events: ["stack.drift"],
      });
    await sub(p, hears);
    await sub(p, alsoHears);
    await sub(other, otherOnly);
    void deaf;
    const before = (await queued()).length;

    expect(await t.db.transaction((tx) => notifyStackDrift(tx, news(o, p)))).toBe(2);

    const added = (await queued()).slice(before);
    expect(added.map((j) => (j.payload as { sinkId: string }).sinkId).sort()).toEqual(
      [hears.id, alsoHears.id].sort(),
    );
    for (const job of added) {
      expect(job.payload).toEqual({
        sinkId: expect.any(String),
        organizationId: o.id,
        event: "stack.drift",
        projectId: p.id,
        projectName: "api",
        stack: "net",
        status: "drifted",
        add: 1,
        change: 2,
        destroy: 3,
        at: "2026-10-18T12:00:00.000Z",
      });
      expect(job.maxAttempts).toBeGreaterThanOrEqual(8);
      expect(JSON.stringify(job)).not.toContain("SECRETSECRET");
    }
  });

  test("nobody subscribed, nothing queued; a rolled-back change queues nothing", async () => {
    const o = await org();
    const p = await project(o.id);
    const s = await sink(o.id);
    const before = (await queued()).length;
    expect(await t.db.transaction((tx) => notifyStackDrift(tx, news(o, p)))).toBe(0);
    await setSubscriptions(t.db, {
      organizationId: o.id,
      projectId: p.id,
      sinkId: s.id,
      events: ["stack.drift"],
    });
    await t.db
      .transaction(async (tx) => {
        await notifyStackDrift(tx, news(o, p));
        throw new Error("rolled back");
      })
      .catch(() => undefined);
    expect((await queued()).length).toBe(before);
  });
});

describe("telling the subscribers of a rotation that keeps failing", () => {
  const news = (o: { id: string }, p: { id: string }) => ({
    organizationId: o.id,
    projectId: p.id,
    key: "DB_PASSWORD",
    provider: "gitlab-token",
    attempts: 3,
    at: new Date(Date.UTC(2026, 9, 19, 8)),
  });
  const queued = () => t.db.select().from(jobs).where(eq(jobs.queue, NOTIFY_QUEUE));

  test("only the sinks that asked for this event hear of it, as names and a count", async () => {
    const o = await org();
    const p = await project(o.id, "api");
    const hears = await sink(o.id, { name: "a" });
    const driftOnly = await sink(o.id, { name: "b" });
    const sub = (s: { id: string }, events: ("stack.drift" | "rotation.failing")[]) =>
      setSubscriptions(t.db, { organizationId: o.id, projectId: p.id, sinkId: s.id, events });
    await sub(hears, ["rotation.failing"]);
    await sub(driftOnly, ["stack.drift"]);
    const before = (await queued()).length;

    expect(await t.db.transaction((tx) => notifyRotationFailing(tx, news(o, p)))).toBe(1);

    const [job, ...more] = (await queued()).slice(before);
    expect(more).toEqual([]);
    expect(job?.payload).toEqual({
      sinkId: hears.id,
      organizationId: o.id,
      event: "rotation.failing",
      projectId: p.id,
      projectName: "api",
      key: "DB_PASSWORD",
      provider: "gitlab-token",
      attempts: 3,
      at: "2026-10-19T08:00:00.000Z",
    });
    expect(JSON.stringify(job)).not.toContain("SECRETSECRET");
  });

  test("a stack's drift does not reach a sink that only asked about rotations", async () => {
    const o = await org();
    const p = await project(o.id);
    const s = await sink(o.id);
    await setSubscriptions(t.db, {
      organizationId: o.id,
      projectId: p.id,
      sinkId: s.id,
      events: ["rotation.failing"],
    });
    const stack = { stack: "net", status: "drifted" as const, add: 1, change: 0, destroy: 0 };
    expect(
      await t.db.transaction((tx) =>
        notifyStackDrift(tx, { organizationId: o.id, projectId: p.id, at: new Date(), ...stack }),
      ),
    ).toBe(0);
  });
});
