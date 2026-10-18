import { type DetectedType, IAC_TAGS } from "@orch/core";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { enqueueOnce } from "./jobs";
import type { Executor } from "./repo";
import { projects, stackDrift } from "./schema";

export type StackDrift = typeof stackDrift.$inferSelect;

/** The recurring job that asks for a check of every project with stacks, and the job that checks one. */
export const STACK_DRIFT_TICK_QUEUE = "stack.drift.tick";
export const STACK_DRIFT_CHECK_QUEUE = "stack.drift";

const PAGE = 500;

export interface StackRef {
  organizationId: string;
  projectId: string;
  stack: string;
}

export interface DriftCounts {
  add: number;
  change: number;
  destroy: number;
}

/** What is known of the project's stacks, by name: only stacks a check was asked for appear. */
export async function listStackDrift(db: Executor, organizationId: string, projectId: string) {
  return db
    .select()
    .from(stackDrift)
    .where(and(eq(stackDrift.projectId, projectId), eq(stackDrift.organizationId, organizationId)))
    .orderBy(asc(stackDrift.stack));
}

/**
 * Locks the project's row until the transaction ends, so that two checks of one project take turns,
 * and returns what is known of its stacks as of then. `undefined` when the project is gone. The lock
 * is `no key update`, which leaves the rows that point at the project (runs, audit events) free to be
 * written while a check waits for GitLab.
 */
export async function lockStackDrift(db: Executor, organizationId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    .for("no key update");
  return project && listStackDrift(db, organizationId, projectId);
}

/**
 * Notes that a check of the stack was asked for at `at`, which is what the cadence counts from: a
 * check that never reports is asked for again after a full period, not at every tick. A stack not
 * seen before starts `unknown`; one already known keeps what it knows.
 */
export async function markDriftRequested(db: Executor, s: StackRef, at: Date): Promise<void> {
  await db
    .insert(stackDrift)
    .values({ ...s, requestedAt: at })
    .onConflictDoUpdate({
      target: [stackDrift.projectId, stackDrift.stack],
      set: { requestedAt: at },
      // a row of the stack under another organization is not ours to touch (the foreign key refuses
      // the insert first; this keeps an update from ever reaching it)
      setWhere: eq(stackDrift.organizationId, s.organizationId),
    });
}

/**
 * Records what a drift run's plan found for the stack, as of `at`. Drift is a plan that would add,
 * change or destroy something. Returns `detected` when a stack that was not drifted is, `resolved`
 * when one that was is clean again, and `undefined` otherwise: an episode of drift is one piece of
 * news at its start and one at its end, however many checks see it in between. Concurrent reports
 * for one stack take turns, so one episode starts once. A report older than the latest one taken
 * (`at` before the stack's `checkedAt`) is a run that finished late: it changes nothing.
 */
export async function recordStackDrift(
  db: Executor,
  s: StackRef,
  counts: DriftCounts,
  at: Date,
): Promise<"detected" | "resolved" | undefined> {
  for (const n of [counts.add, counts.change, counts.destroy]) {
    if (!Number.isInteger(n) || n < 0)
      throw new Error("plan counts are whole numbers, not below 0");
  }
  return db.transaction(async (tx) => {
    // the row exists before it is locked, so a first report waits for the one ahead of it
    await tx
      .insert(stackDrift)
      .values({ ...s, requestedAt: at })
      .onConflictDoNothing();
    const here = and(
      eq(stackDrift.projectId, s.projectId),
      eq(stackDrift.organizationId, s.organizationId),
      eq(stackDrift.stack, s.stack),
    );
    const [before] = await tx.select().from(stackDrift).where(here).for("update");
    if (!before) throw new Error("the stack is not in that organization and project");
    if (before.checkedAt && before.checkedAt > at) return undefined;
    const drifted = counts.add + counts.change + counts.destroy > 0;
    await tx
      .update(stackDrift)
      .set({
        status: drifted ? "drifted" : "clean",
        since: drifted ? (before.status === "drifted" ? before.since : at) : null,
        checkedAt: at,
        planAdd: counts.add,
        planChange: counts.change,
        planDestroy: counts.destroy,
      })
      .where(here);
    if (drifted && before.status !== "drifted") return "detected";
    if (!drifted && before.status === "drifted") return "resolved";
    return undefined;
  });
}

const iac = (types: readonly DetectedType[]) => types.some((d) => IAC_TAGS.includes(d.tag));

/**
 * Asks for a check of every project linked to GitLab that was seen to hold Terraform or Terragrunt
 * (POL-1), unless one is already waiting for it, so a backlog does not grow when workers fall
 * behind. The jobs hold ids only. Returns how many were asked for.
 * shortcut: the tag is tested in JS, since `@>` does not work on the jsonb as Bun.sql stores it, so
 * every linked project is read each tick; upgrade when the projects number in the tens of thousands.
 */
export async function queueStackDriftChecks(db: Executor, pageSize = PAGE): Promise<number> {
  let after: string | undefined;
  let queued = 0;
  for (;;) {
    const page = await db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        detectedTypes: projects.detectedTypes,
      })
      .from(projects)
      .where(and(isNotNull(projects.gitlabProjectId), after ? gt(projects.id, after) : undefined))
      .orderBy(asc(projects.id))
      .limit(pageSize);
    for (const p of page.filter((x) => iac(x.detectedTypes))) {
      const job = await enqueueOnce(db, {
        queue: STACK_DRIFT_CHECK_QUEUE,
        payload: { organizationId: p.organizationId, projectId: p.id },
        dedupeKey: p.id,
      });
      if (job) queued++;
    }
    const last = page.at(-1);
    if (page.length < pageSize || !last) return queued;
    after = last.id;
  }
}
