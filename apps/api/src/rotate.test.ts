import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  approveChangeRequest,
  auditEvents,
  changeRequests,
  claimDue,
  createEnvironment,
  createOrganization,
  createProject,
  createVariable,
  deleteVariable,
  getRotation,
  listChangeRequests,
  listVersions,
  type Rotation,
  revealVariable,
  setEnvironmentProtection,
  setRotation,
  variableRotations,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import {
  type FakeConfig,
  fakeRotator,
  RotationError,
  type Rotator,
  randomRotator,
} from "@orch/rotation";
import { and, eq, sql } from "drizzle-orm";
import { type RotateDeps, revokePrevious, rotateVariable } from "./rotate";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
// real time, not a fixed date: a request held for approval lapses by the database clock
const T0 = new Date();
const DAY = 86_400_000;
const days = (n: number) => new Date(T0.getTime() + n * DAY);

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

let n = 0;
const world = async () => {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${n}` });
  const base = { organizationId: org.id, projectId: project.id };
  const dev = await createEnvironment(t.db, { ...base, name: "Dev", slug: "dev" });
  const prod = await createEnvironment(t.db, {
    ...base,
    name: "Prod",
    slug: "prod",
    protected: true,
  });
  return {
    org,
    project,
    dev: { ...base, environmentId: dev.id },
    prod: { ...base, environmentId: prod.id },
  };
};
type Scope = Awaited<ReturnType<typeof world>>["dev"];

const lines: string[] = [];
const deps = (rotators: Record<string, Rotator>): RotateDeps => ({
  db: t.db,
  keys,
  rotators: new Map(Object.entries(rotators)),
  logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
});
const actor = { kind: "user", id: "u1" };

/** A secret with a rotation, claimed as of day `due`. */
async function rotating(
  scope: Scope,
  over: { provider?: string; config?: Record<string, unknown>; graceDays?: number } = {},
) {
  const variable = await createVariable(t.db, keys, {
    ...scope,
    key: `K${++n}`,
    kind: "secret",
    value: "old-value",
    actor,
  });
  const set = await setRotation(t.db, {
    organizationId: scope.organizationId,
    variableId: variable.id,
    provider: over.provider ?? "fake",
    config: over.config ?? { name: "a" },
    intervalDays: 30,
    graceDays: over.graceDays ?? 0,
    now: T0,
  });
  if ("error" in set) throw new Error(set.error);
  const claim = async (day = 30): Promise<Rotation> => {
    const claimed = (await claimDue(t.db, { now: days(day), limit: 50 })).find(
      (r) => r.id === set.row.id,
    );
    if (!claimed) throw new Error("not claimed");
    return claimed;
  };
  return { variable, rotation: set.row, claim };
}
const currentValue = async (scope: Scope, id: string) =>
  (await revealVariable(t.db, keys, scope, id))?.value;
const rotateEvents = (variableId: string) =>
  t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "variable.rotate"), eq(auditEvents.resourceId, variableId)));
const requestsIn = (scope: Scope) =>
  t.db.select().from(changeRequests).where(eq(changeRequests.environmentId, scope.environmentId));
const auditText = async () => JSON.stringify(await t.db.select().from(auditEvents));

describe("rotating a variable", () => {
  test("the minted value becomes the next version, written by the rotation and audited by id", async () => {
    const w = await world();
    const f = fakeRotator();
    const { variable, rotation, claim } = await rotating(w.dev);
    const out = await rotateVariable(deps({ fake: f.rotator }), await claim(), { now: days(30) });
    expect(out).toEqual({ result: "rotated", version: 2 });
    expect(await currentValue(w.dev, variable.id)).toBe("a-secret-1");
    const [latest] = await listVersions(t.db, w.dev, variable.id, { limit: 5 });
    expect(latest).toMatchObject({
      version: 2,
      actorKind: "rotation",
      actorId: rotation.id,
      reason: "rotation",
    });
    const [event] = await rotateEvents(variable.id);
    expect(event).toMatchObject({
      actorKind: "rotation",
      actorId: rotation.id,
      resourceId: variable.id,
      organizationId: w.org.id,
      projectId: w.project.id,
      metadata: { provider: "fake", version: 2 },
    });
    expect(await getRotation(t.db, w.org.id, variable.id)).toMatchObject({
      handle: "a-handle-1",
      previousHandle: null,
      lastStatus: "ok",
      attempts: 0,
    });
    expect((await getRotation(t.db, w.org.id, variable.id))?.nextAt).toEqual(days(60));
  });

  test("the credential a rotation replaces is revoked after its grace, and not before", async () => {
    const w = await world();
    const f = fakeRotator();
    const d = deps({ fake: f.rotator });
    const { variable, claim } = await rotating(w.dev, { graceDays: 3 });
    await rotateVariable(d, await claim(30), { now: days(30) });
    await rotateVariable(d, await claim(60), { now: days(60) });
    const row = await getRotation(t.db, w.org.id, variable.id);
    expect(row).toMatchObject({ handle: "a-handle-2", previousHandle: "a-handle-1" });
    expect(row?.revokeAt).toEqual(days(63));
    // the old credential is still valid for its grace
    expect([...f.live]).toEqual(["a-handle-1", "a-handle-2"]);
    if (!row) throw new Error("no row");
    await revokePrevious(d, row);
    expect([...f.live]).toEqual(["a-handle-2"]);
    expect(await getRotation(t.db, w.org.id, variable.id)).toMatchObject({
      previousHandle: null,
      revokeAt: null,
    });
    // revoking again is nothing
    await revokePrevious(d, row);
  });

  test("a replaced credential still waiting to be revoked is revoked before another is minted", async () => {
    const w = await world();
    const f = fakeRotator();
    const d = deps({ fake: f.rotator });
    const { variable, claim } = await rotating(w.dev, { graceDays: 20 });
    await rotateVariable(d, await claim(30), { now: days(30) });
    await rotateVariable(d, await claim(60), { now: days(60) });
    // the sweep never ran: the third rotation must not forget "a-handle-1"
    await rotateVariable(d, await claim(90), { now: days(90) });
    expect(f.calls.map((c) => `${c.op}:${c.handle}`)).toEqual([
      "mint:a-handle-1",
      "mint:a-handle-2",
      "revoke:a-handle-1",
      "mint:a-handle-3",
    ]);
    expect(await getRotation(t.db, w.org.id, variable.id)).toMatchObject({
      handle: "a-handle-3",
      previousHandle: "a-handle-2",
    });
  });

  test("a provider that fails changes nothing: the old value stays live", async () => {
    const w = await world();
    const f = fakeRotator();
    const { variable, claim } = await rotating(w.dev);
    f.failWith("denied");
    const error = await rotateVariable(deps({ fake: f.rotator }), await claim(), {
      now: days(30),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RotationError);
    expect((error as RotationError).kind).toBe("denied");
    expect(await currentValue(w.dev, variable.id)).toBe("old-value");
    expect((await listVersions(t.db, w.dev, variable.id, { limit: 5 })).length).toBe(1);
    expect(await rotateEvents(variable.id)).toEqual([]);
  });

  test("a provider the deployment lacks is refused without naming it", async () => {
    const w = await world();
    const { claim } = await rotating(w.dev, { provider: "secret-provider-7f3a" });
    const error = await rotateVariable(deps({}), await claim(), { now: days(30) }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RotationError);
    expect((error as RotationError).kind).toBe("invalid_config");
    expect((error as RotationError).message).not.toContain("7f3a");
  });

  test("a variable that is gone is skipped before anything is minted", async () => {
    const w = await world();
    const f = fakeRotator();
    const { variable, claim } = await rotating(w.dev);
    const claimed = await claim();
    await deleteVariable(t.db, w.dev, variable.id);
    expect(await rotateVariable(deps({ fake: f.rotator }), claimed)).toEqual({
      result: "skipped",
      why: "variable_gone",
    });
    expect(f.calls).toEqual([]);
  });
});

describe("a write that cannot be kept", () => {
  /** A provider that does something to the world right after minting, before the write. */
  const sabotage = (
    f: ReturnType<typeof fakeRotator>,
    after: () => Promise<void>,
  ): Rotator<FakeConfig> => ({
    ...f.rotator,
    async rotate(ctx) {
      const minted = await f.rotator.rotate(ctx);
      await after();
      return minted;
    },
  });

  test("the variable deleted meanwhile: the minted credential is revoked", async () => {
    const w = await world();
    const f = fakeRotator();
    const { variable, claim } = await rotating(w.dev);
    const rotator = sabotage(f, async () => {
      await deleteVariable(t.db, w.dev, variable.id);
    });
    expect(await rotateVariable(deps({ fake: rotator }), await claim(), { now: days(30) })).toEqual(
      { result: "skipped", why: "variable_gone" },
    );
    expect(f.calls.map((c) => c.op)).toEqual(["mint", "revoke"]);
    expect(f.live.size).toBe(0);
  });

  test("the claim taken over meanwhile: nothing is kept, not the version and not the audit row", async () => {
    const w = await world();
    const f = fakeRotator();
    const { variable, rotation, claim } = await rotating(w.dev);
    const rotator = sabotage(f, async () => {
      await t.db
        .update(variableRotations)
        .set({ nextAt: sql`${variableRotations.nextAt} + interval '1 hour'` })
        .where(eq(variableRotations.id, rotation.id));
    });
    expect(await rotateVariable(deps({ fake: rotator }), await claim(), { now: days(30) })).toEqual(
      { result: "skipped", why: "claim_lost" },
    );
    expect(await currentValue(w.dev, variable.id)).toBe("old-value");
    expect((await listVersions(t.db, w.dev, variable.id, { limit: 5 })).length).toBe(1);
    expect(await rotateEvents(variable.id)).toEqual([]);
    expect(f.live.size).toBe(0);
  });

  test("an environment protected meanwhile takes no direct write: the minted credential is revoked", async () => {
    const w = await world();
    const f = fakeRotator();
    const { variable, claim } = await rotating(w.dev);
    const rotator = sabotage(f, async () => {
      await setEnvironmentProtection(t.db, w.org.id, w.project.id, w.dev.environmentId, true);
    });
    expect(await rotateVariable(deps({ fake: rotator }), await claim(), { now: days(30) })).toEqual(
      { result: "skipped", why: "protection_changed" },
    );
    expect(await currentValue(w.dev, variable.id)).toBe("old-value");
    expect(f.live.size).toBe(0);
  });

  test("a credential that cannot be revoked is logged by its handle and never by its value", async () => {
    const w = await world();
    const f = fakeRotator();
    const { rotation, claim } = await rotating(w.dev);
    const rotator = sabotage(f, async () => {
      f.failWith("failed");
      await t.db
        .update(variableRotations)
        .set({ nextAt: sql`${variableRotations.nextAt} + interval '1 hour'` })
        .where(eq(variableRotations.id, rotation.id));
    });
    lines.length = 0;
    expect(await rotateVariable(deps({ fake: rotator }), await claim(), { now: days(30) })).toEqual(
      { result: "skipped", why: "claim_lost" },
    );
    const logged = lines.join("\n");
    expect(logged).toContain("could not revoke");
    expect(logged).toContain("a-handle-1");
    expect(logged).not.toContain("a-secret-1");
  });
});

describe("a provider that ends the credential it replaces", () => {
  /** What GitLab does: the new token is minted, the old one dies in the same step, and the config moves on to the new one. */
  const ending = (
    f: ReturnType<typeof fakeRotator>,
    after: () => Promise<void> = async () => {},
  ): Rotator<FakeConfig> => ({
    ...f.rotator,
    endsReplaced: true,
    async rotate(ctx) {
      const minted = await f.rotator.rotate(ctx);
      await after();
      return { ...minted, config: { name: `${ctx.config.name}-next` } };
    },
  });
  const bumpClaim = (id: string) =>
    t.db
      .update(variableRotations)
      .set({ nextAt: sql`${variableRotations.nextAt} + interval '1 hour'` })
      .where(eq(variableRotations.id, id));

  test("a write that is lost keeps the new credential as the rotation's own, and the next attempt rotates it", async () => {
    const w = await world();
    const f = fakeRotator();
    const { variable, rotation, claim } = await rotating(w.dev);
    const rotator = ending(f, () => bumpClaim(rotation.id));
    expect(await rotateVariable(deps({ fake: rotator }), await claim(), { now: days(30) })).toEqual(
      { result: "skipped", why: "claim_lost" },
    );
    // revoking it would leave the rotation pointing at a token that no longer exists
    expect(f.calls.map((c) => c.op)).toEqual(["mint"]);
    const row = await getRotation(t.db, w.org.id, variable.id);
    expect(row?.handle).toBe("a-handle-1");
    expect(row?.config).toEqual({ name: "a-next" });

    const again = await rotateVariable(deps({ fake: ending(f) }), await claim(60), {
      now: days(60),
    });
    expect(again.result).toBe("rotated");
    expect(await currentValue(w.dev, variable.id)).toBe("a-next-secret-2");
  });

  test("a variable deleted meanwhile has nothing to keep it for: the credential is revoked", async () => {
    const w = await world();
    const f = fakeRotator();
    const { variable, claim } = await rotating(w.dev);
    const rotator = ending(f, async () => {
      await deleteVariable(t.db, w.dev, variable.id);
    });
    expect(await rotateVariable(deps({ fake: rotator }), await claim(), { now: days(30) })).toEqual(
      { result: "skipped", why: "variable_gone" },
    );
    expect(f.calls.map((c) => c.op)).toEqual(["mint", "revoke"]);
    expect(f.live.size).toBe(0);
  });
});

describe("a write that fails without saying whether it was kept", () => {
  const broken: RotateDeps["keys"] = {
    currentKeyId: keys.currentKeyId,
    wrap: (...a) => keys.wrap(...a),
    unwrap: async () => {
      throw new Error("key service down");
    },
  };
  const withBrokenKeys = (rotator: Rotator): RotateDeps => ({
    ...deps({ fake: rotator }),
    keys: broken,
  });

  test("not recorded: the minted credential is revoked and the error goes on", async () => {
    const w = await world();
    const f = fakeRotator();
    const { claim } = await rotating(w.dev);
    await expect(
      rotateVariable(withBrokenKeys(f.rotator), await claim(), { now: days(30) }),
    ).rejects.toThrow("key service down");
    expect(f.calls.map((c) => c.op)).toEqual(["mint", "revoke"]);
    expect(f.live.size).toBe(0);
  });

  test("recorded (the answer was lost, the commit was not): the credential in use is not revoked", async () => {
    const w = await world();
    const f = fakeRotator();
    const { rotation, claim } = await rotating(w.dev);
    const rotator: Rotator<FakeConfig> = {
      ...f.rotator,
      async rotate(ctx) {
        const minted = await f.rotator.rotate(ctx);
        await t.db
          .update(variableRotations)
          .set({ handle: minted.handle })
          .where(eq(variableRotations.id, rotation.id));
        return minted;
      },
    };
    await expect(
      rotateVariable(withBrokenKeys(rotator), await claim(), { now: days(30) }),
    ).rejects.toThrow("key service down");
    expect(f.calls.map((c) => c.op)).toEqual(["mint"]);
    expect(f.live.size).toBe(1);
  });
});

describe("a protected environment", () => {
  test("holds the new value in a change request authored by the rotation; the old one stays live", async () => {
    const w = await world();
    const f = fakeRotator({ external: false });
    const d = deps({ fake: f.rotator });
    const { variable, rotation, claim } = await rotating(w.prod);
    const out = await rotateVariable(d, await claim(30), { now: days(30) });
    if (out.result !== "waiting") throw new Error(`got ${out.result}`);
    expect(await currentValue(w.prod, variable.id)).toBe("old-value");
    expect((await listVersions(t.db, w.prod, variable.id, { limit: 5 })).length).toBe(1);
    const open = await listChangeRequests(t.db, w.prod, { status: "open" }, { limit: 10 });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: out.changeRequestId,
      authorKind: "rotation",
      authorId: rotation.id,
      authorRef: `rotation:${rotation.id}`,
    });
    expect(open[0]?.diff.map((e) => e.key)).toEqual([expect.stringMatching(/^K\d+$/)]);
    expect(await getRotation(t.db, w.org.id, variable.id)).toMatchObject({
      lastStatus: "pending_approval",
      handle: null,
    });
    const [event] = await rotateEvents(variable.id);
    expect(event?.metadata).toMatchObject({ changeRequestId: out.changeRequestId });

    // a person approves: now it is the version, written under the approver's name
    const approved = await t.db.transaction((tx) =>
      approveChangeRequest(tx, keys, w.prod, out.changeRequestId, {
        kind: "user",
        id: "approver",
        ref: "user:approver",
      }),
    );
    expect(approved.result).toBe("applied");
    expect(await currentValue(w.prod, variable.id)).toBe("a-secret-1");
  });

  test("a later cycle that finds the request still open mints nothing and opens no second one", async () => {
    const w = await world();
    const f = fakeRotator({ external: false });
    const d = deps({ fake: f.rotator });
    const { variable, claim } = await rotating(w.prod);
    const first = await rotateVariable(d, await claim(30), { now: days(30) });
    const second = await rotateVariable(d, await claim(60), { now: days(60) });
    expect(second).toEqual(first);
    expect(await requestsIn(w.prod)).toHaveLength(1);
    const row = await getRotation(t.db, w.org.id, variable.id);
    expect(row?.lastStatus).toBe("pending_approval");
    expect(row?.nextAt).toEqual(days(90));
    // minted once: the only value there is is the first
    const [request] = await requestsIn(w.prod);
    expect(request?.opsEnc).not.toBeNull();
  });

  test("a rejected request leaves the old value and the next cycle asks again", async () => {
    const w = await world();
    const f = fakeRotator({ external: false });
    const d = deps({ fake: f.rotator });
    const { variable, claim } = await rotating(w.prod);
    const first = await rotateVariable(d, await claim(30), { now: days(30) });
    if (first.result !== "waiting") throw new Error("not waiting");
    await t.db
      .update(changeRequests)
      .set({ status: "rejected", opsEnc: null })
      .where(eq(changeRequests.id, first.changeRequestId));
    const again = await rotateVariable(d, await claim(60), { now: days(60) });
    if (again.result !== "waiting") throw new Error("not waiting");
    expect(again.changeRequestId).not.toBe(first.changeRequestId);
    expect(await currentValue(w.prod, variable.id)).toBe("old-value");
  });

  test("a provider that changes something outside is refused there, with nothing minted", async () => {
    const w = await world();
    const f = fakeRotator();
    const { variable, claim } = await rotating(w.prod);
    const error = await rotateVariable(deps({ fake: f.rotator }), await claim(), {
      now: days(30),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RotationError);
    expect((error as RotationError).kind).toBe("denied");
    expect(f.calls).toEqual([]);
    expect(await currentValue(w.prod, variable.id)).toBe("old-value");
    expect(await requestsIn(w.prod)).toEqual([]);
  });

  test("a project's own variable is not held: only an environment is protected", async () => {
    const w = await world();
    const f = fakeRotator();
    const { claim } = await rotating({
      organizationId: w.org.id,
      projectId: w.project.id,
    } as Scope);
    expect(
      (await rotateVariable(deps({ fake: f.rotator }), await claim(), { now: days(30) })).result,
    ).toBe("rotated");
  });
});

describe("no generated value leaves the variable", () => {
  test("not in audit rows, logs, change requests, the rotation row or an error", async () => {
    const w = await world();
    const d = deps({ random: randomRotator, fake: fakeRotator({ external: false }).rotator });
    lines.length = 0;
    const seen: string[] = [];

    const open = await rotating(w.dev, { provider: "random", config: { length: 40 } });
    await rotateVariable(d, await open.claim(), { now: days(30) });
    seen.push((await currentValue(w.dev, open.variable.id)) ?? "");

    const guarded = await rotating(w.prod, { provider: "random", config: { length: 40 } });
    await rotateVariable(d, await guarded.claim(), { now: days(30) });

    const failing = await rotating(w.dev, { provider: "random", config: { length: 3 } });
    const error = await rotateVariable(d, await failing.claim(), { now: days(30) }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RotationError);

    const value = seen[0] ?? "";
    expect(value).toHaveLength(40);
    const where = [
      await auditText(),
      lines.join("\n"),
      JSON.stringify(await listChangeRequests(t.db, w.prod, { status: "open" }, { limit: 10 })),
      JSON.stringify(await t.db.select().from(variableRotations)),
      String((error as Error).message),
    ].join("\n");
    expect(where).not.toContain(value);
    // the request's own sealed copy is ciphertext: the value is not in it either
    const [request] = await requestsIn(w.prod);
    expect(Buffer.from(request?.opsEnc ?? []).toString("latin1")).not.toContain(value.slice(0, 12));
  });
});
