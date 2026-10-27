import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ResourceState, RUN_STATES, type RunState } from "@orch/core";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import {
  getResource,
  listResources,
  type NewResource,
  recordResourceOutputs,
  resourceStates,
  upsertResource,
} from "./resources";
import { createRun, moveRunStack } from "./runs";
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
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
  return { org, project };
}
type World = Awaited<ReturnType<typeof world>>;

const bucket = (w: World, over: Partial<NewResource> = {}): NewResource => ({
  organizationId: w.org.id,
  projectId: w.project.id,
  environment: "staging",
  kind: "bucket",
  cloud: "gcp",
  name: "files",
  inputs: { versioning: true },
  stack: "staging-files-bucket",
  path: "infra/staging/files-bucket",
  proposalUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
  ...over,
});
const refusedBy = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return pgConstraint(e) ?? e;
  }
  return undefined;
};
const page = { limit: 100 };

describe("storing a resource", () => {
  test("keeps what the renderer was given, with its project and stack", async () => {
    const w = await world();
    const row = await upsertResource(t.db, bucket(w));
    expect(row).toMatchObject({
      organizationId: w.org.id,
      projectId: w.project.id,
      environment: "staging",
      kind: "bucket",
      cloud: "gcp",
      name: "files",
      inputs: { versioning: true },
      stack: "staging-files-bucket",
      path: "infra/staging/files-bucket",
      proposalUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
    });
    expect(await getResource(t.db, w.org.id, w.project.id, row?.id as string)).toEqual(row);
  });

  test("a repeat proposal changes the same row: its inputs, path and link", async () => {
    const w = await world();
    const first = await upsertResource(t.db, bucket(w));
    const again = await upsertResource(
      t.db,
      bucket(w, {
        inputs: { versioning: false },
        path: "deploy/staging/files-bucket",
        proposalUrl: "https://gitlab.example.com/g/p/-/merge_requests/9",
      }),
    );
    expect(again).toMatchObject({
      id: first?.id,
      inputs: { versioning: false },
      path: "deploy/staging/files-bucket",
      proposalUrl: "https://gitlab.example.com/g/p/-/merge_requests/9",
    });
    expect(await listResources(t.db, w.org.id, w.project.id, page)).toHaveLength(1);
  });

  test("a repeat on another cloud is refused and changes nothing", async () => {
    const w = await world();
    const first = await upsertResource(t.db, bucket(w));
    expect(
      await upsertResource(t.db, bucket(w, { cloud: "aws", inputs: { versioning: false } })),
    ).toBe(undefined);
    expect(await getResource(t.db, w.org.id, w.project.id, first?.id as string)).toEqual(first);
  });

  test("a database and a bucket may both be called main, in one environment", async () => {
    const w = await world();
    await upsertResource(t.db, bucket(w, { name: "main", stack: "staging-main-bucket" }));
    await upsertResource(
      t.db,
      bucket(w, { kind: "postgres", name: "main", stack: "staging-main-postgres" }),
    );
    expect(await listResources(t.db, w.org.id, w.project.id, page)).toHaveLength(2);
  });

  test("two resources cannot share a stack name, which is their state key", async () => {
    const w = await world();
    // dev-eu + main and dev + eu-main both come out as dev-eu-main-bucket
    await upsertResource(
      t.db,
      bucket(w, { environment: "dev-eu", name: "main", stack: "dev-eu-main-bucket" }),
    );
    expect(
      await refusedBy(
        upsertResource(
          t.db,
          bucket(w, { environment: "dev", name: "eu-main", stack: "dev-eu-main-bucket" }),
        ),
      ),
    ).toBe("resources_project_stack_key");
  });

  test("another project, and another organization, may use the same names", async () => {
    const a = await world();
    const b = await world();
    await upsertResource(t.db, bucket(a));
    await upsertResource(t.db, bucket(b));
    const second = await createProject(t.db, { organizationId: a.org.id, name: `p${++n}` });
    await upsertResource(t.db, bucket(a, { projectId: second.id }));
    expect(await listResources(t.db, a.org.id, a.project.id, page)).toHaveLength(1);
  });

  test("a project of another organization is refused", async () => {
    const a = await world();
    const b = await world();
    expect(await refusedBy(upsertResource(t.db, bucket(a, { projectId: b.project.id })))).toBe(
      "resources_project_org_fk",
    );
  });

  test("the database refuses what the schema of a blueprint would", async () => {
    const w = await world();
    const bad: [string, Partial<NewResource>][] = [
      ["a kind that is not one", { kind: "cache" as never }],
      ["a cloud that is not one", { cloud: "azure" as never }],
      ["an uppercase environment", { environment: "Staging", stack: "Staging-files-bucket" }],
      [
        "a name over 12 characters",
        { name: "x".repeat(13), stack: `staging-${"x".repeat(13)}-bucket` },
      ],
      ["a name with a double dash", { name: "a--b", stack: "staging-a--b-bucket" }],
      ["a stack that is not the three parts", { stack: "staging-other-bucket" }],
      ["a path with a .. segment", { path: "infra/../files-bucket" }],
      ["a path with a space", { path: "infra/my files" }],
      ["a link that is not http", { proposalUrl: "javascript:alert(1)" }],
      ["a link over 2000 characters", { proposalUrl: `https://x.example/${"a".repeat(2000)}` }],
      ["inputs over 10000 characters", { inputs: { image: "a".repeat(10_001) } }],
    ];
    for (const [what, over] of bad) {
      const r = await refusedBy(upsertResource(t.db, bucket(w, over)));
      expect([what, typeof r]).toEqual([what, "string"]);
    }
    expect(await listResources(t.db, w.org.id, w.project.id, page)).toEqual([]);
  });

  test("a resource with no proposal link yet is stored", async () => {
    const w = await world();
    const row = await upsertResource(t.db, bucket(w, { proposalUrl: null }));
    expect(row?.proposalUrl).toBeNull();
  });
});

