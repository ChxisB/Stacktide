import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import { stacks } from "./schema";
import { listStacks, type NewStack, syncStacks } from "./stacks";
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

const stack = (name: string, path = name, extra: Partial<NewStack> = {}): NewStack => ({
  name,
  path,
  tool: "tofu",
  version: null,
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command",
  backend: "http",
  ...extra,
});

// a scan that read every stack of the repository: what is not in it is gone
const mirror = (db: TestDb["db"], organizationId: string, projectId: string, input: NewStack[]) =>
  syncStacks(db, organizationId, projectId, input, { prune: true });

describe("syncStacks", () => {
  test("stores what the scan found, and lists it by directory", async () => {
    const { org, project } = await world();
    const full = stack("net", "infra/net", {
      tool: "terragrunt",
      version: "1.9.8",
      tags: ["prod", "eu"],
      dependsOn: ["base"],
      watch: ["modules/**"],
      applyOn: "merge",
      backend: "unchecked",
    });
    const r = await mirror(t.db, org.id, project.id, [full, stack("base", "infra/base")]);
    expect(r).toEqual({ added: ["net", "base"], removed: [] });
    const rows = await listStacks(t.db, org.id, project.id);
    expect(rows.map((s) => s.path)).toEqual(["infra/base", "infra/net"]);
    expect(rows[1]).toMatchObject(full);
    expect(rows[0]).toMatchObject({ tags: [], dependsOn: [], watch: [], version: null });
  });

  test("a stack that is still there keeps its id, and each of its fields can change and change back", async () => {
    const { org, project } = await world();
    const original = stack("a", "a");
    await mirror(t.db, org.id, project.id, [original]);
    const [first] = await listStacks(t.db, org.id, project.id);
    const changes: Array<Partial<NewStack>> = [
      { path: "moved/a" },
      { tool: "terraform" },
      { version: "1.0.0" },
      { tags: ["x", "y"] },
      { dependsOn: ["b"] },
      { watch: ["m/**"] },
      { applyOn: "merge" },
      { backend: "none" },
    ];
    for (const change of changes) {
      let [seen] = await listStacks(t.db, org.id, project.id);
      for (const to of [change, original]) {
        const next = { ...original, ...to };
        const r = await mirror(t.db, org.id, project.id, [next]);
        expect(r).toEqual({ added: [], removed: [] });
        const [after] = await listStacks(t.db, org.id, project.id);
        expect(after).toMatchObject(next);
        expect(after?.id).toBe(first?.id);
        expect(after && seen && after.updatedAt > seen.updatedAt).toBe(true);
        seen = after;
      }
    }
  });

  test("a stack that left the repository leaves the table, and an empty scan empties it", async () => {
    const { org, project } = await world();
    await mirror(t.db, org.id, project.id, [stack("a"), stack("b"), stack("c")]);
    expect(await mirror(t.db, org.id, project.id, [stack("b")])).toEqual({
      added: [],
      removed: ["a", "c"],
    });
    expect((await listStacks(t.db, org.id, project.id)).map((s) => s.name)).toEqual(["b"]);
    expect(await mirror(t.db, org.id, project.id, [])).toEqual({
      added: [],
      removed: ["b"],
    });
    expect(await listStacks(t.db, org.id, project.id)).toEqual([]);
  });

  test("two stacks can swap directories, and a name can move on to a freed directory", async () => {
    const { org, project } = await world();
    await mirror(t.db, org.id, project.id, [stack("a", "x"), stack("b", "y")]);
    await mirror(t.db, org.id, project.id, [stack("a", "y"), stack("b", "x")]);
    const rows = await listStacks(t.db, org.id, project.id);
    expect(rows.map((s) => [s.name, s.path])).toEqual([
      ["b", "x"],
      ["a", "y"],
    ]);
  });

  test("a repeated scan changes nothing", async () => {
    const { org, project } = await world();
    const input = [stack("a"), stack("b", "b", { dependsOn: ["a"] })];
    await mirror(t.db, org.id, project.id, input);
    const first = await listStacks(t.db, org.id, project.id);
    expect(await mirror(t.db, org.id, project.id, input)).toEqual({
      added: [],
      removed: [],
    });
    expect(await listStacks(t.db, org.id, project.id)).toEqual(first);
  });

  test("without prune nothing is deleted: a stack the scan could not read stays", async () => {
    const { org, project } = await world();
    await mirror(t.db, org.id, project.id, [
      stack("a"),
      stack("broken", "broken", { tags: ["old"] }),
    ]);
    const r = await syncStacks(t.db, org.id, project.id, [stack("a", "a2"), stack("new")], {
      prune: false,
    });
    expect(r).toEqual({ added: ["new"], removed: [] });
    const rows = await listStacks(t.db, org.id, project.id);
    expect(rows.map((s) => [s.name, s.path])).toEqual([
      ["a", "a2"],
      ["broken", "broken"],
      ["new", "new"],
    ]);
    // and an empty scan without prune changes nothing
    expect(await syncStacks(t.db, org.id, project.id, [], { prune: false })).toEqual({
      added: [],
      removed: [],
    });
    expect(await listStacks(t.db, org.id, project.id)).toHaveLength(3);
  });

  test("another project's stacks are not touched, even with the same names", async () => {
    const { org, project } = await world();
    const other = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
    await mirror(t.db, org.id, other.id, [stack("a"), stack("keep")]);
    await mirror(t.db, org.id, project.id, [stack("a")]);
    await mirror(t.db, org.id, project.id, []);
    expect((await listStacks(t.db, org.id, other.id)).map((s) => s.name)).toEqual(["a", "keep"]);
  });

  test("two stacks with one name or one directory are refused whole, and nothing is written", async () => {
    const { org, project } = await world();
    await mirror(t.db, org.id, project.id, [stack("old")]);
    await expect(
      mirror(t.db, org.id, project.id, [stack("a", "x"), stack("a", "y")]),
    ).rejects.toThrow("share a name or a directory");
    await expect(
      mirror(t.db, org.id, project.id, [stack("a", "x"), stack("b", "x")]),
    ).rejects.toThrow("share a name or a directory");
    expect((await listStacks(t.db, org.id, project.id)).map((s) => s.name)).toEqual(["old"]);
  });

  test("a project of another organization is refused, and the organization's view stays empty", async () => {
    const { org, project } = await world();
    const { org: stranger } = await world();
    await expect(mirror(t.db, stranger.id, project.id, [stack("a")])).rejects.toThrow(
      "project not found",
    );
    await mirror(t.db, org.id, project.id, [stack("a")]);
    expect(await listStacks(t.db, stranger.id, project.id)).toEqual([]);
  });

  test("a failed write rolls the whole replacement back", async () => {
    const { org, project } = await world();
    await mirror(t.db, org.id, project.id, [stack("a"), stack("b")]);
    // the second row breaks a check, after the first row and the delete went through
    const bad = stack("c", "c", { tool: "pulumi" as unknown as NewStack["tool"] });
    await expect(mirror(t.db, org.id, project.id, [stack("a", "a2"), bad])).rejects.toThrow();
    const rows = await listStacks(t.db, org.id, project.id);
    expect(rows.map((s) => [s.name, s.path])).toEqual([
      ["a", "a"],
      ["b", "b"],
    ]);
  });

  test("two scans of one project at once end as one of them, whole", async () => {
    const { org, project } = await world();
    const one = [stack("a"), stack("b")];
    const two = [stack("c"), stack("d")];
    await Promise.all([
      mirror(t.db, org.id, project.id, one),
      mirror(t.db, org.id, project.id, two),
    ]);
    const names = (await listStacks(t.db, org.id, project.id)).map((s) => s.name);
    expect([
      ["a", "b"],
      ["c", "d"],
    ]).toContainEqual(names);
  });
});

