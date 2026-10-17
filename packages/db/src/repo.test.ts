import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { pgCode } from "./pg-error";
import {
  createEnvironment,
  createOrganization,
  createProject,
  deleteOrganization,
  deleteProject,
  getProject,
  listEnvironments,
} from "./repo";
import { projects } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const uniq = () => crypto.randomUUID().slice(0, 8);
const newOrg = () => createOrganization(t.db, { slug: `org-${uniq()}`, name: "Org" });
const code = async (p: Promise<unknown>) => pgCode(await p.catch((e) => e));

describe("insert", () => {
  test("rows get time-ordered v7 ids, timestamps and defaults", async () => {
    const org = await newOrg();
    const project = await createProject(t.db, { organizationId: org.id, name: "api" });
    expect(org.id[14]).toBe("7");
    expect(project.id[14]).toBe("7");
    expect(project.defaultBranch).toBe("main");
    expect(project.gitlabProjectId).toBeNull();
    expect(project.createdAt).toBeInstanceOf(Date);
    expect(await getProject(t.db, org.id, project.id)).toEqual(project);
  });

  test("a missing row reads as undefined", async () => {
    const org = await newOrg();
    expect(await getProject(t.db, org.id, Bun.randomUUIDv7())).toBeUndefined();
  });

  test("gitlab_project_id holds ids beyond 32 bits", async () => {
    const org = await newOrg();
    const p = await createProject(t.db, {
      organizationId: org.id,
      name: "big",
      gitlabProjectId: 5_000_000_000,
    });
    expect((await getProject(t.db, org.id, p.id))?.gitlabProjectId).toBe(5_000_000_000);
  });

  test("updated_at moves when a row changes", async () => {
    const org = await newOrg();
    // Start from an old timestamp: two back-to-back statements can share a millisecond.
    const old = new Date("2000-01-01T00:00:00Z");
    const p = await createProject(t.db, { organizationId: org.id, name: "touch", updatedAt: old });
    await t.db.update(projects).set({ defaultBranch: "trunk" }).where(eq(projects.id, p.id));
    const after = await getProject(t.db, org.id, p.id);
    expect(after?.defaultBranch).toBe("trunk");
    expect(after?.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test("ids default to a v7 uuid in the database too (raw SQL inserts)", async () => {
    const rows = await t.db.execute(
      sql`INSERT INTO organizations (slug, name) VALUES (${`raw-${uniq()}`}, 'Raw') RETURNING id`,
    );
    expect(String(rows[0]?.id)[14]).toBe("7");
  });
});

describe("organization scoping", () => {
  test("another organization cannot read, list or delete a project by id", async () => {
    const [mine, theirs] = [await newOrg(), await newOrg()];
    const p = await createProject(t.db, { organizationId: mine.id, name: "private" });
    await createEnvironment(t.db, {
      organizationId: mine.id,
      projectId: p.id,
      name: "Prod",
      slug: "prod",
    });
    expect(await getProject(t.db, theirs.id, p.id)).toBeUndefined();
    expect(await listEnvironments(t.db, theirs.id, p.id)).toHaveLength(0);
    expect(await deleteProject(t.db, theirs.id, p.id)).toBe(false);
    expect(await getProject(t.db, mine.id, p.id)).toBeDefined();
    expect(await listEnvironments(t.db, mine.id, p.id)).toHaveLength(1);
  });

  test("deleting something that does not exist reports false", async () => {
    const org = await newOrg();
    expect(await deleteProject(t.db, org.id, Bun.randomUUIDv7())).toBe(false);
    expect(await deleteOrganization(t.db, Bun.randomUUIDv7())).toBe(false);
  });
});

describe("transactions", () => {
  test("repo functions run inside a transaction and roll back with it", async () => {
    const org = await newOrg();
    const slug = `tx-${uniq()}`;
    const run = t.db.transaction(async (tx) => {
      await createProject(tx, { organizationId: org.id, name: slug });
      throw new Error("abort");
    });
    await expect(run).rejects.toThrow("abort");
    const rows = await t.db.select().from(projects).where(eq(projects.name, slug));
    expect(rows).toHaveLength(0);
  });
});

describe("unique constraints", () => {
  test("organization slug is unique", async () => {
    const org = await newOrg();
    expect(await code(createOrganization(t.db, { slug: org.slug, name: "x" }))).toBe("23505");
  });

  test("project name is unique per organization, not globally", async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    await createProject(t.db, { organizationId: a.id, name: "same" });
    expect(await code(createProject(t.db, { organizationId: a.id, name: "same" }))).toBe("23505");
    await createProject(t.db, { organizationId: b.id, name: "same" });
  });

  test("a GitLab project links once per organization; unlinked projects do not collide", async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    await createProject(t.db, { organizationId: a.id, name: "one", gitlabProjectId: 42 });
    expect(
      await code(createProject(t.db, { organizationId: a.id, name: "two", gitlabProjectId: 42 })),
    ).toBe("23505");
    await createProject(t.db, { organizationId: b.id, name: "one", gitlabProjectId: 42 });
    await createProject(t.db, { organizationId: a.id, name: "n1" });
    await createProject(t.db, { organizationId: a.id, name: "n2" });
  });

  test("environment slug is unique per project, not globally", async () => {
    const org = await newOrg();
    const [p1, p2] = [
      await createProject(t.db, { organizationId: org.id, name: "p1" }),
      await createProject(t.db, { organizationId: org.id, name: "p2" }),
    ];
    const env = (project: typeof p1, slug: string) =>
      createEnvironment(t.db, {
        organizationId: org.id,
        projectId: project.id,
        name: slug,
        slug,
      });
    await env(p1, "prod");
    expect(await code(env(p1, "prod"))).toBe("23505");
    await env(p2, "prod");
  });
});

describe("references", () => {
  test("a project needs an existing organization", async () => {
    expect(
      await code(createProject(t.db, { organizationId: Bun.randomUUIDv7(), name: "orphan" })),
    ).toBe("23503");
  });

  test("an environment cannot claim a different organization than its project", async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    const p = await createProject(t.db, { organizationId: a.id, name: "mine" });
    const bad = createEnvironment(t.db, {
      organizationId: b.id,
      projectId: p.id,
      name: "prod",
      slug: "prod",
    });
    expect(await code(bad)).toBe("23503");
  });
});