describe("reading resources", () => {
  test("a list holds one project's resources, in creation order, a page at a time", async () => {
    const w = await world();
    const other = await world();
    const names = ["aa", "bb", "cc"];
    const made: string[] = [];
    for (const name of names) {
      const row = await upsertResource(t.db, bucket(w, { name, stack: `staging-${name}-bucket` }));
      made.push(row?.id as string);
    }
    await upsertResource(t.db, bucket(other));
    const all = await listResources(t.db, w.org.id, w.project.id, page);
    expect(all.map((r) => r.name)).toEqual(names);
    const first = await listResources(t.db, w.org.id, w.project.id, { limit: 2 });
    const rest = await listResources(t.db, w.org.id, w.project.id, {
      limit: 2,
      after: first[1]?.id,
    });
    expect([...first, ...rest].map((r) => r.id)).toEqual(made);
  });

  test("an id from another project or organization finds nothing", async () => {
    const a = await world();
    const b = await world();
    const row = await upsertResource(t.db, bucket(a));
    const id = row?.id as string;
    expect(await getResource(t.db, a.org.id, b.project.id, id)).toBeUndefined();
    expect(await getResource(t.db, b.org.id, a.project.id, id)).toBeUndefined();
    expect(await listResources(t.db, b.org.id, a.project.id, page)).toEqual([]);
  });

  test("deleting the project deletes its resources", async () => {
    const w = await world();
    const row = await upsertResource(t.db, bucket(w));
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(await getResource(t.db, w.org.id, w.project.id, row?.id as string)).toBeUndefined();
  });
});

