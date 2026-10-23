import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import { getRunPlan, type PlanAction, storeRunPlan } from "./run-plans";
import { createRun } from "./runs";
import { createTestDb, type TestDb } from "./testing";

// FRG-17: the plan of a run as data, kept per run and action.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

let n = 0;
async function world() {
  const org = await createOrganization(t.db, { slug: `rp${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
  const run = await createRun(t.db, {
    organizationId: org.id,
    projectId: project.id,
    ref: "main",
    sha: "a".repeat(40),
    stacks: ["net"],
  });
  return { org, project, run };
}

const PLAN = {
  action: "plan",
  levels: [[{ name: "net", jobs: { plan: { commands: ["tf plan"] } } }]],
};

/** The constraint a failed statement names, or the error itself when it is not a database's. */
const refusedBy = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return pgConstraint(e) ?? e;
  }
  return undefined;
};

describe("the plan of a run", () => {
  test("is kept and read back as it was, one per action", async () => {
    const w = await world();
    const at = (action: PlanAction) => getRunPlan(t.db, w.org.id, w.project.id, w.run.id, action);
    expect(await at("plan")).toBeUndefined();
    await storeRunPlan(t.db, w.org.id, w.project.id, w.run.id, "plan", PLAN);
    await storeRunPlan(t.db, w.org.id, w.project.id, w.run.id, "apply", {
      ...PLAN,
      action: "apply",
    });
    expect(await at("plan")).toEqual(PLAN);
    expect(await at("apply")).toEqual({ ...PLAN, action: "apply" });
  });

  test("is replaced when kept again", async () => {
    const w = await world();
    await storeRunPlan(t.db, w.org.id, w.project.id, w.run.id, "apply", { levels: [1] });
    await storeRunPlan(t.db, w.org.id, w.project.id, w.run.id, "apply", { levels: [2] });
    expect(await getRunPlan(t.db, w.org.id, w.project.id, w.run.id, "apply")).toEqual({
      levels: [2],
    });
  });

  test("is not read through another project or organization, and cannot be kept under one", async () => {
    const w = await world();
    const other = await world();
    await storeRunPlan(t.db, w.org.id, w.project.id, w.run.id, "plan", PLAN);
    expect(await getRunPlan(t.db, w.org.id, other.project.id, w.run.id, "plan")).toBeUndefined();
    expect(await getRunPlan(t.db, other.org.id, w.project.id, w.run.id, "plan")).toBeUndefined();
    // a new plan is refused by the foreign key; one that would replace another's, by the store, and leaves it as it was
    expect(
      await refusedBy(storeRunPlan(t.db, w.org.id, other.project.id, w.run.id, "apply", PLAN)),
    ).toBe("run_plans_run_fk");
    expect(
      await storeRunPlan(t.db, w.org.id, other.project.id, w.run.id, "plan", { levels: [] }).catch(
        (e: Error) => e.message,
      ),
    ).toBe("the run is not the project's");
    expect(await getRunPlan(t.db, w.org.id, w.project.id, w.run.id, "plan")).toEqual(PLAN);
  });

  test("is refused for an action it does not know, and for one too big to be a plan", async () => {
    const w = await world();
    expect(
      await refusedBy(
        storeRunPlan(t.db, w.org.id, w.project.id, w.run.id, "destroy" as PlanAction, PLAN),
      ),
    ).toBe("run_plans_action_check");
    expect(
      await refusedBy(
        storeRunPlan(t.db, w.org.id, w.project.id, w.run.id, "plan", {
          commands: "x".repeat(4_000_001),
        }),
      ),
    ).toBe("run_plans_size_check");
  });

  test("goes with the project", async () => {
    const w = await world();
    await storeRunPlan(t.db, w.org.id, w.project.id, w.run.id, "plan", PLAN);
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(await getRunPlan(t.db, w.org.id, w.project.id, w.run.id, "plan")).toBeUndefined();
  });
});
