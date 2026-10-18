import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DetectedType } from "@orch/core";
import { eq } from "drizzle-orm";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import { createRun, getRun } from "./runs";
import { jobs, stackDrift } from "./schema";
import {
  listStackDrift,
  lockStackDrift,
  markDriftRequested,
  queueStackDriftChecks,
  recordStackDrift,
  STACK_DRIFT_CHECK_QUEUE,
  STACK_DRIFT_TICK_QUEUE,
} from "./stack-drift";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 18, 12, minutes));
const none = { add: 0, change: 0, destroy: 0 };

/** Bun's `toMatchObject` does not compare Dates (a different time matches), so a row's times are compared on their own. */
const times = (r: { since: Date | null; checkedAt: Date | null; requestedAt: Date } | undefined) =>
  r && { since: r.since, checkedAt: r.checkedAt, requestedAt: r.requestedAt };

const tag = (name: DetectedType["tag"]): DetectedType => ({
  tag: name,
  confidence: "high",
  evidence: [],
});

let n = 0;
async function world(detectedTypes: DetectedType[] = [], gitlabProjectId: number | null = 7 + n) {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, {
    organizationId: org.id,
    name: `p${++n}`,
    detectedTypes,
    ...(gitlabProjectId === null ? {} : { gitlabProjectId }),
  });
  const ref = (stack: string) => ({ organizationId: org.id, projectId: project.id, stack });
  return { org, project, ref };
}

/** The constraint a failed statement names, or the error itself when it is not a database's. */
const refusedBy = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return pgConstraint(e) ?? e;
  }
  return undefined;
};

describe("what is known of a stack", () => {
  test("a stack is unknown until a check reports, and asking again moves only the time", async () => {
    const w = await world();
    expect(await listStackDrift(t.db, w.org.id, w.project.id)).toEqual([]);

    await markDriftRequested(t.db, w.ref("net"), at(0));
    await markDriftRequested(t.db, w.ref("app"), at(1));
    const rows = await listStackDrift(t.db, w.org.id, w.project.id);
    expect(rows.map((r) => r.stack)).toEqual(["app", "net"]);
    expect(rows[1]).toMatchObject({ status: "unknown", planAdd: null });
    expect(times(rows[1])).toEqual({ since: null, checkedAt: null, requestedAt: at(0) });

    await recordStackDrift(t.db, w.ref("net"), { add: 1, change: 0, destroy: 0 }, at(2));
    await markDriftRequested(t.db, w.ref("net"), at(10));
    const net = (await listStackDrift(t.db, w.org.id, w.project.id)).find((r) => r.stack === "net");
    expect(net).toMatchObject({ status: "drifted" });
    expect(times(net)).toEqual({ since: at(2), checkedAt: at(2), requestedAt: at(10) });
  });

  test("locking a project gives what is known of its stacks, and nothing for one that is not there", async () => {
    const w = await world();
    await markDriftRequested(t.db, w.ref("net"), at(0));
    const locked = await t.db.transaction((tx) => lockStackDrift(tx, w.org.id, w.project.id));
    expect(locked?.map((r) => r.stack)).toEqual(["net"]);
    const other = await world();
    await t.db.transaction(async (tx) => {
      expect(await lockStackDrift(tx, other.org.id, w.project.id)).toBeUndefined();
      expect(
        await lockStackDrift(tx, w.org.id, "01a14e37-2c5f-74c1-af88-1fb31f1a7750"),
      ).toBeUndefined();
    });
  });

  test("another project or organization sees none of it", async () => {
    const a = await world();
    const b = await world();
    await markDriftRequested(t.db, a.ref("net"), at(0));
    expect(await listStackDrift(t.db, b.org.id, b.project.id)).toEqual([]);
    expect(await listStackDrift(t.db, b.org.id, a.project.id)).toEqual([]);
    expect(await listStackDrift(t.db, a.org.id, b.project.id)).toEqual([]);
  });

  test("a stack in a project of another organization is refused", async () => {
    const a = await world();
    const b = await world();
    const crossed = { organizationId: b.org.id, projectId: a.project.id, stack: "net" };
    expect(await refusedBy(markDriftRequested(t.db, crossed, at(0)))).toBe(
      "stack_drift_project_org_fk",
    );
    expect(await refusedBy(recordStackDrift(t.db, crossed, none, at(0)))).toBe(
      "stack_drift_project_org_fk",
    );
  });

  test("a stack that is known is not touched by a request that names the wrong organization", async () => {
    const a = await world();
    const b = await world();
    await markDriftRequested(t.db, a.ref("net"), at(0));
    await recordStackDrift(t.db, a.ref("net"), { add: 1, change: 0, destroy: 0 }, at(1));
    const crossed = { organizationId: b.org.id, projectId: a.project.id, stack: "net" };
    await markDriftRequested(t.db, crossed, at(9));
    await expect(recordStackDrift(t.db, crossed, none, at(9))).rejects.toThrow(
      "not in that organization",
    );
    const [net] = await listStackDrift(t.db, a.org.id, a.project.id);
    expect(net).toMatchObject({ status: "drifted", planAdd: 1 });
    expect(times(net)).toEqual({ since: at(1), checkedAt: at(1), requestedAt: at(0) });
  });

  test("the observation goes with the project", async () => {
    const w = await world();
    await markDriftRequested(t.db, w.ref("net"), at(0));
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(
      await t.db.select().from(stackDrift).where(eq(stackDrift.projectId, w.project.id)),
    ).toEqual([]);
  });
});