describe("a resource's state is read from its stack", () => {
  const SHA = "a".repeat(40);
  const run = (w: World, stacks: string[], kind: "plan" | "drift" = "plan") =>
    createRun(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      ref: kind === "drift" ? "main" : "feature/files",
      sha: SHA,
      stacks,
      kind,
    });
  /** Walks one stack of a run through the states, each move from the one before. */
  const walk = async (w: World, runId: string, stack: string, ...states: RunState[]) => {
    let from: RunState = "queued";
    for (const to of states) {
      await moveRunStack(t.db, w.org.id, w.project.id, runId, stack, from, to);
      from = to;
    }
  };
  const WAYS: Record<RunState, RunState[]> = {
    queued: [],
    planning: ["planning"],
    planned: ["planning", "planned"],
    applying: ["planning", "planned", "applying"],
    applied: ["planning", "planned", "applying", "applied"],
    failed: ["failed"],
    discarded: ["planning", "planned", "discarded"],
    canceled: ["canceled"],
  };
  const stateOf = async (w: World, stack = "staging-files-bucket") =>
    (await resourceStates(t.db, w.org.id, w.project.id, [stack])).get(stack);

  test("a stack no run has touched is proposed", async () => {
    const w = await world();
    expect(await stateOf(w)).toBe("proposed");
  });

  const FRESH: Record<RunState, ResourceState> = {
    queued: "proposed",
    planning: "proposed",
    planned: "proposed",
    applying: "applying",
    applied: "ready",
    failed: "failed",
    discarded: "proposed",
    canceled: "proposed",
  };
  for (const state of RUN_STATES) {
    test(`a stack that is ${state}, never applied before: ${FRESH[state]}`, async () => {
      const w = await world();
      const r = await run(w, ["staging-files-bucket"]);
      await walk(w, r.id, "staging-files-bucket", ...WAYS[state]);
      expect(await stateOf(w)).toBe(FRESH[state]);
    });
  }

  test("a plan on a resource that was applied leaves it ready; a failure or an apply does not", async () => {
    const w = await world();
    const stack = "staging-files-bucket";
    const first = await run(w, [stack]);
    await walk(w, first.id, stack, ...WAYS.applied);
    expect(await stateOf(w)).toBe("ready");
    for (const state of ["queued", "planning", "planned", "discarded", "canceled"] as const) {
      const next = await run(w, [stack]);
      await walk(w, next.id, stack, ...WAYS[state]);
      expect([state, await stateOf(w)]).toEqual([state, "ready"]);
    }
    const failing = await run(w, [stack]);
    await walk(w, failing.id, stack, ...WAYS.failed);
    expect(await stateOf(w)).toBe("failed");
    const applying = await run(w, [stack]);
    await walk(w, applying.id, stack, ...WAYS.applying);
    expect(await stateOf(w)).toBe("applying");
  });

  test("the newest run decides, not the first or the one that finished last", async () => {
    const w = await world();
    const stack = "staging-files-bucket";
    const older = await run(w, [stack]);
    const newer = await run(w, [stack]);
    await walk(w, newer.id, stack, ...WAYS.failed);
    await walk(w, older.id, stack, ...WAYS.applied);
    // `older` applied after `newer` failed, but `newer` is the later proposal
    expect(await stateOf(w)).toBe("failed");
  });

  test("a scheduled drift plan is no state of a resource", async () => {
    const w = await world();
    const stack = "staging-files-bucket";
    const applied = await run(w, [stack]);
    await walk(w, applied.id, stack, ...WAYS.applied);
    const drift = await run(w, [stack], "drift");
    await walk(w, drift.id, stack, ...WAYS.failed);
    expect(await stateOf(w)).toBe("ready");
  });

  test("another project's stack of the same name does not count", async () => {
    const a = await world();
    const b = await world();
    const stack = "staging-files-bucket";
    const r = await run(b, [stack]);
    await walk(b, r.id, stack, ...WAYS.applied);
    expect(await stateOf(a)).toBe("proposed");
    expect(await stateOf(b)).toBe("ready");
  });

  test("many stacks are answered at once, and each is asked about by name", async () => {
    const w = await world();
    const r = await run(w, ["aa-x-bucket", "bb-x-bucket"]);
    await walk(w, r.id, "aa-x-bucket", ...WAYS.applied);
    await walk(w, r.id, "bb-x-bucket", ...WAYS.failed);
    const states = await resourceStates(t.db, w.org.id, w.project.id, [
      "aa-x-bucket",
      "bb-x-bucket",
      "cc-x-bucket",
    ]);
    expect([...states]).toEqual([
      ["aa-x-bucket", "ready"],
      ["bb-x-bucket", "failed"],
      ["cc-x-bucket", "proposed"],
    ]);
    expect(await resourceStates(t.db, w.org.id, w.project.id, [])).toEqual(new Map());
  });
});

