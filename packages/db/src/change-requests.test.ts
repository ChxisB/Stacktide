import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BulkOp } from "@orch/core";
import { CryptoError, envKeyProvider } from "@orch/crypto";
import { eq, sql } from "drizzle-orm";
import {
  approveChangeRequest,
  createChangeRequest,
  expireChangeRequests,
  getChangeRequest,
  listChangeRequests,
  type Person,
  rejectChangeRequest,
} from "./change-requests";
import { pgCode } from "./pg-error";
import {
  createEnvironment,
  createOrganization,
  createProject,
  deleteEnvironment,
  type Executor,
  lockEnvironment,
  setEnvironmentProtection,
} from "./repo";
import { changeRequests, variables, variableVersions } from "./schema";
import { createTestDb, type TestDb } from "./testing";
import {
  createVariable,
  listVariables,
  listVersions,
  openPending,
  revealVariable,
  type Scope,
} from "./variables";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const CANARY = "s3cr3t-CANARY-value-0123456789";
const DAY = 86_400_000;
const person = (id: string): Person => ({ kind: "user", id, ref: `user:${id}` });
const author = person("author");
const approver = person("approver");

let n = 0;
const world = async () => {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${n}` });
  const env = await createEnvironment(t.db, {
    organizationId: org.id,
    projectId: project.id,
    name: "Prod",
    slug: "prod",
  });
  const other = await createEnvironment(t.db, {
    organizationId: org.id,
    projectId: project.id,
    name: "Dev",
    slug: "dev",
  });
  const at = { organizationId: org.id, projectId: project.id, environmentId: env.id };
  return { org, project, env, other, at, scope: at as Scope };
};
type World = Awaited<ReturnType<typeof world>>;

const propose = (w: World, ops: BulkOp[], over: { expiresAt?: Date; by?: Person } = {}) =>
  createChangeRequest(t.db, keys, {
    ...w.at,
    ops,
    author: over.by ?? author,
    expiresAt: over.expiresAt ?? new Date(Date.now() + 7 * DAY),
  });
const approve = (w: World, id: string, by: Person = approver) =>
  t.db.transaction((tx) => approveChangeRequest(tx, keys, w.at, id, by));
const values = async (w: World) =>
  Object.fromEntries(
    await Promise.all(
      (await listVariables(t.db, keys, w.scope, { limit: 100 })).map(
        async (v) => [v.key, (await revealVariable(t.db, keys, w.scope, v.id))?.value] as const,
      ),
    ),
  );
const rowOf = async (id: string) =>
  (await t.db.select().from(changeRequests).where(eq(changeRequests.id, id)))[0];

/** Runs `work` in a transaction that stays open until `release()`; `ready` is the moment `work` has run. */
const holding = <T>(work: (tx: Executor) => Promise<T>) => {
  let release = () => {};
  const open = new Promise<void>((r) => {
    release = r;
  });
  let started = () => {};
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const done = t.db.transaction(async (tx) => {
    const out = await work(tx);
    started();
    await open;
    return out;
  });
  return { ready: Promise.race([ready, done]).then(() => undefined), release, done };
};

describe("createChangeRequest", () => {
  test("seals the edits and keeps names and actions in the open", async () => {
    const w = await world();
    const cr = await propose(w, [
      { op: "set", key: "DB_PASSWORD", kind: "secret", value: CANARY },
      { op: "delete", key: "OLD" },
    ]);
    expect(cr.status).toBe("open");
    expect(cr.kind).toBe("variables");
    expect(cr.diff).toEqual([
      { action: "set", key: "DB_PASSWORD", kind: "secret" },
      { action: "delete", key: "OLD" },
    ]);
    expect(cr.authorRef).toBe("user:author");
    expect(JSON.stringify(cr)).not.toContain(CANARY);
    // nothing was written to the variables
    expect(await values(w)).toEqual({});
    // the stored row: the value is in no column in the clear, and the sealed bytes do not contain it
    const row = await rowOf(cr.id);
    expect(JSON.stringify(row?.diff)).not.toContain(CANARY);
    expect(Buffer.from(row?.opsEnc ?? []).includes(Buffer.from(CANARY))).toBe(false);
    expect(Buffer.from(row?.opsEnc ?? []).length).toBeGreaterThan(CANARY.length);
    const text = await t.db.execute(
      sql`select row_to_json(c)::text as j from change_requests c where id = ${cr.id}`,
    );
    expect(JSON.stringify(text)).not.toContain(CANARY);
  });

  test("the sealed edits open only for this request", async () => {
    const w = await world();
    const a = await propose(w, [{ op: "set", key: "A", value: CANARY }]);
    const b = await propose(w, [{ op: "set", key: "B", value: "x" }]);
    const blob = (await rowOf(a.id))?.opsEnc as Uint8Array;
    expect(await openPending(t.db, keys, { ...w.at, id: a.id }, blob)).toEqual([
      { op: "set", key: "A", value: CANARY },
    ]);
    const swap = openPending(t.db, keys, { ...w.at, id: b.id }, blob);
    await expect(swap).rejects.toBeInstanceOf(CryptoError);
    const moved = openPending(t.db, keys, { ...w.at, environmentId: w.other.id, id: a.id }, blob);
    await expect(moved).rejects.toBeInstanceOf(CryptoError);
  });

  test("a request for an environment of another project is refused by the database", async () => {
    const w = await world();
    const w2 = await world();
    const bad = createChangeRequest(t.db, keys, {
      organizationId: w.org.id,
      projectId: w.project.id,
      environmentId: w2.env.id,
      ops: [{ op: "delete", key: "X" }],
      author,
      expiresAt: new Date(Date.now() + DAY),
    });
    await expect(bad).rejects.toThrow();
  });
});

describe("reading", () => {
  test("get and list stay inside the environment, newest first, by status, paged", async () => {
    const w = await world();
    const w2 = await world();
    const a = await propose(w, [{ op: "delete", key: "A" }]);
    const b = await propose(w, [{ op: "delete", key: "B" }]);
    const c = await propose(w, [{ op: "delete", key: "C" }]);
    await propose(w2, [{ op: "delete", key: "Z" }]);
    await t.db.transaction((tx) => rejectChangeRequest(tx, w.at, b.id, approver));

    expect((await getChangeRequest(t.db, w.at, a.id))?.id).toBe(a.id);
    expect(await getChangeRequest(t.db, w2.at, a.id)).toBeUndefined();
    expect(
      await getChangeRequest(t.db, { ...w.at, environmentId: w.other.id }, a.id),
    ).toBeUndefined();
    expect(
      await getChangeRequest(t.db, { ...w.at, organizationId: w2.org.id }, a.id),
    ).toBeUndefined();

    const all = await listChangeRequests(t.db, w.at, {}, { limit: 10 });
    expect(all.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    const open = await listChangeRequests(t.db, w.at, { status: "open" }, { limit: 10 });
    expect(open.map((r) => r.id)).toEqual([c.id, a.id]);
    const first = await listChangeRequests(t.db, w.at, {}, { limit: 2 });
    expect(first.map((r) => r.id)).toEqual([c.id, b.id]);
    const next = await listChangeRequests(t.db, w.at, {}, { limit: 2, after: [b.id] });
    expect(next.map((r) => r.id)).toEqual([a.id]);
    expect(JSON.stringify(all)).not.toContain("opsEnc");
  });
});

describe("approveChangeRequest", () => {
  test("another person approves: the edits are applied as them, the request is closed and unsealed", async () => {
    const w = await world();
    const kept = await createVariable(t.db, keys, {
      ...w.scope,
      key: "KEEP",
      kind: "plain",
      value: "same",
      actor: { kind: "user", id: "someone" },
    });
    await createVariable(t.db, keys, {
      ...w.scope,
      key: "OLD_NAME",
      kind: "plain",
      value: "v",
      actor: { kind: "user", id: "someone" },
    });
    const cr = await propose(w, [
      { op: "set", key: "NEW_SECRET", kind: "secret", value: CANARY },
      { op: "set", key: "KEEP", value: "changed" },
      { op: "rename", key: "OLD_NAME", to: "NEW_NAME" },
    ]);

    const r = await approve(w, cr.id);
    expect(r.result).toBe("applied");
    if (r.result !== "applied") return;
    expect(r.changes.map((c) => [c.change, c.key, c.applied]).sort()).toEqual([
      ["create", "NEW_SECRET", true],
      ["rename", "OLD_NAME", true],
      ["update", "KEEP", true],
    ]);
    expect(await values(w)).toEqual({ NEW_SECRET: CANARY, KEEP: "changed", NEW_NAME: "v" });

    // who approved is on the versions, with the request
    const versions = await listVersions(t.db, w.scope, kept.id, { limit: 10 });
    const latest = versions[0];
    expect([latest?.actorKind, latest?.actorId]).toEqual(["user", "approver"]);
    expect(latest?.reason).toBe(`change request ${cr.id}`);

    const row = await rowOf(cr.id);
    expect(row?.status).toBe("applied");
    expect(row?.opsEnc).toBeNull();
    expect([row?.decidedByKind, row?.decidedById, row?.decidedByRef]).toEqual([
      "user",
      "approver",
      "user:approver",
    ]);
    expect(row?.decidedAt).toBeInstanceOf(Date);
    expect(row?.appliedAt).toBeInstanceOf(Date);
    expect(row?.authorRef).toBe("user:author");
    expect(r.request.status).toBe("applied");
  });

  test("the author cannot approve their own request, by any way they sign in", async () => {
    const w = await world();
    const cr = await propose(w, [{ op: "set", key: "K", kind: "plain", value: "v" }]);
    expect(await approve(w, cr.id, author)).toEqual({ result: "self" });
    // the same person through a token: another principal id, the same person
    const viaToken = { kind: "token", id: "tok-1", ref: "user:author" };
    expect(await approve(w, cr.id, viaToken)).toEqual({ result: "self" });
    expect(await values(w)).toEqual({});
    expect((await rowOf(cr.id))?.status).toBe("open");
    expect((await rowOf(cr.id))?.opsEnc).not.toBeNull();
    // a different person can still decide it
    expect((await approve(w, cr.id)).result).toBe("applied");
  });

  test("a request is decided once", async () => {
    const w = await world();
    const done = await propose(w, [{ op: "set", key: "K", kind: "plain", value: "v" }]);
    expect((await approve(w, done.id)).result).toBe("applied");
    expect(await approve(w, done.id)).toEqual({ result: "closed", status: "applied" });

    const no = await propose(w, [{ op: "set", key: "L", kind: "plain", value: "v" }]);
    await t.db.transaction((tx) => rejectChangeRequest(tx, w.at, no.id, approver));
    expect(await approve(w, no.id)).toEqual({ result: "closed", status: "rejected" });
    expect(Object.keys(await values(w))).toEqual(["K"]);
  });

  test("an unknown request, or one of another environment, is not found", async () => {
    const w = await world();
    const cr = await propose(w, [{ op: "set", key: "K", kind: "plain", value: "v" }]);
    expect(await approve(w, crypto.randomUUID())).toEqual({ result: "not_found" });
    const elsewhere = { ...w, at: { ...w.at, environmentId: w.other.id } };
    expect(await approve(elsewhere, cr.id)).toEqual({ result: "not_found" });
    const stranger = await world();
    expect(await approve(stranger, cr.id)).toEqual({ result: "not_found" });
    expect((await rowOf(cr.id))?.status).toBe("open");
  });

  test("past its time it cannot be approved, whether or not the sweep has run", async () => {
    const w = await world();
    const cr = await propose(w, [{ op: "set", key: "K", kind: "plain", value: "v" }], {
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await approve(w, cr.id)).toEqual({ result: "expired" });
    expect(await values(w)).toEqual({});
    expect((await rowOf(cr.id))?.status).toBe("open");
    await t.db.transaction((tx) => expireChangeRequests(tx, 10));
    expect(await approve(w, cr.id)).toEqual({ result: "closed", status: "expired" });
  });

  test("a request that no longer does what was asked stays open and applies nothing", async () => {
    const w = await world();
    const make = (key: string, kind: "plain" | "secret") =>
      createVariable(t.db, keys, { ...w.scope, key, kind, value: "v", actor: author });
    await make("TAKEN", "plain");
    await make("PLAIN", "plain");
    const cases: [string, BulkOp][] = [
      ["a rename onto an existing key", { op: "rename", key: "PLAIN", to: "TAKEN" }],
      ["a rename of a key that is gone", { op: "rename", key: "GONE", to: "FRESH" }],
      ["a set of another kind", { op: "set", key: "PLAIN", kind: "secret", value: "x" }],
    ];
    for (const [, bad] of cases) {
      const cr = await propose(w, [{ op: "set", key: "FINE", kind: "plain", value: "ok" }, bad]);
      const r = await approve(w, cr.id);
      expect(r.result).toBe("conflict");
      if (r.result === "conflict") expect(r.keys.length).toBeGreaterThan(0);
      expect((await rowOf(cr.id))?.status).toBe("open");
      expect(Object.keys(await values(w)).sort()).toEqual(["PLAIN", "TAKEN"]);
    }
  });

  test("a delete of a key that is already gone is done: the rest applies", async () => {
    const w = await world();
    const cr = await propose(w, [
      { op: "delete", key: "GONE" },
      { op: "set", key: "FINE", kind: "plain", value: "ok" },
    ]);
    const r = await approve(w, cr.id);
    expect(r.result).toBe("applied");
    if (r.result === "applied") {
      expect(r.changes.map((c) => [c.key, c.change, c.applied]).sort()).toEqual([
        ["FINE", "create", true],
        ["GONE", "missing", false],
      ]);
    }
    expect(await values(w)).toEqual({ FINE: "ok" });
  });

  test("an edit that would change nothing is not a conflict", async () => {
    const w = await world();
    await createVariable(t.db, keys, {
      ...w.scope,
      key: "SAME",
      kind: "plain",
      value: "v",
      actor: author,
    });
    const cr = await propose(w, [{ op: "set", key: "SAME", value: "v" }]);
    const r = await approve(w, cr.id);
    expect(r.result).toBe("applied");
    if (r.result === "applied") expect(r.changes.map((c) => c.change)).toEqual(["unchanged"]);
  });

  test("applying and closing are one transaction: a failure in the audit that follows leaves the request open", async () => {
    const w = await world();
    const cr = await propose(w, [{ op: "set", key: "K", kind: "plain", value: "v" }]);
    const failed = t.db.transaction(async (tx) => {
      expect((await approveChangeRequest(tx, keys, w.at, cr.id, approver)).result).toBe("applied");
      throw new Error("audit failed");
    });
    await expect(failed).rejects.toThrow("audit failed");
    expect(await values(w)).toEqual({});
    expect((await rowOf(cr.id))?.status).toBe("open");
    expect((await approve(w, cr.id)).result).toBe("applied");
  });

  test("approvals of two requests of one environment take turns: both apply, in order, none trips over the other", async () => {
    const w = await world();
    const first = await propose(w, [{ op: "set", key: "K", kind: "plain", value: "one" }]);
    const second = await propose(w, [{ op: "set", key: "K", kind: "plain", value: "two" }]);
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let started = () => {};
    const going = new Promise<void>((r) => {
      started = r;
    });
    // the first approval stays open until the second has asked to begin
    const a = t.db.transaction(async (tx) => {
      const r = await approveChangeRequest(tx, keys, w.at, first.id, approver);
      started();
      await held;
      return r;
    });
    await going;
    const b = approve(w, second.id, person("third"));
    await Bun.sleep(300);
    release();
    const rs = await Promise.all([a, b]);
    expect(rs.map((r) => r.result)).toEqual(["applied", "applied"]);
    expect(await values(w)).toEqual({ K: "two" });
    const [k] = await listVariables(t.db, keys, w.scope, { limit: 10 });
    expect((await listVersions(t.db, w.scope, k?.id ?? "", { limit: 10 })).length).toBe(2);
  });

  test("two approvals at once: one applies, the other finds it closed", async () => {
    const w = await world();
    const cr = await propose(w, [{ op: "set", key: "K", kind: "plain", value: "v" }]);
    const rs = await Promise.all([approve(w, cr.id), approve(w, cr.id, person("third"))]);
    expect(rs.map((r) => r.result).sort()).toEqual(["applied", "closed"]);
    const versions = await t.db
      .select()
      .from(variableVersions)
      .innerJoin(variables, eq(variables.id, variableVersions.variableId))
      .where(eq(variables.environmentId, w.env.id));
    expect(versions).toHaveLength(1);
  });
});

describe("deciding at the same time", () => {
  const one = async () => {
    const w = await world();
    const cr = await propose(w, [{ op: "set", key: "K", kind: "plain", value: "v" }]);
    return { w, cr };
  };

  test("an approval waits for a rejection that is under way, then finds the request closed", async () => {
    const { w, cr } = await one();
    const rejecting = holding((tx) => rejectChangeRequest(tx, w.at, cr.id, person("third")));
    await rejecting.ready;
    const approving = approve(w, cr.id);
    await Bun.sleep(300);
    rejecting.release();
    expect((await rejecting.done)?.result).toBe("rejected");
    expect(await approving).toEqual({ result: "closed", status: "rejected" });
    expect(await values(w)).toEqual({});
  });

  test("a rejection waits for an approval that is under way, then finds the request closed", async () => {
    const { w, cr } = await one();
    const approving = holding((tx) => approveChangeRequest(tx, keys, w.at, cr.id, approver));
    await approving.ready;
    const rejecting = t.db.transaction((tx) =>
      rejectChangeRequest(tx, w.at, cr.id, person("third")),
    );
    await Bun.sleep(300);
    approving.release();
    expect((await approving.done).result).toBe("applied");
    expect(await rejecting).toEqual({ result: "closed", status: "applied" });
    expect(await values(w)).toEqual({ K: "v" });
  });
});

describe("rejectChangeRequest", () => {
  test("closes the request, drops the sealed edits and applies nothing", async () => {
    const w = await world();
    const cr = await propose(w, [{ op: "set", key: "K", kind: "plain", value: CANARY }]);
    const r = await t.db.transaction((tx) => rejectChangeRequest(tx, w.at, cr.id, approver));
    expect(r?.result).toBe("rejected");
    const row = await rowOf(cr.id);
    expect(row?.status).toBe("rejected");
    expect(row?.opsEnc).toBeNull();
    expect([row?.decidedById, row?.decidedByRef]).toEqual(["approver", "user:approver"]);
    expect(row?.appliedAt).toBeNull();
    expect(await values(w)).toEqual({});
    const again = await t.db.transaction((tx) => rejectChangeRequest(tx, w.at, cr.id, approver));
    expect(again).toEqual({ result: "closed", status: "rejected" });
  });

  test("an unknown request, or one of another environment, is not found", async () => {
    const w = await world();
    const cr = await propose(w, [{ op: "delete", key: "K" }]);
    const none = await t.db.transaction((tx) =>
      rejectChangeRequest(tx, w.at, crypto.randomUUID(), approver),
    );
    expect(none).toBeUndefined();
    const other = { ...w.at, environmentId: w.other.id };
    expect(
      await t.db.transaction((tx) => rejectChangeRequest(tx, other, cr.id, approver)),
    ).toBeUndefined();
    expect((await rowOf(cr.id))?.status).toBe("open");
  });
});

describe("expireChangeRequests", () => {
  test("closes what is past its time and nothing else, dropping the sealed edits", async () => {
    const w = await world();
    const past = new Date(Date.now() - 1000);
    const late = await propose(w, [{ op: "delete", key: "A" }], { expiresAt: past });
    const fresh = await propose(w, [{ op: "delete", key: "B" }]);
    const decided = await propose(w, [{ op: "delete", key: "C" }], { expiresAt: past });
    await t.db.transaction((tx) => rejectChangeRequest(tx, w.at, decided.id, approver));

    const closed = await t.db.transaction((tx) => expireChangeRequests(tx, 100));
    expect(closed.map((c) => c.id)).toContain(late.id);
    expect(closed.map((c) => c.id)).not.toContain(fresh.id);
    expect(closed.map((c) => c.id)).not.toContain(decided.id);
    const row = await rowOf(late.id);
    expect(row?.status).toBe("expired");
    expect(row?.opsEnc).toBeNull();
    expect((await rowOf(fresh.id))?.status).toBe("open");
    expect((await rowOf(decided.id))?.status).toBe("rejected");
    expect(await t.db.transaction((tx) => expireChangeRequests(tx, 100))).toEqual([]);
  });

  test("at most `limit`, the oldest first", async () => {
    const w = await world();
    const mk = (ago: number) =>
      propose(w, [{ op: "delete", key: `K${ago}` }], { expiresAt: new Date(Date.now() - ago) });
    const [newest, middle, oldest] = [await mk(1000), await mk(5000), await mk(9000)];
    const first = await t.db.transaction((tx) => expireChangeRequests(tx, 2));
    expect(first.map((c) => c.id).sort()).toEqual([middle?.id, oldest?.id].sort());
    expect((await rowOf(newest?.id ?? ""))?.status).toBe("open");
  });
});

describe("expiry, further", () => {
  const lapsed = (w: World, key: string, ago = 1000) =>
    propose(w, [{ op: "delete", key }], { expiresAt: new Date(Date.now() - ago) });
  const sweep = () => t.db.transaction((tx) => expireChangeRequests(tx, 1000));

  test("an approved request that is past its time expires too, unsealed", async () => {
    await sweep();
    const w = await world();
    const cr = await lapsed(w, "A");
    await t.db.execute(
      sql`update change_requests set status = 'approved', decided_by_ref = 'user:approver' where id = ${cr.id}`,
    );
    expect((await sweep()).map((c) => c.id)).toEqual([cr.id]);
    const row = await rowOf(cr.id);
    expect([row?.status, row?.opsEnc]).toEqual(["expired", null]);
  });

  test("the oldest first, even when the planner scans the table instead of the index", async () => {
    await sweep();
    const w = await world();
    const newest = await lapsed(w, "N", 1000);
    const middle = await lapsed(w, "M", 5000);
    const oldest = await lapsed(w, "O", 9000);
    const first = await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_indexscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      return expireChangeRequests(tx, 2);
    });
    expect(first.map((c) => c.id).sort()).toEqual([middle.id, oldest.id].sort());
    expect((await rowOf(newest.id))?.status).toBe("open");
  });

  test("a request another worker holds is left to it, not waited for", async () => {
    await sweep();
    const w = await world();
    const taken = await lapsed(w, "A");
    const free = await lapsed(w, "B");
    const other = holding((tx) =>
      tx.select().from(changeRequests).where(eq(changeRequests.id, taken.id)).for("update"),
    );
    await other.ready;
    const sweeping = sweep();
    const out = await Promise.race([sweeping, Bun.sleep(3000).then(() => "blocked" as const)]);
    other.release();
    await other.done;
    await sweeping;
    expect(out).not.toBe("blocked");
    expect((await rowOf(free.id))?.status).toBe("expired");
    expect((await rowOf(taken.id))?.status).toBe("open");
    expect((await sweep()).map((c) => c.id)).toEqual([taken.id]);
  });
});

describe("the state machine, below the application", () => {
  const raw = async (id: string, set: ReturnType<typeof sql>) => {
    try {
      await t.db.execute(sql`update change_requests set ${set} where id = ${id}`);
      return undefined;
    } catch (e) {
      return pgCode(e);
    }
  };
  const open = async () => {
    const w = await world();
    return propose(w, [{ op: "set", key: "K", kind: "plain", value: "v" }]);
  };

  test("open -> approved -> applied is allowed, with a decider who is not the author", async () => {
    const cr = await open();
    expect(
      await raw(
        cr.id,
        sql`status = 'approved', decided_by_ref = 'user:approver', decided_at = now()`,
      ),
    ).toBeUndefined();
    expect(
      await raw(cr.id, sql`status = 'applied', ops_enc = null, applied_at = now()`),
    ).toBeUndefined();
  });

  test("approved or applied by the author is refused", async () => {
    const cr = await open();
    expect(await raw(cr.id, sql`status = 'approved', decided_by_ref = 'user:author'`)).toBe(
      "23514",
    );
    expect(await raw(cr.id, sql`status = 'approved'`)).toBe("23514");
    expect(
      await raw(cr.id, sql`status = 'applied', ops_enc = null, decided_by_ref = 'user:author'`),
    ).toBe("23514");
    expect((await rowOf(cr.id))?.status).toBe("open");
  });

  test("a request that is not closed keeps its sealed edits, and one that is closed has none", async () => {
    const cr = await open();
    expect(await raw(cr.id, sql`ops_enc = null`)).toBe("23514");
    expect(await raw(cr.id, sql`status = 'rejected'`)).toBe("23514");
    expect(await raw(cr.id, sql`status = 'expired'`)).toBe("23514");
    expect(await raw(cr.id, sql`status = 'expired', ops_enc = null`)).toBeUndefined();
  });

  test("a closed request cannot change again, and no move goes backwards", async () => {
    for (const closed of ["rejected", "expired"] as const) {
      const cr = await open();
      expect(await raw(cr.id, sql`status = ${closed}, ops_enc = null`)).toBeUndefined();
      expect(await raw(cr.id, sql`status = 'open'`)).toBe("55000");
      expect(await raw(cr.id, sql`status = 'applied'`)).toBe("55000");
      expect(await raw(cr.id, sql`decided_by_id = 'x'`)).toBe("55000");
    }
    const cr = await open();
    expect(
      await raw(cr.id, sql`status = 'approved', decided_by_ref = 'user:approver'`),
    ).toBeUndefined();
    expect(await raw(cr.id, sql`status = 'open', decided_by_ref = null`)).toBe("55000");
    expect(await raw(cr.id, sql`status = 'rejected', ops_enc = null`)).toBe("55000");
    expect(await raw(cr.id, sql`status = 'applied', ops_enc = null`)).toBeUndefined();
    expect(await raw(cr.id, sql`status = 'approved'`)).toBe("55000");
  });

  test("what the approvers were shown cannot be edited", async () => {
    const cr = await open();
    expect(await raw(cr.id, sql`diff = '[]'::jsonb`)).toBe("55000");
    expect(await raw(cr.id, sql`author_ref = 'user:approver'`)).toBe("55000");
    expect(await raw(cr.id, sql`author_id = 'approver'`)).toBe("55000");
    expect(await raw(cr.id, sql`expires_at = expires_at + interval '30 days'`)).toBe("55000");
    expect(await raw(cr.id, sql`ops_enc = '\\x00'::bytea`)).toBe("55000");
    expect(await raw(cr.id, sql`kind = 'variables'`)).toBeUndefined();
    const w = await world();
    expect(await raw(cr.id, sql`environment_id = ${w.env.id}`)).toBe("55000");
    expect((await rowOf(cr.id))?.status).toBe("open");
  });

  test("an unknown kind or state is refused, on insert and on update", async () => {
    const cr = await open();
    expect(await raw(cr.id, sql`kind = 'sync'`)).toBe("55000");
    expect(await raw(cr.id, sql`status = 'done'`)).toBe("55000");
    const w = await world();
    const insert = async (kind: string, status: string) => {
      try {
        await t.db.execute(sql`
          insert into change_requests (organization_id, project_id, environment_id, kind, status, diff, ops_enc, author_kind, author_id, author_ref, expires_at)
          values (${w.org.id}, ${w.project.id}, ${w.env.id}, ${kind}, ${status}, '[]'::jsonb, '\\x00'::bytea, 'user', 'a', 'user:a', now())`);
        return undefined;
      } catch (e) {
        return pgCode(e);
      }
    };
    expect(await insert("variables", "open")).toBeUndefined();
    expect(await insert("sync", "open")).toBe("23514");
    expect(await insert("variables", "done")).toBe("23514");
  });

  test("the request goes with its environment", async () => {
    const w = await world();
    const cr = await propose(w, [{ op: "delete", key: "K" }]);
    await deleteEnvironment(t.db, w.org.id, w.project.id, w.env.id);
    expect(await rowOf(cr.id)).toBeUndefined();
  });
});

describe("protecting an environment", () => {
  test("a new environment is not protected; the switch reports what it was", async () => {
    const w = await world();
    expect(w.env.protected).toBe(false);
    const on = await setEnvironmentProtection(t.db, w.org.id, w.project.id, w.env.id, true);
    expect([on?.env.protected, on?.previous]).toEqual([true, false]);
    const again = await setEnvironmentProtection(t.db, w.org.id, w.project.id, w.env.id, true);
    expect([again?.env.protected, again?.previous]).toEqual([true, true]);
    const off = await setEnvironmentProtection(t.db, w.org.id, w.project.id, w.env.id, false);
    expect([off?.env.protected, off?.previous]).toEqual([false, true]);
  });

  test("an environment of another project or organization is not found", async () => {
    const w = await world();
    const w2 = await world();
    expect(
      await setEnvironmentProtection(t.db, w.org.id, w2.project.id, w.env.id, true),
    ).toBeUndefined();
    expect(
      await setEnvironmentProtection(t.db, w2.org.id, w.project.id, w.env.id, true),
    ).toBeUndefined();
    expect(await lockEnvironment(t.db, w2.org.id, w.project.id, w.env.id, "share")).toBeUndefined();
    expect(
      (await lockEnvironment(t.db, w.org.id, w.project.id, w.env.id, "share"))?.protected,
    ).toBe(false);
  });

  test("a write that holds the environment keeps protection from turning on until it ends", async () => {
    const w = await world();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const held = new Promise<void>((r) => {
      locked = r;
    });
    const writer = t.db.transaction(async (tx) => {
      const env = await lockEnvironment(tx, w.org.id, w.project.id, w.env.id, "share");
      expect(env?.protected).toBe(false);
      locked();
      await gate;
    });
    await held;
    let switched = false;
    const flip = setEnvironmentProtection(t.db, w.org.id, w.project.id, w.env.id, true).then(
      (r) => {
        switched = true;
        return r;
      },
    );
    await Bun.sleep(300);
    expect(switched).toBe(false);
    release();
    await writer;
    expect((await flip)?.env.protected).toBe(true);
  });

  test("two writers can hold the environment together", async () => {
    const w = await world();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const held = new Promise<void>((r) => {
      locked = r;
    });
    const first = t.db.transaction(async (tx) => {
      await lockEnvironment(tx, w.org.id, w.project.id, w.env.id, "share");
      locked();
      await gate;
    });
    await held;
    const second = await t.db.transaction((tx) =>
      lockEnvironment(tx, w.org.id, w.project.id, w.env.id, "share"),
    );
    expect(second?.id).toBe(w.env.id);
    release();
    await first;
  });
});

describe("variables written alongside", () => {
  test("applying does not touch variables of other environments or levels", async () => {
    const w = await world();
    const other = { ...w.scope, environmentId: w.other.id };
    await createVariable(t.db, keys, {
      ...other,
      key: "K",
      kind: "plain",
      value: "dev",
      actor: author,
    });
    const cr = await propose(w, [{ op: "set", key: "K", kind: "plain", value: "prod" }]);
    expect((await approve(w, cr.id)).result).toBe("applied");
    expect(await values(w)).toEqual({ K: "prod" });
    expect(await values({ ...w, scope: other })).toEqual({ K: "dev" });
  });
});