describe("the stacks table", () => {
  test("the database holds the rules too: name, tool, apply_on and backend", async () => {
    const { org, project } = await world();
    const row = (extra: object) => ({
      organizationId: org.id,
      projectId: project.id,
      ...stack("ok"),
      ...extra,
    });
    for (const [check, extra] of [
      ["stacks_name_check", { name: "Bad Name" }],
      ["stacks_name_check", { name: "a;b" }],
      ["stacks_path_check", { path: "a b" }],
      ["stacks_path_check", { path: "a;rm -rf" }],
      ["stacks_path_check", { path: "$(id)" }],
      ["stacks_path_check", { path: "-rf" }],
      ["stacks_path_check", { path: "a/-b" }],
      ["stacks_path_check", { path: "a/../b" }],
      ["stacks_path_check", { path: ".." }],
      ["stacks_path_check", { path: "a/./b" }],
      ["stacks_path_check", { path: "/abs" }],
      ["stacks_path_check", { path: "a/" }],
      ["stacks_path_check", { path: "a\nb" }],
      ["stacks_path_check", { path: "" }],
      ["stacks_tool_check", { tool: "pulumi" }],
      ["stacks_apply_on_check", { applyOn: "always" }],
      ["stacks_backend_check", { backend: "s3" }],
    ] as const) {
      const error = await t.db
        .insert(stacks)
        .values(row(extra) as never)
        .then(
          () => null,
          (e) => e,
        );
      expect(pgConstraint(error)).toBe(check);
    }
  });

  test("a DNS zone is a stack like any other, with a version and no state to judge", async () => {
    const { org, project } = await world();
    await mirror(t.db, org.id, project.id, [
      stack("zone", "dns", { tool: "dnscontrol", version: "5.5.0", backend: "unchecked" }),
    ]);
    const [row] = await listStacks(t.db, org.id, project.id);
    expect(row).toMatchObject({ name: "zone", tool: "dnscontrol", version: "5.5.0" });
  });

  test("a path may be the root, hidden, versioned, or nested", async () => {
    const { org, project } = await world();
    const ok = [".", ".github/x", "v1.2/app_1", "a@b/c+d=e", "a..b/c"];
    await mirror(
      t.db,
      org.id,
      project.id,
      ok.map((path, i) => stack(`s${i}`, path)),
    );
    expect((await listStacks(t.db, org.id, project.id)).map((s) => s.path).sort()).toEqual(
      [...ok].sort(),
    );
  });

  test("a name is unique in a project, not across projects", async () => {
    const { org, project } = await world();
    const other = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
    const values = (projectId: string) => ({ organizationId: org.id, projectId, ...stack("dup") });
    await t.db.insert(stacks).values(values(project.id));
    const error = await t.db
      .insert(stacks)
      .values(values(project.id))
      .then(
        () => null,
        (e) => e,
      );
    expect(pgConstraint(error)).toBe("stacks_project_name_key");
    await t.db.insert(stacks).values(values(other.id));
  });

  test("a stack stays in its project's organization", async () => {
    const { project } = await world();
    const { org: stranger } = await world();
    const error = await t.db
      .insert(stacks)
      .values({ organizationId: stranger.id, projectId: project.id, ...stack("a") })
      .then(
        () => null,
        (e) => e,
      );
    expect(pgConstraint(error)).toBe("stacks_project_org_fk");
  });

  test("deleting the project deletes its stacks", async () => {
    const { org, project } = await world();
    await mirror(t.db, org.id, project.id, [stack("a")]);
    await deleteProject(t.db, org.id, project.id);
    expect(await t.db.select().from(stacks).where(eq(stacks.projectId, project.id))).toEqual([]);
  });
});
