import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { pgCode } from "./pg-error";
import {
  createEnvironment,
  createOrganization,
  createProject,
  deleteEnvironment,
  deleteOrganization,
  deleteProject,
  getEnvironment,
  getOrganization,
  getProject,
  gitlabLinks,
  listEnvironments,
  listOrganizations,
  listProjects,
  updateEnvironment,
  updateOrganization,
  updateProject,
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

  test("a GitLab group links to one organization; unlinked organizations do not collide", async () => {
    const group = 9_000_000_000 + Math.floor(Math.random() * 1e6); // beyond 32 bits
    const org = await createOrganization(t.db, {
      slug: `org-${uniq()}`,
      name: "A",
      gitlabGroupId: group,
    });
    expect(org.gitlabGroupId).toBe(group);
    expect(
      await code(
        createOrganization(t.db, { slug: `org-${uniq()}`, name: "B", gitlabGroupId: group }),
      ),
    ).toBe("23505");
    expect((await newOrg()).gitlabGroupId).toBeNull();
    await newOrg();
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

describe("update", () => {
  test("changes only the given fields, and a patch with nothing in it changes nothing", async () => {
    const org = await newOrg();
    const p = await createProject(t.db, {
      organizationId: org.id,
      name: "old",
      gitlabProjectId: 7,
    });
    const updated = await updateProject(t.db, org.id, p.id, { name: "new", gitlabProjectId: null });
    expect(updated).toMatchObject({ name: "new", gitlabProjectId: null, defaultBranch: "main" });
    expect(await updateProject(t.db, org.id, p.id, {})).toEqual(updated);
    expect(await updateProject(t.db, org.id, p.id, { name: undefined })).toEqual(updated);
    expect((await updateOrganization(t.db, org.id, { name: "Renamed" }))?.name).toBe("Renamed");
    expect((await getOrganization(t.db, org.id))?.slug).toBe(org.slug);
  });

  test("another organization, or a missing id, matches nothing", async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    const p = await createProject(t.db, { organizationId: a.id, name: "mine" });
    expect(await updateProject(t.db, b.id, p.id, { name: "stolen" })).toBeUndefined();
    expect((await getProject(t.db, a.id, p.id))?.name).toBe("mine");
    expect(await updateOrganization(t.db, Bun.randomUUIDv7(), { name: "x" })).toBeUndefined();
    expect(await updateOrganization(t.db, Bun.randomUUIDv7(), {})).toBeUndefined();
  });

  test("environments are addressed by organization, project and id", async () => {
    const org = await newOrg();
    const p = await createProject(t.db, { organizationId: org.id, name: "api" });
    const other = await createProject(t.db, { organizationId: org.id, name: "web" });
    const env = await createEnvironment(t.db, {
      organizationId: org.id,
      projectId: p.id,
      name: "Prod",
      slug: "prod",
    });
    expect(await getEnvironment(t.db, org.id, other.id, env.id)).toBeUndefined();
    expect(await updateEnvironment(t.db, org.id, other.id, env.id, { name: "x" })).toBeUndefined();
    expect(await deleteEnvironment(t.db, org.id, other.id, env.id)).toBe(false);
    expect(await updateEnvironment(t.db, org.id, p.id, env.id, { sortOrder: 3 })).toMatchObject({
      name: "Prod",
      sortOrder: 3,
    });
    expect(await deleteEnvironment(t.db, org.id, p.id, env.id)).toBe(true);
    expect(await getEnvironment(t.db, org.id, p.id, env.id)).toBeUndefined();
  });
});

describe("keyset pagination", () => {
  /** Walks every page and returns what each page held. */
  async function walk<T, K>(
    fetch: (after: K | undefined) => Promise<T[]>,
    key: (row: T) => K,
  ): Promise<T[][]> {
    const pages: T[][] = [];
    for (let after: K | undefined, i = 0; i < 20; i++) {
      const page = await fetch(after);
      if (page.length === 0) break;
      pages.push(page);
      after = key(page[page.length - 1] as T);
    }
    return pages;
  }

  test("projects come back in creation order, none skipped or repeated", async () => {
    const org = await newOrg();
    for (let i = 0; i < 5; i++) {
      await createProject(t.db, { organizationId: org.id, name: `p${i}` });
    }
    const other = await newOrg();
    await createProject(t.db, { organizationId: other.id, name: "elsewhere" });
    const pages = await walk(
      (after?: string) => listProjects(t.db, org.id, { after, limit: 2 }),
      (p) => p.id,
    );
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat().map((p) => p.name)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(await listProjects(t.db, org.id, { limit: 100 })).toHaveLength(5);
  });

  test("organizations page by id", async () => {
    const made = [await newOrg(), await newOrg(), await newOrg()];
    const first = await listOrganizations(t.db, { limit: 1000 });
    const ids = first.map((o) => o.id);
    expect(ids).toEqual([...ids].sort());
    const from = made[0]?.id;
    const rest = await listOrganizations(t.db, { after: from, limit: 1000 });
    expect(rest.map((o) => o.id)).toEqual(ids.slice(ids.indexOf(from as string) + 1));
  });

  test("environments page by (sort_order, slug), also across equal sort orders", async () => {
    const org = await newOrg();
    const p = await createProject(t.db, { organizationId: org.id, name: "api" });
    const specs: [string, number][] = [
      ["b", 1],
      ["a", 1],
      ["z", 0],
      ["c", 1],
      ["y", 2],
    ];
    for (const [slug, sortOrder] of specs) {
      await createEnvironment(t.db, {
        organizationId: org.id,
        projectId: p.id,
        name: slug,
        slug,
        sortOrder,
      });
    }
    const pages = await walk(
      (after?: [number, string]) => listEnvironments(t.db, org.id, p.id, { after, limit: 2 }),
      (e): [number, string] => [e.sortOrder, e.slug],
    );
    expect(pages.flat().map((e) => e.slug)).toEqual(["z", "a", "b", "c", "y"]);
    expect(pages.map((x) => x.length)).toEqual([2, 2, 1]);
    expect((await listEnvironments(t.db, org.id, p.id)).map((e) => e.slug)).toEqual([
      "z",
      "a",
      "b",
      "c",
      "y",
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

  // Append-only tables have a single timestamp (`at`, `created_at`): an `updated_at` could never change.
  // ci_tokens rows are written once and then only expire or cascade away; webhook_deliveries rows
  // are inserted once (their job id is set in the same transaction) and cascade away.
  test("every table has created_at and updated_at, append-only ones excepted", async () => {
    const rows = await t.db.execute(sql`
      SELECT t.table_name AS name FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND t.table_name NOT IN ('audit_events', 'ci_tokens', 'webhook_deliveries')
        AND (SELECT count(*) FROM information_schema.columns c
             WHERE c.table_schema = 'public' AND c.table_name = t.table_name
               AND c.column_name IN ('created_at', 'updated_at')) < 2`);
    expect(rows.map((r) => r.name)).toEqual([]);
  });
});

describe("gitlabLinks", () => {
  test("lists exactly the linked organizations and projects, with their platform ids", async () => {
    const group = 8_000_000_000 + Math.floor(Math.random() * 1e6);
    const gitlabProject = 7_000_000_000 + Math.floor(Math.random() * 1e6);
    const linked = await createOrganization(t.db, {
      slug: `org-${uniq()}`,
      name: "L",
      gitlabGroupId: group,
    });
    const plain = await newOrg();
    const p1 = await createProject(t.db, {
      organizationId: plain.id,
      name: "a",
      gitlabProjectId: gitlabProject,
    });
    await createProject(t.db, { organizationId: plain.id, name: "b" });
    const links = await gitlabLinks(t.db);
    expect(links.groups).toContainEqual({ organizationId: linked.id, gitlabGroupId: group });
    expect(links.groups.map((g) => g.organizationId)).not.toContain(plain.id);
    expect(links.projects).toContainEqual({ projectId: p1.id, gitlabProjectId: gitlabProject });
    expect(
      links.projects.filter((p) => p.projectId !== p1.id && p.gitlabProjectId === gitlabProject),
    ).toEqual([]);
    // Unlinking removes it again.
    await updateProject(t.db, plain.id, p1.id, { gitlabProjectId: null });
    expect((await gitlabLinks(t.db)).projects.map((p) => p.projectId)).not.toContain(p1.id);
  });
});
