import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { sql } from "drizzle-orm";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import {
  claimDue,
  claimOne,
  clearRevoked,
  completeRotation,
  dropRotationOf,
  dueRevocations,
  failRotation,
  getRotation,
  listRotations,
  type RotationInput,
  removeRotation,
  setRotation,
} from "./rotations";
import { variableRotations } from "./schema";
import { createTestDb, type TestDb } from "./testing";
import { createVariable, deleteVariable, type Scope } from "./variables";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});
// claimDue takes whatever is due, so a row left by an earlier test would be handed to this one
beforeEach(async () => {
  await t.db.delete(variableRotations);
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const actor = { kind: "user", id: "u1" };
const T0 = new Date("2026-03-01T00:00:00Z");
const days = (n: number, from = T0) => new Date(from.getTime() + n * 86_400_000);

let n = 0;
const world = async () => {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${n}` });
  const at: Scope = { organizationId: org.id, projectId: project.id };
  return { org, project, at };
};
const secret = (at: Scope, kind: "secret" | "plain" = "secret") =>
  createVariable(t.db, keys, { ...at, key: `K${++n}`, kind, value: "v", actor });
const input = (organizationId: string, variableId: string, over: Partial<RotationInput> = {}) => ({
  organizationId,
  variableId,
  provider: "random",
  config: {},
  intervalDays: 30,
  graceDays: 0,
  now: T0,
  ...over,
});
const set = async (o: string, v: string, over: Partial<RotationInput> = {}) => {
  const r = await setRotation(t.db, input(o, v, over));
  if ("error" in r) throw new Error(r.error);
  return r.row;
};
const refusedBy = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return pgConstraint(e) ?? e;
  }
  return undefined;
};

describe("setting a rotation", () => {
  test("is due one interval from now; the same interval again keeps its place, a new one counts from now", async () => {
    const w = await world();
    const v = await secret(w.at);
    const first = await set(w.org.id, v.id);
    expect(first).toMatchObject({ lastStatus: "never", attempts: 0, handle: null, enabled: true });
    expect(first.nextAt).toEqual(days(30));

    const same = await set(w.org.id, v.id, { now: days(5), config: { length: 40 }, graceDays: 3 });
    expect(same).toMatchObject({ id: first.id, graceDays: 3, config: { length: 40 } });
    expect(same.nextAt).toEqual(days(30));

    const changed = await set(w.org.id, v.id, { now: days(5), intervalDays: 7 });
    expect(changed.id).toBe(first.id);
    expect(changed.nextAt).toEqual(days(12));
  });

  test("a changed provider forgets the old provider's credential name", async () => {
    const w = await world();
    const v = await secret(w.at);
    const row = await set(w.org.id, v.id, { provider: "gitlab-token" });
    await t.db.update(variableRotations).set({ handle: "tok-1" });
    const again = await set(w.org.id, v.id, { provider: "gitlab-token" });
    expect(again.handle).toBe("tok-1");
    expect((await set(w.org.id, v.id, { provider: "random" })).handle).toBeNull();
    expect(row.id).toBe(again.id);
  });

  test("only a live secret variable of that organization can rotate", async () => {
    const a = await world();
    const b = await world();
    const plain = await secret(a.at, "plain");
    const gone = await secret(a.at);
    await deleteVariable(t.db, a.at, gone.id);
    const mine = await secret(a.at);
    const miss = (o: string, v: string) => setRotation(t.db, input(o, v));
    expect(await miss(a.org.id, plain.id)).toEqual({ error: "not_secret" });
    expect(await miss(a.org.id, gone.id)).toEqual({ error: "not_found" });
    expect(await miss(b.org.id, mine.id)).toEqual({ error: "not_found" });
    expect(await miss(a.org.id, crypto.randomUUID())).toEqual({ error: "not_found" });
    expect(await getRotation(t.db, b.org.id, mine.id)).toBeUndefined();
  });

  test("a row cannot name another organization's variable even by hand", async () => {
    const a = await world();
    const b = await world();
    const v = await secret(a.at);
    const bad = t.db.insert(variableRotations).values({
      organizationId: b.org.id,
      variableId: v.id,
      provider: "random",
      intervalDays: 30,
      nextAt: T0,
    });
    expect(await refusedBy(bad)).toBe("variable_rotations_variable_org_fk");
  });

  test("the table refuses a bad interval, grace, provider, config and handle", async () => {
    const w = await world();
    const v = await secret(w.at);
    const bad = (over: Partial<RotationInput>) => setRotation(t.db, input(w.org.id, v.id, over));
    expect(await refusedBy(bad({ intervalDays: 0 }))).toBe("variable_rotations_interval_check");
    expect(await refusedBy(bad({ intervalDays: 366 }))).toBe("variable_rotations_interval_check");
    expect(await refusedBy(bad({ intervalDays: 10, graceDays: 11 }))).toBe(
      "variable_rotations_interval_check",
    );
    expect(await refusedBy(bad({ provider: "Random!" }))).toBe("variable_rotations_provider_check");
    expect(await refusedBy(bad({ config: { x: "y".repeat(2000) } }))).toBe(
      "variable_rotations_config_check",
    );
    const row = await set(w.org.id, v.id);
    const patch = (set: Partial<typeof variableRotations.$inferInsert>) =>
      t.db.update(variableRotations).set(set).where(sql`id = ${row.id}`);
    expect(await refusedBy(patch({ handle: "has space" }))).toBe("variable_rotations_handle_check");
    expect(await refusedBy(patch({ previousHandle: "tok-1" }))).toBe(
      "variable_rotations_handle_check",
    );
    expect(await refusedBy(patch({ lastError: "Some provider text with a secret" }))).toBe(
      "variable_rotations_status_check",
    );
    expect(await refusedBy(patch({ lastStatus: "great" as never }))).toBe(
      "variable_rotations_status_check",
    );
  });

  test("another organization sees nothing: get and list are scoped", async () => {
    const a = await world();
    const b = await world();
    const v = await secret(a.at);
    await set(a.org.id, v.id);
    expect(await getRotation(t.db, b.org.id, v.id)).toBeUndefined();
    expect(await listRotations(t.db, b.org.id, { limit: 10 })).toEqual([]);
    expect((await listRotations(t.db, a.org.id, { limit: 10 })).map((r) => r.variableId)).toEqual([
      v.id,
    ]);
    expect(await removeRotation(t.db, b.org.id, v.id)).toBe("none");
    expect(await removeRotation(t.db, a.org.id, v.id)).toBe("removed");
    expect(await removeRotation(t.db, a.org.id, v.id)).toBe("none");
  });

  test("a rotation whose replaced credential is still valid is not removed", async () => {
    const w = await world();
    const v = await secret(w.at);
    await set(w.org.id, v.id);
    await t.db
      .update(variableRotations)
      .set({ handle: "h2", previousHandle: "h1", revokeAt: days(5) })
      .where(sql`variable_id = ${v.id}`);
    expect(await removeRotation(t.db, w.org.id, v.id)).toBe("revoke_pending");
    expect((await getRotation(t.db, w.org.id, v.id))?.previousHandle).toBe("h1");
  });

  test("a change is checked against the rotation as it stands, and a refusal writes nothing", async () => {
    const w = await world();
    const v = await secret(w.at);
    const seen: (string | undefined)[] = [];
    const first = await setRotation(t.db, input(w.org.id, v.id), (e) => {
      seen.push(e?.provider);
    });
    expect("row" in first).toBe(true);
    await expect(
      setRotation(t.db, input(w.org.id, v.id, { provider: "other", intervalDays: 9 }), (e) => {
        seen.push(e?.provider);
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(seen).toEqual([undefined, "random"]);
    expect(await getRotation(t.db, w.org.id, v.id)).toMatchObject({
      provider: "random",
      intervalDays: 30,
    });
  });
});

describe("a config the change reads from the stored one", () => {
  test("what the check returns is stored in place of the input's, read once the variable is held", async () => {
    const w = await world();
    const v = await secret(w.at);
    await set(w.org.id, v.id, { config: { tokenId: 1 } });
    // a rotation moves its own config on (a new token id) after the caller read it
    await t.db
      .update(variableRotations)
      .set({ config: { tokenId: 2 } })
      .where(sql`variable_id = ${v.id}`);
    const stale = { tokenId: 1 };
    const res = await setRotation(
      t.db,
      input(w.org.id, v.id, { config: stale, intervalDays: 9 }),
      (existing) => existing?.config,
    );
    expect("row" in res && res.row).toMatchObject({ intervalDays: 9, config: { tokenId: 2 } });
    // a check that returns nothing leaves the input's config in force
    await setRotation(t.db, input(w.org.id, v.id, { config: { tokenId: 5 } }), () => {});
    expect((await getRotation(t.db, w.org.id, v.id))?.config).toEqual({ tokenId: 5 });
  });
});

describe("what happens to a rotation when its variable goes", () => {
  test("deleting the variable deletes the rotation; so does removing its project", async () => {
    const w = await world();
    const v = await secret(w.at);
    await set(w.org.id, v.id);
    expect(await deleteVariable(t.db, w.at, v.id)).toBe(true);
    expect(await getRotation(t.db, w.org.id, v.id)).toBeUndefined();

    const w2 = await world();
    const v2 = await secret(w2.at);
    await set(w2.org.id, v2.id);
    await deleteProject(t.db, w2.org.id, w2.project.id);
    expect(await getRotation(t.db, w2.org.id, v2.id)).toBeUndefined();
  });

  test("a credential still awaiting its revoke is not forgotten: the rotation is switched off and kept", async () => {
    const w = await world();
    const v = await secret(w.at);
    const row = await set(w.org.id, v.id, { graceDays: 3 });
    await t.db
      .update(variableRotations)
      .set({ previousHandle: "tok-old", revokeAt: days(3), nextAt: T0 })
      .where(sql`id = ${row.id}`);
    await deleteVariable(t.db, w.at, v.id);
    const kept = await getRotation(t.db, w.org.id, v.id);
    expect(kept).toMatchObject({ enabled: false, previousHandle: "tok-old" });
    // and it is never handed out for a new rotation
    expect(await claimDue(t.db, { now: days(400) })).toEqual([]);
    await dropRotationOf(t.db, v.id);
    expect(await getRotation(t.db, w.org.id, v.id)).toBeDefined();
  });
});

describe("claiming due rotations", () => {
  test("hands out only enabled rotations of live variables that are due, oldest first, and holds them for the lease", async () => {
    const w = await world();
    const vs = await Promise.all([secret(w.at), secret(w.at), secret(w.at), secret(w.at)]);
    const [soon, later, off, gone] = vs;
    if (!soon || !later || !off || !gone) throw new Error("setup");
    const a = await set(w.org.id, soon.id, { intervalDays: 1 });
    const b = await set(w.org.id, later.id, { intervalDays: 2 });
    await set(w.org.id, off.id, { intervalDays: 1, enabled: false });
    await set(w.org.id, gone.id, { intervalDays: 1 });
    // a soft-deleted variable whose rotation is kept for a revoke
    await t.db
      .update(variableRotations)
      .set({ previousHandle: "x", revokeAt: T0 })
      .where(sql`id = ${(await getRotation(t.db, w.org.id, gone.id))?.id}`);
    await deleteVariable(t.db, w.at, gone.id);

    expect(await claimDue(t.db, { now: days(0), limit: 10 })).toEqual([]);
    const first = await claimDue(t.db, { now: days(2), limit: 10, leaseMs: 60_000 });
    const mine = first.filter((r) => r.organizationId === w.org.id);
    expect(mine.map((r) => r.id)).toEqual([a.id, b.id].sort());
    // held: not handed out again within the lease, and again after it
    expect(await claimDue(t.db, { now: days(2), limit: 10 })).toEqual([]);
    const after = await claimDue(t.db, { now: new Date(days(2).getTime() + 61_000), limit: 10 });
    expect(after.map((r) => r.id).sort()).toEqual(mine.map((r) => r.id).sort());
  });

  test("two workers claiming at once never get the same rotation, and between them get them all", async () => {
    const w = await world();
    const made: string[] = [];
    for (let i = 0; i < 24; i++) {
      const v = await secret(w.at);
      made.push((await set(w.org.id, v.id, { intervalDays: 1 })).id);
    }
    const claim = () => claimDue(t.db, { now: days(2), limit: 10 });
    const [x, y, z] = await Promise.all([claim(), claim(), claim()]);
    const all = [...(x ?? []), ...(y ?? []), ...(z ?? [])].map((r) => r.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((id) => made.includes(id)).length).toBeLessThanOrEqual(24);
    const rest = (await claimDue(t.db, { now: days(2), limit: 100 })).map((r) => r.id);
    expect([...all, ...rest].filter((id) => made.includes(id)).sort()).toEqual([...made].sort());
  });

  test("one rotation can be taken now, due or not, with the same lease and fence", async () => {
    const w = await world();
    const other = await world();
    const v = await secret(w.at);
    const off = await secret(w.at);
    const gone = await secret(w.at);
    const row = await set(w.org.id, v.id, { intervalDays: 30 });
    const idle = await set(w.org.id, off.id, { enabled: false });
    await set(w.org.id, gone.id);
    await deleteVariable(t.db, w.at, gone.id);

    const first = await claimOne(t.db, w.org.id, v.id, { now: days(1), leaseMs: 60_000 });
    expect(first).toMatchObject({ id: row.id });
    expect(first?.nextAt).toEqual(new Date(days(1).getTime() + 60_000));
    // a disabled one is taken too (a person asked); a deleted variable, another organization and no rotation are not
    expect((await claimOne(t.db, w.org.id, off.id, { now: days(1) }))?.id).toBe(idle.id);
    expect(await claimOne(t.db, w.org.id, gone.id)).toBeUndefined();
    expect(await claimOne(t.db, other.org.id, v.id)).toBeUndefined();
    expect(await claimOne(t.db, w.org.id, crypto.randomUUID())).toBeUndefined();

    // taking it again fences the first claim out: only one run can finish
    const second = await claimOne(t.db, w.org.id, v.id, { now: days(1), leaseMs: 120_000 });
    if (!first || !second) throw new Error("not claimed");
    expect(await completeRotation(t.db, first, { handle: "stale", now: days(1) })).toBe(false);
    expect(await completeRotation(t.db, second, { handle: "kept", now: days(1) })).toBe(true);
    expect((await getRotation(t.db, w.org.id, v.id))?.handle).toBe("kept");
  });

  test("a claim made on the database clock can be finished: its lease survives a trip through a JS date", async () => {
    const w = await world();
    const v = await secret(w.at);
    const row = await set(w.org.id, v.id, { intervalDays: 1 });
    // due now, by the database's own clock (microseconds), not a test's whole-millisecond one
    await t.db
      .update(variableRotations)
      .set({ nextAt: sql`now() - interval '1 second'` })
      .where(sql`id = ${row.id}`);
    const [byDue] = (await claimDue(t.db, { limit: 100 })).filter((r) => r.id === row.id);
    if (!byDue) throw new Error("not claimed");
    expect(await completeRotation(t.db, byDue, { handle: "h1" })).toBe(true);
    const byNow = await claimOne(t.db, w.org.id, v.id);
    if (!byNow) throw new Error("not claimed");
    expect(
      await failRotation(t.db, byNow, { code: "failed", retryAt: days(9), failing: false }),
    ).toBe(true);
  });

  test("only the claim holder can finish: a stale claim cannot complete or fail over the next one", async () => {
    const w = await world();
    const v = await secret(w.at);
    const row = await set(w.org.id, v.id, { intervalDays: 1 });
    const [slow] = (await claimDue(t.db, { now: days(2), leaseMs: 1000 })).filter(
      (r) => r.id === row.id,
    );
    if (!slow) throw new Error("not claimed");
    const [quick] = (
      await claimDue(t.db, { now: new Date(days(2).getTime() + 5000), leaseMs: 60_000 })
    ).filter((r) => r.id === row.id);
    if (!quick) throw new Error("not re-claimed");

    expect(await completeRotation(t.db, slow, { handle: "tok-stale", now: days(2) })).toBe(false);
    expect(
      await failRotation(t.db, slow, { code: "failed", retryAt: days(3), failing: false }),
    ).toBe(false);
    expect((await getRotation(t.db, w.org.id, v.id))?.handle).toBeNull();

    expect(
      await completeRotation(t.db, quick, {
        handle: "tok-2",
        config: { tokenId: 2 },
        previousHandle: "tok-1",
        revokeAt: days(5),
        now: days(2),
      }),
    ).toBe(true);
    expect(await getRotation(t.db, w.org.id, v.id)).toMatchObject({
      handle: "tok-2",
      config: { tokenId: 2 },
      previousHandle: "tok-1",
      lastStatus: "ok",
      lastError: null,
      attempts: 0,
    });
    expect((await getRotation(t.db, w.org.id, v.id))?.nextAt).toEqual(days(3));
  });

  test("a failure keeps the old handle, counts the attempt, says why with a code, and retries later", async () => {
    const w = await world();
    const v = await secret(w.at);
    const row = await set(w.org.id, v.id, { intervalDays: 1 });
    await t.db.update(variableRotations).set({ handle: "tok-1" }).where(sql`id = ${row.id}`);
    for (let i = 1; i <= 2; i++) {
      const [claimed] = (await claimDue(t.db, { now: days(1 + i * 2), leaseMs: 1000 })).filter(
        (r) => r.id === row.id,
      );
      if (!claimed) throw new Error("not claimed");
      expect(
        await failRotation(t.db, claimed, {
          code: "denied",
          retryAt: days(2 + i * 2),
          failing: i === 2,
          now: days(1 + i * 2),
        }),
      ).toBe(true);
      expect(await getRotation(t.db, w.org.id, v.id)).toMatchObject({
        handle: "tok-1",
        attempts: i,
        lastError: "denied",
        lastStatus: i === 2 ? "failing" : "never",
      });
    }
  });
});

describe("revocations that are due", () => {
  test("lists replaced credentials whose time has come, oldest first, and not the ones still in grace", async () => {
    const { org, at } = await world();
    const mk = async (revokeInDays: number | null, previousHandle: string | null) => {
      const v = await secret(at);
      const r = await set(org.id, v.id);
      const claimed = (await claimDue(t.db, { now: days(31), limit: 100 })).find(
        (c) => c.id === r.id,
      );
      if (!claimed) throw new Error("not claimed");
      await completeRotation(t.db, claimed, {
        handle: "h",
        ...(previousHandle && { previousHandle, revokeAt: days(revokeInDays ?? 0) }),
        now: days(31),
      });
      return r.id;
    };
    const late = await mk(34, "old-late");
    const early = await mk(33, "old-early");
    const grace = await mk(40, "old-grace");
    await mk(null, null);
    void grace;

    const due = await dueRevocations(t.db, { now: days(35) });
    expect(due.map((r) => [r.id, r.previousHandle])).toEqual([
      [early, "old-early"],
      [late, "old-late"],
    ]);
    expect(await dueRevocations(t.db, { now: days(35), limit: 1 })).toHaveLength(1);
  });
});

describe("what a finished or changed rotation leaves alone", () => {
  test("finishing without a replaced credential keeps the one still waiting to be revoked", async () => {
    const w = await world();
    const v = await secret(w.at);
    const row = await set(w.org.id, v.id, { graceDays: 3 });
    await t.db
      .update(variableRotations)
      .set({ previousHandle: "tok-old", revokeAt: days(3), nextAt: T0 })
      .where(sql`id = ${row.id}`);
    const claimed = (await claimDue(t.db, { now: days(1) })).find((r) => r.id === row.id);
    if (!claimed) throw new Error("not claimed");
    // a cycle that finds a change request still open records only that it is waiting
    expect(
      await completeRotation(t.db, claimed, {
        handle: claimed.handle,
        status: "pending_approval",
        now: days(1),
      }),
    ).toBe(true);
    const kept = await getRotation(t.db, w.org.id, v.id);
    expect(kept).toMatchObject({ previousHandle: "tok-old", lastStatus: "pending_approval" });
    expect(kept?.revokeAt).toEqual(days(3));
  });

  test("a corrected config clears the failure and tries again now; the same config does not", async () => {
    const w = await world();
    const v = await secret(w.at);
    const row = await set(w.org.id, v.id, { provider: "gitlab-token", config: { tokenId: 1 } });
    await t.db
      .update(variableRotations)
      .set({ attempts: 3, lastStatus: "failing", lastError: "failed", nextAt: days(40) })
      .where(sql`id = ${row.id}`);
    const same = await set(w.org.id, v.id, {
      provider: "gitlab-token",
      config: { tokenId: 1 },
      now: days(10),
    });
    expect(same).toMatchObject({ attempts: 3, lastStatus: "failing", lastError: "failed" });
    expect(same.nextAt).toEqual(days(40));

    const fixed = await set(w.org.id, v.id, {
      provider: "gitlab-token",
      config: { tokenId: 2 },
      now: days(10),
    });
    expect(fixed).toMatchObject({ attempts: 0, lastStatus: "never", lastError: null });
    expect(fixed.nextAt).toEqual(days(10));
  });

  test("a rotation switched back on counts its interval from now, not from when it was switched off", async () => {
    const w = await world();
    const v = await secret(w.at);
    await set(w.org.id, v.id);
    expect((await set(w.org.id, v.id, { enabled: false, now: days(5) })).nextAt).toEqual(days(30));
    const on = await set(w.org.id, v.id, { enabled: true, now: days(100) });
    expect(on.nextAt).toEqual(days(130));
  });

  test("deleting a variable hands its current credential to the revoke sweep, and the row goes once it is revoked", async () => {
    const w = await world();
    const v = await secret(w.at);
    const row = await set(w.org.id, v.id);
    await t.db.update(variableRotations).set({ handle: "tok-9" }).where(sql`id = ${row.id}`);
    await deleteVariable(t.db, w.at, v.id);
    const left = await getRotation(t.db, w.org.id, v.id);
    expect(left).toMatchObject({ enabled: false, handle: null, previousHandle: "tok-9" });
    expect((await dueRevocations(t.db)).map((r) => r.previousHandle)).toContain("tok-9");

    expect(await clearRevoked(t.db, row.id, "tok-9")).toBe(true);
    expect(await getRotation(t.db, w.org.id, v.id)).toBeUndefined();
  });

  test("a rotation whose variable lives on keeps its row when a replaced credential is revoked", async () => {
    const w = await world();
    const v = await secret(w.at);
    const row = await set(w.org.id, v.id, { graceDays: 3 });
    await t.db
      .update(variableRotations)
      .set({ handle: "tok-2", previousHandle: "tok-1", revokeAt: days(3) })
      .where(sql`id = ${row.id}`);
    await t.db.update(variableRotations).set({ enabled: false }).where(sql`id = ${row.id}`);
    expect(await clearRevoked(t.db, row.id, "tok-1")).toBe(true);
    expect(await getRotation(t.db, w.org.id, v.id)).toMatchObject({
      handle: "tok-2",
      previousHandle: null,
    });
  });
});