describe("an episode of drift", () => {
  const found = (w: Awaited<ReturnType<typeof world>>, add: number, minutes: number) =>
    recordStackDrift(t.db, w.ref("net"), { add, change: 0, destroy: 0 }, at(minutes));
  const row = async (w: Awaited<ReturnType<typeof world>>) =>
    (await listStackDrift(t.db, w.org.id, w.project.id)).find((r) => r.stack === "net");

  test("the first finding of a stack that was never checked: clean is no news, drift is", async () => {
    const clean = await world();
    expect(await recordStackDrift(t.db, clean.ref("net"), none, at(1))).toBeUndefined();
    expect(await row(clean)).toMatchObject({ status: "clean" });
    expect(times(await row(clean))).toEqual({ since: null, checkedAt: at(1), requestedAt: at(1) });

    const drifted = await world();
    expect(await found(drifted, 2, 1)).toBe("detected");
    expect(await row(drifted)).toMatchObject({
      status: "drifted",
      planAdd: 2,
      planChange: 0,
      planDestroy: 0,
    });
    expect(times(await row(drifted))).toEqual({
      since: at(1),
      checkedAt: at(1),
      requestedAt: at(1),
    });
  });

  test("clean to drifted is detected, again drifted is not, and clean again resolves it", async () => {
    const w = await world();
    await markDriftRequested(t.db, w.ref("net"), at(0));
    expect(await found(w, 0, 1)).toBeUndefined();
    expect(await found(w, 1, 2)).toBe("detected");
    // still drifted: the episode keeps its start, the counts and the check time are the latest
    expect(
      await recordStackDrift(t.db, w.ref("net"), { add: 0, change: 4, destroy: 1 }, at(3)),
    ).toBeUndefined();
    expect(await row(w)).toMatchObject({
      status: "drifted",
      planAdd: 0,
      planChange: 4,
      planDestroy: 1,
    });
    expect(times(await row(w))).toEqual({ since: at(2), checkedAt: at(3), requestedAt: at(0) });
    expect(await recordStackDrift(t.db, w.ref("net"), none, at(4))).toBe("resolved");
    expect(await row(w)).toMatchObject({
      status: "clean",
      planAdd: 0,
      planChange: 0,
      planDestroy: 0,
    });
    expect(times(await row(w))).toEqual({ since: null, checkedAt: at(4), requestedAt: at(0) });
    // a second episode starts anew
    expect(await found(w, 1, 5)).toBe("detected");
    expect((await row(w))?.since).toEqual(at(5));
  });

  test("two reports at once make one episode", async () => {
    const w = await world();
    const seen = await Promise.all([found(w, 1, 1), found(w, 1, 2), found(w, 1, 3)]);
    expect(seen.filter((s) => s === "detected")).toHaveLength(1);
    expect(seen.filter((s) => s === undefined)).toHaveLength(2);
  });

  test("a report older than the latest one taken changes nothing", async () => {
    const w = await world();
    expect(await found(w, 1, 5)).toBe("detected");
    // a run asked for at 3 that finishes after the one asked for at 5 must not say the stack is clean
    expect(await found(w, 0, 3)).toBeUndefined();
    expect(await row(w)).toMatchObject({ status: "drifted", planAdd: 1 });
    expect(times(await row(w))).toEqual({ since: at(5), checkedAt: at(5), requestedAt: at(5) });
    // the same moment is not older
    expect(await recordStackDrift(t.db, w.ref("net"), none, at(5))).toBe("resolved");
    expect(await found(w, 2, 4)).toBeUndefined();
    expect(await row(w)).toMatchObject({ status: "clean", planAdd: 0 });
  });

  test("a report waits for the one ahead of it on a stack that is already known", async () => {
    const w = await world();
    await markDriftRequested(t.db, w.ref("net"), at(0));
    let second: ReturnType<typeof found> | undefined;
    // The first holds the stack's row, as a report does between reading it and writing it. The
    // second starts meanwhile, and would read the row as it was were it not made to wait.
    const first = await t.db.transaction(async (tx) => {
      await tx
        .select()
        .from(stackDrift)
        .where(eq(stackDrift.projectId, w.project.id))
        .for("update");
      second = found(w, 1, 2);
      await Bun.sleep(300);
      return recordStackDrift(tx, w.ref("net"), { add: 1, change: 0, destroy: 0 }, at(1));
    });
    expect([first, await second]).toEqual(["detected", undefined]);
  });

  test("counts that cannot be are refused before anything is written", async () => {
    const w = await world();
    for (const bad of [
      { add: -1, change: 0, destroy: 0 },
      { add: 1.5, change: 0, destroy: 0 },
      { add: Number.NaN, change: 0, destroy: 0 },
    ]) {
      await expect(recordStackDrift(t.db, w.ref("net"), bad, at(1))).rejects.toThrow();
    }
    expect(await row(w)).toBeUndefined();
  });

  test("the table itself refuses a status that its counts contradict", async () => {
    const w = await world();
    const base = {
      organizationId: w.org.id,
      projectId: w.project.id,
      requestedAt: at(0),
      checkedAt: at(0),
    };
    const insert = (stack: string, values: Partial<typeof stackDrift.$inferInsert>) =>
      refusedBy(t.db.insert(stackDrift).values({ ...base, stack, ...values }));
    // drifted without an episode start, clean with changes, drifted with none, and a name that is not one
    expect(
      await insert("a", { status: "drifted", planAdd: 1, planChange: 0, planDestroy: 0 }),
    ).toBe("stack_drift_found_check");
    expect(
      await insert("b", {
        status: "clean",
        planAdd: 1,
        planChange: 0,
        planDestroy: 0,
      }),
    ).toBe("stack_drift_found_check");
    expect(
      await insert("c", {
        status: "drifted",
        since: at(0),
        planAdd: 0,
        planChange: 0,
        planDestroy: 0,
      }),
    ).toBe("stack_drift_found_check");
    expect(await insert("Bad_Name", { status: "unknown", checkedAt: null })).toBe(
      "stack_drift_stack_check",
    );
    expect(await insert("e", { status: "weird", planAdd: 1, planChange: 0, planDestroy: 0 })).toBe(
      "stack_drift_status_check",
    );
  });
});

