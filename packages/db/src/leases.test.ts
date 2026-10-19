import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LEASES_PER_PRINCIPAL } from "@orch/core";
import { getTableColumns } from "drizzle-orm";
import {
  dueLeases,
  endLease,
  forgetLease,
  getLease,
  listLeases,
  type NewLease,
  recordHandle,
  startLease,
} from "./leases";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import { secretLeases } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const T0 = new Date("2026-03-01T12:00:00Z");
const minutes = (n: number, from = T0) => new Date(from.getTime() + n * 60_000);
const CONNECTION = "0190f5a0-0000-7000-8000-00000000c0de";

let n = 0;
const world = async () => {
  const org = await createOrganization(t.db, { slug: `l${++n}`, name: "L" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${n}` });
  const input = (over: Partial<NewLease> = {}): NewLease => ({
    organizationId: org.id,
    projectId: project.id,
    principal: `user:u${n}`,
    provider: "gitlab-token",
    connectionId: CONNECTION,
    remoteProjectId: 42,
    scopes: ["read_repository"],
    expiresAt: minutes(60),
    now: T0,
    ...over,
  });
  return { org, project, input };
};
const started = async (w: Awaited<ReturnType<typeof world>>, over: Partial<NewLease> = {}) => {
  const r = await startLease(t.db, w.input(over));
  if ("error" in r) throw new Error(r.error);
  return r.lease;
};

describe("secret leases", () => {
  test("a lease is a row with no credential in it: who, what, where and until when", async () => {
    // a column that could hold a value would be a leak waiting for a writer
    expect(Object.keys(getTableColumns(secretLeases)).sort()).toEqual([
      "connectionId",
      "createdAt",
      "expiresAt",
      "handle",
      "id",
      "organizationId",
      "principal",
      "projectId",
      "provider",
      "remoteProjectId",
      "revokedAt",
      "scopes",
      "updatedAt",
    ]);
    const w = await world();
    const lease = await started(w, { scopes: ["read_api", "read_repository"] });
    expect(lease).toMatchObject({
      principal: expect.stringMatching(/^user:u\d+$/),
      provider: "gitlab-token",
      remoteProjectId: 42,
      scopes: "read_api,read_repository",
      handle: null,
      revokedAt: null,
    });
    expect(lease.expiresAt).toEqual(minutes(60));
  });

  test("a principal holds at most the cap of live leases; ended and expired ones do not count, nor do other principals", async () => {
    const w = await world();
    const first = await started(w);
    for (let i = 1; i < LEASES_PER_PRINCIPAL; i++) await started(w);
    expect(await startLease(t.db, w.input())).toEqual({ error: "too_many" });
    // another principal is unaffected
    await started(w, { principal: "ci:job-9" });

    await endLease(t.db, first.id, T0);
    expect("lease" in (await startLease(t.db, w.input()))).toBe(true);
    expect(await startLease(t.db, w.input())).toEqual({ error: "too_many" });
    // an hour on, every one of them has expired
    expect("lease" in (await startLease(t.db, w.input({ now: minutes(61) })))).toBe(true);
  });

  test("requests at the cap together cannot pass it together", async () => {
    const w = await world();
    for (let i = 0; i < LEASES_PER_PRINCIPAL - 1; i++) await started(w);
    const answers = await Promise.all([1, 2, 3, 4].map(() => startLease(t.db, w.input())));
    expect(answers.filter((a) => "lease" in a)).toHaveLength(1);
    expect(answers.filter((a) => "error" in a)).toHaveLength(3);
  });

  test("the handle is recorded once; a lease that never got one can be forgotten, one that did cannot", async () => {
    const w = await world();
    const a = await started(w);
    expect(await recordHandle(t.db, a.id, "77")).toBe(true);
    expect(await recordHandle(t.db, a.id, "78")).toBe(false);
    await forgetLease(t.db, a.id);
    expect((await getLease(t.db, w.org.id, w.project.id, a.id))?.handle).toBe("77");

    const b = await started(w);
    await forgetLease(t.db, b.id);
    expect(await getLease(t.db, w.org.id, w.project.id, b.id)).toBeUndefined();
    // an ended lease takes no handle
    const c = await started(w);
    await endLease(t.db, c.id, T0);
    expect(await recordHandle(t.db, c.id, "79")).toBe(false);
  });

  test("a lease ends once", async () => {
    const w = await world();
    const a = await started(w);
    const ended = await endLease(t.db, a.id, minutes(5));
    expect(ended?.revokedAt).toEqual(minutes(5));
    expect(await endLease(t.db, a.id, minutes(9))).toBeUndefined();
    expect((await getLease(t.db, w.org.id, w.project.id, a.id))?.revokedAt).toEqual(minutes(5));
    expect(await endLease(t.db, "0190f5a0-0000-7000-8000-000000000000")).toBeUndefined();
  });

  test("due leases: expired, not ended, with a handle, longest overdue first", async () => {
    const w = await world();
    const late = await started(w, { expiresAt: minutes(30) });
    const early = await started(w, { expiresAt: minutes(10) });
    const fresh = await started(w, { expiresAt: minutes(90) });
    const noHandle = await started(w, { expiresAt: minutes(5) });
    const done = await started(w, { expiresAt: minutes(8) });
    for (const [l, h] of [
      [late, "1"],
      [early, "2"],
      [fresh, "3"],
      [done, "4"],
    ] as const) {
      await recordHandle(t.db, l.id, h);
    }
    await endLease(t.db, done.id, T0);

    const due = await dueLeases(t.db, { now: minutes(40), limit: 100 });
    const mine = due.filter((l) => l.organizationId === w.org.id).map((l) => l.id);
    expect(mine).toEqual([early.id, late.id]);
    expect(mine).not.toContain(noHandle.id);
    expect(mine).not.toContain(fresh.id);
    expect(await dueLeases(t.db, { now: minutes(40), limit: 1 })).toHaveLength(1);
  });

  test("a list shows one project's leases (optionally one principal's) in pages", async () => {
    const w = await world();
    const other = await world();
    const a = await started(w);
    const b = await started(w, { principal: "ci:job-1" });
    const c = await started(w);
    await started(other);

    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    expect(ids(await listLeases(t.db, w.org.id, w.project.id, { limit: 10 }))).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
    expect(
      ids(await listLeases(t.db, w.org.id, w.project.id, { limit: 10 }, { principal: "ci:job-1" })),
    ).toEqual([b.id]);
    expect(ids(await listLeases(t.db, w.org.id, w.project.id, { limit: 2, after: a.id }))).toEqual([
      b.id,
      c.id,
    ]);
    // another project's organization sees none of them
    expect(await listLeases(t.db, other.org.id, w.project.id, { limit: 10 })).toEqual([]);
    expect(await getLease(t.db, other.org.id, w.project.id, a.id)).toBeUndefined();
  });

  test("the table refuses a malformed provider, principal, scope list or handle", async () => {
    const w = await world();
    const refused = async (over: Partial<NewLease>) => {
      try {
        await startLease(t.db, w.input(over));
      } catch (e) {
        return pgConstraint(e);
      }
    };
    expect(await refused({ provider: "GitLab Token" })).toBe("secret_leases_provider_check");
    expect(await refused({ principal: "nobody" })).toBe("secret_leases_principal_check");
    expect(await refused({ scopes: ["read repository"] })).toBe("secret_leases_scopes_check");
    expect(await refused({ scopes: [] })).toBe("secret_leases_scopes_check");
    const a = await started(w);
    let bad: unknown;
    try {
      await recordHandle(t.db, a.id, "not a handle");
    } catch (e) {
      bad = pgConstraint(e);
    }
    expect(bad).toBe("secret_leases_handle_check");
  });

  test("a lease cannot name a project of another organization, and goes with its project", async () => {
    const w = await world();
    const other = await world();
    let fk: unknown;
    try {
      await startLease(t.db, w.input({ projectId: other.project.id }));
    } catch (e) {
      fk = pgConstraint(e);
    }
    expect(fk).toBe("secret_leases_project_org_fk");

    const a = await started(w);
    expect(await deleteProject(t.db, w.org.id, w.project.id)).toBe(true);
    expect(await getLease(t.db, w.org.id, w.project.id, a.id)).toBeUndefined();
  });
});