describe("delete rules", () => {
  test("deleting a project removes its environments and leaves others alone", async () => {
    const org = await newOrg();
    const [gone, kept] = [
      await createProject(t.db, { organizationId: org.id, name: "gone" }),
      await createProject(t.db, { organizationId: org.id, name: "kept" }),
    ];
    for (const p of [gone, kept]) {
      await createEnvironment(t.db, {
        organizationId: org.id,
        projectId: p.id,
        name: "Prod",
        slug: "prod",
      });
    }
    expect(await deleteProject(t.db, org.id, gone.id)).toBe(true);
    expect(await listEnvironments(t.db, org.id, gone.id)).toHaveLength(0);
    expect(await listEnvironments(t.db, org.id, kept.id)).toHaveLength(1);
  });

  test("an organization with projects cannot be deleted, an empty one can", async () => {
    const org = await newOrg();
    const p = await createProject(t.db, { organizationId: org.id, name: "keep-me" });
    // 23001 = restrict_violation (ON DELETE RESTRICT); 23503 would mean NO ACTION
    expect(await code(deleteOrganization(t.db, org.id))).toBe("23001");
    expect(await getProject(t.db, org.id, p.id)).toBeDefined();
    await deleteProject(t.db, org.id, p.id);
    expect(await deleteOrganization(t.db, org.id)).toBe(true);
  });
});

describe("listEnvironments", () => {
  test("orders by sort_order, then slug", async () => {
    const org = await newOrg();
    const p = await createProject(t.db, { organizationId: org.id, name: "ordered" });
    const add = (slug: string, sortOrder: number) =>
      createEnvironment(t.db, {
        organizationId: org.id,
        projectId: p.id,
        name: slug,
        slug,
        sortOrder,
      });
    await add("prod", 20);
    await add("staging", 10);
    await add("dev", 10);
    expect((await listEnvironments(t.db, org.id, p.id)).map((e) => e.slug)).toEqual([
      "dev",
      "staging",
      "prod",
    ]);
  });
});

describe("schema conventions", () => {
  test("every table with updated_at has the set_updated_at trigger", async () => {
    const rows = await t.db.execute(sql`
      SELECT c.table_name AS name FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
        AND NOT EXISTS (
          SELECT 1 FROM pg_trigger g
          WHERE g.tgrelid = format('public.%I', c.table_name)::regclass
            AND g.tgfoid = 'set_updated_at'::regproc AND NOT g.tgisinternal)`);
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  test("every table has created_at and updated_at", async () => {
    const rows = await t.db.execute(sql`
      SELECT t.table_name AS name FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND (SELECT count(*) FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = t.table_name
               AND c.column_name IN ('created_at', 'updated_at')) < 2`);
    expect(rows.map((r) => r.name)).toEqual([]);
  });
});