describe("asking for checks", () => {
  const queued = async (projectIds: string[]) =>
    (await t.db.select().from(jobs).where(eq(jobs.queue, STACK_DRIFT_CHECK_QUEUE)))
      .filter((j) => projectIds.includes((j.payload as { projectId: string }).projectId))
      .filter((j) => j.status === "queued");

  test("the queue names are the ones the worker is wired with", () => {
    expect(STACK_DRIFT_TICK_QUEUE).toBe("stack.drift.tick");
    expect(STACK_DRIFT_CHECK_QUEUE).toBe("stack.drift");
  });

  test("a job for each linked project that holds Terraform or Terragrunt, ids only, and asking again adds none", async () => {
    const tf = await world([tag("bun"), tag("terraform")]);
    const tg = await world([tag("terragrunt")]);
    const other = await world([tag("bun"), tag("docker")]);
    const bare = await world([]);
    const unlinked = await world([tag("terraform")], null);
    const ids = [tf, tg, other, bare, unlinked].map((w) => w.project.id);

    // 2 per page: the walk has to continue past a page
    expect(await queueStackDriftChecks(t.db, 2)).toBeGreaterThanOrEqual(2);
    const jobsFor = await queued(ids);
    expect(
      jobsFor
        .map((j) => j.payload)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual(
      [
        { organizationId: tf.org.id, projectId: tf.project.id },
        { organizationId: tg.org.id, projectId: tg.project.id },
      ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    for (const j of jobsFor) {
      expect(j.dedupeKey).toBe((j.payload as { projectId: string }).projectId);
    }

    expect(await queueStackDriftChecks(t.db, 2)).toBe(0);
    expect(await queued(ids)).toHaveLength(2);
  });

  test("a project's jobs are asked for again once the earlier one has run", async () => {
    const w = await world([tag("terraform")]);
    await queueStackDriftChecks(t.db);
    const [job] = await queued([w.project.id]);
    expect(job).toBeDefined();
    await t.db
      .update(jobs)
      .set({ status: "done" })
      .where(eq(jobs.id, job?.id ?? ""));
    await queueStackDriftChecks(t.db);
    expect(await queued([w.project.id])).toHaveLength(1);
  });
});

describe("drift runs", () => {
  test("a run has a kind, a plan unless said otherwise, and a drift run belongs to no merge request", async () => {
    const w = await world();
    const base = {
      organizationId: w.org.id,
      projectId: w.project.id,
      ref: "main",
      sha: "a".repeat(40),
      stacks: ["net"],
    };
    expect((await createRun(t.db, base)).kind).toBe("plan");
    const drift = await createRun(t.db, { ...base, kind: "drift" });
    expect(drift.kind).toBe("drift");
    expect((await getRun(t.db, w.org.id, w.project.id, drift.id))?.kind).toBe("drift");

    expect(await refusedBy(createRun(t.db, { ...base, kind: "drift", mergeRequestIid: 3 }))).toBe(
      "runs_drift_check",
    );
    expect(await refusedBy(createRun(t.db, { ...base, kind: "apply" as never }))).toBe(
      "runs_kind_check",
    );
  });
});
