import type { PolicyReport, PolicyVerdict } from "@orch/core";
import { judge } from "@orch/core";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Executor, Page } from "./repo";
import type { RunStack } from "./runs";
import { organizations, policySets, runStacks } from "./schema";

export type PolicySetRow = typeof policySets.$inferSelect;

/** Sets an organization may have: they are all handed to every plan, so the number is bounded where they are made. */
export const MAX_POLICY_SETS = 50;

/**
 * Makes a set; `undefined` when the organization already has `MAX_POLICY_SETS`. Creators of one
 * organization take its row in turn, so the count is not a race.
 */
export async function createPolicySet(
  db: Executor,
  input: Pick<PolicySetRow, "organizationId" | "name" | "source" | "ref" | "path" | "tag">,
): Promise<PolicySetRow | undefined> {
  // NO KEY UPDATE conflicts with itself and not with the key share a set's foreign key takes
  await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .for("no key update");
  const have = await db
    .select({ id: policySets.id })
    .from(policySets)
    .where(eq(policySets.organizationId, input.organizationId))
    .limit(MAX_POLICY_SETS);
  if (have.length >= MAX_POLICY_SETS) return undefined;
  const [row] = await db.insert(policySets).values(input).returning();
  if (!row) throw new Error("insert returned no row");
  return row;
}

const inOrg = (organizationId: string, id: string) =>
  and(eq(policySets.id, id), eq(policySets.organizationId, organizationId));

export async function getPolicySet(db: Executor, organizationId: string, id: string) {
  return (await db.select().from(policySets).where(inOrg(organizationId, id)))[0];
}

/** Ordered by id (a v7 uuid: creation order to the millisecond, not a strict guarantee). */
export function listPolicySets(db: Executor, organizationId: string, page: Page<string>) {
  return db
    .select()
    .from(policySets)
    .where(
      and(
        eq(policySets.organizationId, organizationId),
        page.after ? gt(policySets.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(policySets.id))
    .limit(page.limit);
}

/** True when a row was deleted. Plans already judged keep the verdict they have. */
export async function deletePolicySet(db: Executor, organizationId: string, id: string) {
  const rows = await db
    .delete(policySets)
    .where(inOrg(organizationId, id))
    .returning({ id: policySets.id });
  return rows.length > 0;
}

/**
 * Notes what the policy said of a stack's plan, replacing an earlier verdict (a job may post twice),
 * while the stack is still `queued`, `planning` or `planned`; `undefined` when it is not: after that
 * the plan is applied or gone. The verdict is worked out here, from the report, so that no caller
 * can store one that the report does not make.
 */
export async function storePolicyVerdict(
  db: Executor,
  organizationId: string,
  projectId: string,
  runId: string,
  stack: string,
  report: PolicyReport,
): Promise<(RunStack & { policyVerdict: PolicyVerdict }) | undefined> {
  const { verdict, denied, warned } = judge(report);
  const [row] = await db
    .update(runStacks)
    .set({
      policyVerdict: verdict,
      policyDenied: denied,
      policyWarned: warned,
      policyAt: new Date(),
    })
    .where(
      and(
        eq(runStacks.runId, runId),
        eq(runStacks.stack, stack),
        eq(runStacks.projectId, projectId),
        eq(runStacks.organizationId, organizationId),
        inArray(runStacks.status, ["queued", "planning", "planned"]),
      ),
    )
    .returning();
  if (!row) return undefined;
  const { planResources: _, ...rest } = row;
  return rest as RunStack & { policyVerdict: PolicyVerdict };
}

/** The rule names a stored verdict holds (a jsonb column reads back as `unknown`). */
export const ruleNames = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
