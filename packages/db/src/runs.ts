import { canTransition, isFinishedRun, type RunState } from "@orch/core";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Executor } from "./repo";
import { runStacks, runs } from "./schema";

export type RunStack = typeof runStacks.$inferSelect;
export type RunWithStacks = typeof runs.$inferSelect & { stacks: RunStack[] };
export type NewRun = Pick<
  typeof runs.$inferInsert,
  "organizationId" | "projectId" | "ref" | "sha" | "mergeRequestIid"
> & {
  /** Names of the stacks to run. The caller has checked that they exist. */
  stacks: readonly string[];
};

/** A move the lifecycle of `@orch/core` does not have: a bug in the caller, not a late event. */
export class IllegalTransition extends Error {
  constructor(from: string, to: string) {
    super(`a stack cannot go from ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
    this.name = "IllegalTransition";
  }
}

// By code point, here and not in SQL: a database collation may order `a-b` and `ab` the other way,
// and a run must list its stacks in the same order when it is made and when it is read.
const byStack = (a: RunStack, b: RunStack) => (a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0);

const withStacks = async (db: Executor, rows: (typeof runs.$inferSelect)[]) => {
  if (rows.length === 0) return [];
  const stacks = await db
    .select()
    .from(runStacks)
    .where(
      inArray(
        runStacks.runId,
        rows.map((r) => r.id),
      ),
    );
  const of = Object.groupBy(stacks.sort(byStack), (s) => s.runId);
  return rows.map((run) => ({ ...run, stacks: of[run.id] ?? [] }));
};

/** A run with each of its stacks `queued`. All or nothing. */
export async function createRun(db: Executor, input: NewRun): Promise<RunWithStacks> {
  const { stacks, ...fields } = input;
  if (stacks.length === 0) throw new Error("a run needs at least one stack");
  return db.transaction(async (tx) => {
    const run = (await tx.insert(runs).values(fields).returning())[0];
    if (!run) throw new Error("insert returned no row");
    const rows = await tx
      .insert(runStacks)
      .values(
        stacks.map((stack) => ({
          runId: run.id,
          organizationId: run.organizationId,
          projectId: run.projectId,
          stack,
        })),
      )
      .returning();
    return { ...run, stacks: rows.sort(byStack) };
  });
}

// Every lookup repeats the organization and the project, so an id from elsewhere matches nothing.
const inProject = (organizationId: string, projectId: string) =>
  and(eq(runs.projectId, projectId), eq(runs.organizationId, organizationId));

export async function getRun(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
): Promise<RunWithStacks | undefined> {
  const rows = await db
    .select()
    .from(runs)
    .where(and(inProject(organizationId, projectId), eq(runs.id, id)));
  return (await withStacks(db, rows))[0];
}

/** A project's runs, newest first (ids are time-ordered), after the run `before`. */
export async function listRuns(
  db: Executor,
  organizationId: string,
  projectId: string,
  o: { before?: string | undefined; limit: number },
): Promise<RunWithStacks[]> {
  const rows = await db
    .select()
    .from(runs)
    .where(
      and(
        inProject(organizationId, projectId),
        o.before === undefined ? undefined : lt(runs.id, o.before),
      ),
    )
    .orderBy(desc(runs.id))
    .limit(o.limit);
  return withStacks(db, rows);
}

/**
 * Moves one stack of a run from `from` to `to`, only if it is still in `from`: a repeated or late
 * event finds it moved on and gets `undefined`, and changes nothing. A pair the lifecycle does not
 * have throws `IllegalTransition`. `error` says why, in fixed words and never a tool's output; only a
 * move into a finished state keeps one (nothing moves out of those), any other drops it. Moving into `applying` fails
 * with the constraint `run_stacks_one_applying` while another run is applying the same stack.
 */
export async function moveRunStack(
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
  stack: string,
  from: RunState,
  to: RunState,
  error?: string,
): Promise<RunStack | undefined> {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
  const [row] = await db
    .update(runStacks)
    .set({ status: to, error: isFinishedRun(to) ? (error ?? null) : null })
    .where(
      and(
        eq(runStacks.runId, runId),
        eq(runStacks.stack, stack),
        eq(runStacks.projectId, projectId),
        eq(runStacks.organizationId, organizationId),
        eq(runStacks.status, from),
      ),
    )
    .returning();
  return row;
}
