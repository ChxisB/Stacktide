import { type ResourceState, resourceStateOf } from "@orch/core";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { Executor, Page } from "./repo";
import { resources, runStacks, runs } from "./schema";

export type ResourceRow = typeof resources.$inferSelect;
export type NewResource = Pick<
  typeof resources.$inferInsert,
  | "organizationId"
  | "projectId"
  | "environment"
  | "kind"
  | "cloud"
  | "name"
  | "inputs"
  | "stack"
  | "path"
  | "proposalUrl"
>;

/**
 * Records a proposal. A resource is `(environment, kind, name)` in its project, so a repeat changes the
 * row it made: its inputs, path and link. Its cloud never changes (a move between clouds is a new name and
 * a delete), so a repeat on the other cloud, like a stack name another resource has (`resources_project_stack_key`)
 * or a project of another organization (`resources_project_org_fk`), is answered with `undefined` or the
 * database's refusal, and the route turns each into its answer.
 */
export async function upsertResource(
  db: Executor,
  input: NewResource,
): Promise<ResourceRow | undefined> {
  const [row] = await db
    .insert(resources)
    .values(input)
    .onConflictDoUpdate({
      target: [resources.projectId, resources.environment, resources.kind, resources.name],
      set: { inputs: input.inputs, path: input.path, proposalUrl: input.proposalUrl },
      setWhere: eq(resources.cloud, input.cloud),
    })
    .returning();
  return row;
}

/**
 * Keeps the links a plan summary carried (BLP-17) on the resource whose stack it is. The links are those of the
 * state the plan started from, so the newest plan decides: a plan asked for before the one already kept is
 * ignored (a run that finishes late must not undo a newer one), and one without a link takes the link away (the
 * stack was destroyed). Answers whether the row took them: a stack no resource names, as most stacks, is `false`.
 * The database refuses what is not a printable http(s) link of at most 300 characters.
 */
export async function recordResourceOutputs(
  db: Executor,
  s: { organizationId: string; projectId: string; stack: string },
  links: { url?: string; consoleUrl?: string },
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(resources)
    .set({ url: links.url ?? null, consoleUrl: links.consoleUrl ?? null, outputsAt: at })
    .where(
      and(
        eq(resources.organizationId, s.organizationId),
        eq(resources.projectId, s.projectId),
        eq(resources.stack, s.stack),
        or(isNull(resources.outputsAt), lte(resources.outputsAt, at)),
      ),
    )
    .returning({ id: resources.id });
  return rows.length > 0;
}

export async function getResource(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
): Promise<ResourceRow | undefined> {
  return (
    await db
      .select()
      .from(resources)
      .where(
        and(
          eq(resources.id, id),
          eq(resources.organizationId, organizationId),
          eq(resources.projectId, projectId),
        ),
      )
  )[0];
}

/** Ordered by id (a v7 uuid: creation order to the millisecond, not a strict guarantee). */
export function listResources(
  db: Executor,
  organizationId: string,
  projectId: string,
  page: Page<string>,
) {
  return db
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        eq(resources.projectId, projectId),
        page.after ? gt(resources.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(resources.id))
    .limit(page.limit);
}

/**
 * What each of `stacks` is, read from its runs (`resourceStateOf`): the newest run decides (run ids are
 * v7, so the highest is the latest proposal), and a stack that was ever applied stays `ready` through a
 * plan that was only planned, discarded or canceled. A scheduled drift plan is no proposal and counts for
 * nothing. A stack no run has touched is `proposed`. The map has every name asked about, in the order asked.
 */
export async function resourceStates(
  db: Executor,
  organizationId: string,
  projectId: string,
  stacks: readonly string[],
): Promise<Map<string, ResourceState>> {
  const states = new Map<string, ResourceState>();
  if (stacks.length === 0) return states;
  const scope = and(
    eq(runStacks.organizationId, organizationId),
    eq(runStacks.projectId, projectId),
    inArray(runStacks.stack, [...stacks]),
    eq(runs.kind, "plan"),
  );
  const newest = await db
    .selectDistinctOn([runStacks.stack], { stack: runStacks.stack, status: runStacks.status })
    .from(runStacks)
    .innerJoin(runs, eq(runs.id, runStacks.runId))
    .where(scope)
    .orderBy(runStacks.stack, desc(runStacks.runId));
  const applied = await db
    .selectDistinct({ stack: runStacks.stack })
    .from(runStacks)
    .innerJoin(runs, eq(runs.id, runStacks.runId))
    .where(and(scope, eq(runStacks.status, "applied")));
  const newestOf = new Map(newest.map((r) => [r.stack, r.status]));
  const everApplied = new Set(applied.map((r) => r.stack));
  for (const stack of stacks) {
    states.set(stack, resourceStateOf(newestOf.get(stack), everApplied.has(stack)));
  }
  return states;
}
