import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DetectedType } from "@orch/core";
import { eq } from "drizzle-orm";
import { importProject, linkedProjects } from "./imports";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, getProject, updateProject } from "./repo";
import { projects } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

let n = 0;
const org = () => createOrganization(t.db, { slug: `o${++n}`, name: "O" });
const bun: DetectedType = { tag: "bun", confidence: "high", evidence: ["bun.lock"] };
const docker: DetectedType = { tag: "docker", confidence: "high", evidence: ["Dockerfile"] };
const input = (
  organizationId: string,
  over: Partial<Parameters<typeof importProject>[1]> = {},
) => ({
  organizationId,
  gitlabProjectId: 101,
  name: "group/repo",
  defaultBranch: "trunk" as string | null,
  types: [bun],
  ...over,
});

describe("importProject", () => {
  test("creates a project linked to the GitLab project, with its branch and types", async () => {
    const o = await org();
    const { project, created } = await importProject(t.db, input(o.id));
    expect(created).toBe(true);
    expect(project).toMatchObject({
      organizationId: o.id,
      gitlabProjectId: 101,
      name: "group/repo",
      defaultBranch: "trunk",
      detectedTypes: [bun],
    });
    expect(Object.keys(project)).not.toContain("created");
    expect(await getProject(t.db, o.id, project.id)).toEqual(project);
  });

  test("importing again is the same project, with branch and types refreshed", async () => {
    const o = await org();
    const first = await importProject(t.db, input(o.id));
    const again = await importProject(
      t.db,
      input(o.id, { defaultBranch: "main", types: [bun, docker] }),
    );
    expect(again.created).toBe(false);
    expect(again.project.id).toBe(first.project.id);
    expect(again.project).toMatchObject({ defaultBranch: "main", detectedTypes: [bun, docker] });
    expect(
      await t.db.select().from(projects).where(eq(projects.organizationId, o.id)),
    ).toHaveLength(1);
    const same = await importProject(
      t.db,
      input(o.id, { defaultBranch: "main", types: [bun, docker] }),
    );
    expect([same.created, same.project.id]).toEqual([false, first.project.id]);
  });

  test("a refresh keeps a name that was changed since, and a branch an empty repository lacks", async () => {
    const o = await org();
    const { project } = await importProject(t.db, input(o.id));
    await updateProject(t.db, o.id, project.id, { name: "renamed" });
    const again = await importProject(t.db, input(o.id, { defaultBranch: null, types: [] }));
    expect(again.project).toMatchObject({
      name: "renamed",
      defaultBranch: "trunk",
      detectedTypes: [],
    });
  });

  test("an empty repository is imported on the default branch name", async () => {
    const o = await org();
    const { project } = await importProject(t.db, input(o.id, { defaultBranch: null, types: [] }));
    expect(project).toMatchObject({ defaultBranch: "main", detectedTypes: [] });
  });

  test("organizations import the same GitLab project independently", async () => {
    const [a, b] = [await org(), await org()];
    const [pa, pb] = [
      await importProject(t.db, input(a.id)),
      await importProject(t.db, input(b.id)),
    ];
    expect([pa.created, pb.created]).toEqual([true, true]);
    expect(pa.project.id).not.toBe(pb.project.id);
  });

  test("a name another project holds is a unique violation, and changes nothing", async () => {
    const o = await org();
    await createProject(t.db, { organizationId: o.id, name: "group/repo" });
    const e = await importProject(t.db, input(o.id)).catch((x) => x);
    expect(pgConstraint(e)).toBe("projects_org_name_key");
    expect(
      await t.db.select().from(projects).where(eq(projects.organizationId, o.id)),
    ).toHaveLength(1);
  });

  test("adopts a project that was linked by hand", async () => {
    const o = await org();
    const mine = await createProject(t.db, {
      organizationId: o.id,
      name: "mine",
      gitlabProjectId: 101,
    });
    const { project, created } = await importProject(t.db, input(o.id));
    expect([created, project.id, project.name]).toEqual([false, mine.id, "mine"]);
    expect(project.detectedTypes).toEqual([bun]);
  });

  test("new projects start with no types", async () => {
    const o = await org();
    const p = await createProject(t.db, { organizationId: o.id, name: "plain" });
    expect(p.detectedTypes).toEqual([]);
  });
});

describe("linkedProjects", () => {
  test("finds the projects of this organization that are linked to those GitLab projects", async () => {
    const [a, b] = [await org(), await org()];
    const pa = await importProject(t.db, input(a.id, { gitlabProjectId: 201 }));
    await importProject(t.db, input(b.id, { gitlabProjectId: 202 }));
    expect(await linkedProjects(t.db, a.id, [201, 202, 203])).toEqual([
      { id: pa.project.id, gitlabProjectId: 201 },
    ]);
    expect(await linkedProjects(t.db, a.id, [])).toEqual([]);
  });
});
