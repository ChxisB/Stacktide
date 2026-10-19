import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createOrganization, createProject, deleteProject } from "./repo";
import { stateLocks } from "./schema";
import { blockedBy, forceUnlock, lockState, unlockState } from "./state-locks";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

let n = 0;
async function world() {
  const org = await createOrganization(t.db, { slug: `l${++n}`, name: "L" });
  const project = await createProject(t.db, { organizationId: org.id, name: "p" });
  const ref = { organizationId: org.id, projectId: project.id, stackName: "network" };
  return { org, project, ref };
}
const info = (id: string, who = "runner@host") => ({
  ID: id,
  Operation: "OperationTypeApply",
  Who: who,
  Version: "1.9.0",
  Created: "2026-10-19T10:00:00Z",
});
const soon = () => new Date(Date.now() + 60_000);
const take = (ref: Awaited<ReturnType<typeof world>>["ref"], id: string, owner: string) =>
  lockState(t.db, ref, { lockId: id, owner, expiresAt: soon(), info: info(id) });

describe("taking and refusing", () => {
  test("a free stack is locked, and the next owner is refused with what the first sent", async () => {
    const { ref } = await world();
    const first = await take(ref, "L1", "job-1");
    expect(first.ok).toBe(true);
    const second = await take(ref, "L2", "job-2");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.held.lockId).toBe("L1");
    expect(second.held.owner).toBe("job-1");
    expect(second.held.info).toEqual(info("L1"));
  });

  test("the same owner asking again with the same id is a retry; with another id it is refused", async () => {
    const { ref } = await world();
    await take(ref, "L1", "job-1");
    expect((await take(ref, "L1", "job-1")).ok).toBe(true);
    expect((await take(ref, "L2", "job-1")).ok).toBe(false);
    expect((await take(ref, "L1", "job-2")).ok).toBe(false); // the id is not what proves who you are
  });

  test("a lock whose time is up is not held: the next owner takes it", async () => {
    const { ref } = await world();
    const past = new Date(Date.now() - 1000);
    await lockState(t.db, ref, { lockId: "L1", owner: "job-1", expiresAt: past, info: info("L1") });
    expect(await blockedBy(t.db, ref, { owner: "job-2" })).toBeUndefined();
    const next = await take(ref, "L2", "job-2");
    expect(next.ok).toBe(true);
    const rows = await t.db
      .select()
      .from(stateLocks)
      .where(eq(stateLocks.projectId, ref.projectId));
    expect(rows.map((r) => r.lockId)).toEqual(["L2"]);
  });

  test("stacks and projects lock apart", async () => {
    const a = await world();
    const b = await world();
    await take(a.ref, "L1", "job-1");
    expect((await take({ ...a.ref, stackName: "dns" }, "L2", "job-2")).ok).toBe(true);
    expect((await take(b.ref, "L3", "job-3")).ok).toBe(true);
  });

  test("two owners asking at once: one is given the lock, the other is refused", async () => {
    const { ref } = await world();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => take(ref, `L${i}`, `job-${i}`)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const rows = await t.db
      .select()
      .from(stateLocks)
      .where(eq(stateLocks.projectId, ref.projectId));
    expect(rows).toHaveLength(1);
  });
});

describe("releasing", () => {
  test("the owner with the lock's id releases it; the stack can be locked again", async () => {
    const { ref } = await world();
    await take(ref, "L1", "job-1");
    expect(await unlockState(t.db, ref, { lockId: "L1", owner: "job-1" })).toEqual({
      ok: true,
      released: true,
    });
    expect((await take(ref, "L2", "job-2")).ok).toBe(true);
  });

  test("another owner cannot release it, even knowing the id; nor can the owner with another id", async () => {
    const { ref } = await world();
    await take(ref, "L1", "job-1");
    for (const input of [
      { lockId: "L1", owner: "job-2" },
      { lockId: "other", owner: "job-1" },
      { lockId: "", owner: "job-1" },
    ]) {
      const r = await unlockState(t.db, ref, input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.held.lockId).toBe("L1");
    }
    expect((await blockedBy(t.db, ref, { owner: "job-2" }))?.lockId).toBe("L1");
  });

  test("releasing what is not held (never taken, or ended) is accepted and releases nothing", async () => {
    const { ref } = await world();
    expect(await unlockState(t.db, ref, { lockId: "L1", owner: "job-1" })).toEqual({
      ok: true,
      released: false,
    });
    const past = new Date(Date.now() - 1000);
    await lockState(t.db, ref, { lockId: "L1", owner: "job-1", expiresAt: past, info: info("L1") });
    expect(await unlockState(t.db, ref, { lockId: "L1", owner: "job-2" })).toEqual({
      ok: true,
      released: false,
    });
  });

  test("an organization admin's force-unlock removes the lock and says whose it was", async () => {
    const { ref } = await world();
    expect(await forceUnlock(t.db, ref)).toBeUndefined();
    await take(ref, "L1", "job-1");
    const gone = await forceUnlock(t.db, ref);
    expect(gone?.owner).toBe("job-1");
    expect(gone?.lockId).toBe("L1");
    expect((await take(ref, "L2", "job-2")).ok).toBe(true);
  });
});

describe("what a lock holds off", () => {
  test("a writer is blocked by anyone's lock but its own, and by its own lock under another id", async () => {
    const { ref } = await world();
    expect(await blockedBy(t.db, ref, { owner: "job-1", lockId: "L1" })).toBeUndefined();
    await take(ref, "L1", "job-1");
    expect(await blockedBy(t.db, ref, { owner: "job-1", lockId: "L1" })).toBeUndefined();
    expect((await blockedBy(t.db, ref, { owner: "job-1", lockId: "L2" }))?.lockId).toBe("L1");
    expect((await blockedBy(t.db, ref, { owner: "job-1", lockId: "" }))?.lockId).toBe("L1");
    expect((await blockedBy(t.db, ref, { owner: "job-2", lockId: "L1" }))?.lockId).toBe("L1");
  });

  test("with no id given, only the owner is let through", async () => {
    const { ref } = await world();
    await take(ref, "L1", "job-1");
    expect(await blockedBy(t.db, ref, { owner: "job-1" })).toBeUndefined();
    expect((await blockedBy(t.db, ref, { owner: "job-2" }))?.lockId).toBe("L1");
  });
});

describe("the project", () => {
  test("a project with a lock held can be deleted: the lock goes with it", async () => {
    const { org, project, ref } = await world();
    await take(ref, "L1", "job-1");
    await deleteProject(t.db, org.id, project.id);
    const rows = await t.db.select().from(stateLocks).where(eq(stateLocks.projectId, project.id));
    expect(rows).toEqual([]);
  });
});