describe("a resource's links come from its stack's state", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
  const STACK = "staging-files-bucket";
  const of = (w: World, stack = STACK) => ({
    organizationId: w.org.id,
    projectId: w.project.id,
    stack,
  });
  const LINKS = { url: "https://files.example.com", consoleUrl: "https://console.example.com/b/1" };
  const stored = async (w: World) => (await listResources(t.db, w.org.id, w.project.id, page))[0];

  test("a new resource has none and no time they were read", async () => {
    const w = await world();
    expect(await upsertResource(t.db, bucket(w))).toMatchObject({
      url: null,
      consoleUrl: null,
      outputsAt: null,
    });
  });

  test("the newest plan's links are kept with when that plan was asked for", async () => {
    const w = await world();
    await upsertResource(t.db, bucket(w));
    expect(await recordResourceOutputs(t.db, of(w), LINKS, at(10))).toBe(true);
    expect(await stored(w)).toMatchObject({ ...LINKS, outputsAt: at(10) });

    expect(await recordResourceOutputs(t.db, of(w), { url: "https://b.example.com" }, at(20))).toBe(
      true,
    );
    // a link the state no longer has is gone, not kept from before
    expect(await stored(w)).toMatchObject({
      url: "https://b.example.com",
      consoleUrl: null,
      outputsAt: at(20),
    });
    await recordResourceOutputs(t.db, of(w), {}, at(30));
    expect(await stored(w)).toMatchObject({ url: null, consoleUrl: null, outputsAt: at(30) });
  });

  test("a plan that was asked for earlier, and arrives later, changes nothing; the same one again does", async () => {
    const w = await world();
    await upsertResource(t.db, bucket(w));
    await recordResourceOutputs(t.db, of(w), LINKS, at(20));

    expect(
      await recordResourceOutputs(t.db, of(w), { url: "https://old.example.com" }, at(10)),
    ).toBe(false);
    expect(await stored(w)).toMatchObject({ ...LINKS, outputsAt: at(20) });
    expect(await recordResourceOutputs(t.db, of(w), LINKS, at(20))).toBe(true);
  });

  test("a stack no resource has is answered false, and another project's is not touched", async () => {
    const a = await world();
    const b = await world();
    await upsertResource(t.db, bucket(a));
    await upsertResource(t.db, bucket(b));

    expect(await recordResourceOutputs(t.db, of(a, "staging-other-bucket"), LINKS, at(10))).toBe(
      false,
    );
    expect(
      await recordResourceOutputs(t.db, { ...of(a), projectId: b.project.id }, LINKS, at(10)),
    ).toBe(false);
    expect(
      await recordResourceOutputs(t.db, { ...of(a), organizationId: b.org.id }, LINKS, at(10)),
    ).toBe(false);
    expect(await stored(a)).toMatchObject({ url: null, consoleUrl: null });
    expect(await stored(b)).toMatchObject({ url: null, consoleUrl: null });
  });

  test("a repeat proposal keeps them", async () => {
    const w = await world();
    await upsertResource(t.db, bucket(w));
    await recordResourceOutputs(t.db, of(w), LINKS, at(10));
    await upsertResource(t.db, bucket(w, { inputs: { versioning: false } }));
    expect(await stored(w)).toMatchObject({ ...LINKS, outputsAt: at(10) });
  });

  test("the database refuses what is not an http(s) link of at most 300 printable characters", async () => {
    const w = await world();
    await upsertResource(t.db, bucket(w));
    const bad: [string, { url?: string; consoleUrl?: string }][] = [
      ["a script link", { url: "javascript:alert(1)" }],
      ["a link with a space", { url: "https://a.example.com/x y" }],
      ["a link with a trailing newline", { consoleUrl: "https://a.example.com/\n" }],
      ["a link with a control character", { url: "https://a.example.com/\u0007" }],
      ["a link with a non-ASCII character", { url: "https://a.example.com/é" }],
      ["a link over 300 characters", { url: `https://a.example.com/${"a".repeat(300)}` }],
      ["no host", { url: "https://" }],
    ];
    for (const [what, links] of bad) {
      const r = await refusedBy(recordResourceOutputs(t.db, of(w), links, at(10)));
      expect([what, r]).toEqual([what, "resources_outputs_check"]);
    }
    expect(await stored(w)).toMatchObject({ url: null, consoleUrl: null, outputsAt: null });
    // 300 exactly is fine
    const edge = `https://a.example.com/${"a".repeat(300 - 22)}`;
    expect(edge).toHaveLength(300);
    expect(await recordResourceOutputs(t.db, of(w), { url: edge }, at(10))).toBe(true);
  });
});
