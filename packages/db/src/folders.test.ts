import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq } from "drizzle-orm";
import {
  createFolder,
  deleteFolder,
  folderVariableCounts,
  getFolderByPath,
  listFolders,
  lockFolderById,
  renameFolder,
} from "./folders";
import { pgConstraint } from "./pg-error";
import { createEnvironment, createOrganization, createProject, deleteProject } from "./repo";
import { variableFolders } from "./schema";
import { createTestDb, type TestDb } from "./testing";
import { createVariable, deleteVariable, searchVariables } from "./variables";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const variableIn = (w: World, folder: string, key = "K") =>
  createVariable(t.db, keys, {
    ...at(w),
    key,
    kind: "plain",
    value: "v",
    folder,
    actor: { kind: "user", id: "u1" },
  });

let n = 0;
async function world() {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
  return { org, project };
}
type World = Awaited<ReturnType<typeof world>>;
const at = (w: World) => ({ organizationId: w.org.id, projectId: w.project.id });
const make = async (w: World, parent: string, name: string) => {
  const made = await createFolder(t.db, { ...at(w), parent, name });
  if (!("row" in made)) throw new Error(`no folder: ${made.error}`);
  return made.row;
};
const paths = async (w: World) => (await listFolders(t.db, w.project.id)).map((f) => f.path);
const refusedBy = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return pgConstraint(e) ?? e;
  }
  return undefined;
};

describe("creating a folder", () => {
  test("a folder is a name under a parent, the root or a folder that is there", async () => {
    const w = await world();
    const db = await make(w, "/", "db");
    expect(db).toMatchObject({ path: "/db", projectId: w.project.id, organizationId: w.org.id });
    expect(db.deletedAt).toBeNull();
    const primary = await make(w, "/db", "primary");
    expect(primary.path).toBe("/db/primary");
    expect(await paths(w)).toEqual(["/db", "/db/primary"]);
  });

  test("a parent that is not there is refused, and nothing is made", async () => {
    const w = await world();
    expect(await createFolder(t.db, { ...at(w), parent: "/nope", name: "x" })).toEqual({
      error: "no_parent",
    });
    // a parent that is written wrongly is just a parent that is not there
    expect(await createFolder(t.db, { ...at(w), parent: "nope", name: "x" })).toEqual({
      error: "no_parent",
    });
    expect(await paths(w)).toEqual([]);
  });

  test("a parent that was deleted, or that belongs to another project, is not there", async () => {
    const w = await world();
    const other = await world();
    await make(other, "/", "shared");
    expect(await createFolder(t.db, { ...at(w), parent: "/shared", name: "x" })).toEqual({
      error: "no_parent",
    });
    const gone = await make(w, "/", "gone");
    await deleteFolder(t.db, { projectId: w.project.id, path: gone.path });
    expect(await createFolder(t.db, { ...at(w), parent: "/gone", name: "x" })).toEqual({
      error: "no_parent",
    });
  });

  test("five deep is the most: a sixth level is refused by the path check", async () => {
    const w = await world();
    let parent = "/";
    for (const name of ["a", "b", "c", "d", "e"]) parent = (await make(w, parent, name)).path;
    expect(parent).toBe("/a/b/c/d/e");
    expect(await refusedBy(createFolder(t.db, { ...at(w), parent, name: "f" }))).toBe(
      "variable_folders_path_check",
    );
  });

  test("a name outside a-z 0-9 - _ or longer than 32 is refused, and a slash is not a deeper path", async () => {
    const w = await world();
    for (const name of ["", "A", "a b", "a/b", ".", "..", "é", "x".repeat(33)]) {
      expect([name, await createFolder(t.db, { ...at(w), parent: "/", name })]).toEqual([
        name,
        { error: "bad_name" },
      ]);
    }
    expect(await paths(w)).toEqual([]);
    await make(w, "/", "x".repeat(32));
    await make(w, "/", "a-b_c0");
  });

  test("a live sibling holds its name, a deleted one does not, and projects do not share names", async () => {
    const w = await world();
    const other = await world();
    const first = await make(w, "/", "db");
    expect(await refusedBy(createFolder(t.db, { ...at(w), parent: "/", name: "db" }))).toBe(
      "variable_folders_project_path",
    );
    await make(other, "/", "db");
    await deleteFolder(t.db, { projectId: w.project.id, path: "/db" });
    const again = await make(w, "/", "db");
    expect(again.id).not.toBe(first.id);
    expect(await paths(w)).toEqual(["/db"]);
  });
});

describe("listing folders", () => {
  test("lists the live folders of one project, a parent before its children", async () => {
    const w = await world();
    const other = await world();
    await make(w, "/", "zeta");
    await make(w, "/", "alpha");
    await make(w, "/alpha", "inner");
    await make(w, "/", "alpha-two");
    await make(w, "/", "gone");
    await make(other, "/", "elsewhere");
    await deleteFolder(t.db, { projectId: w.project.id, path: "/gone" });
    const listed = await paths(w);
    expect(listed.sort()).toEqual(["/alpha", "/alpha-two", "/alpha/inner", "/zeta"]);
    // whatever the locale, a folder comes before what is under it: a tree can be built in one pass
    const ordered = await paths(w);
    expect(ordered.indexOf("/alpha")).toBeLessThan(ordered.indexOf("/alpha/inner"));
  });
});

describe("counting what a folder holds", () => {
  test("a folder counts the live variables in it at every level, and not those below it, beside it or deleted", async () => {
    const w = await world();
    const a = await make(w, "/", "a");
    const inner = await make(w, "/a", "inner");
    const empty = await make(w, "/", "empty");
    const env = await createEnvironment(t.db, {
      ...at(w),
      name: "dev",
      slug: "dev",
    });
    await variableIn(w, "/a", "ONE");
    await variableIn(w, "/a", "TWO");
    const gone = await variableIn(w, "/a", "GONE");
    await deleteVariable(t.db, at(w), gone.id);
    await variableIn(w, "/a/inner", "DEEP");
    await variableIn(w, "/", "AT_ROOT");
    await createVariable(t.db, keys, {
      ...at(w),
      environmentId: env.id,
      key: "ONE",
      kind: "plain",
      value: "v",
      folder: "/a",
      actor: { kind: "user", id: "u1" },
    });
    const counts = await folderVariableCounts(t.db, w.project.id);
    expect([counts.get(a.id), counts.get(inner.id), counts.get(empty.id)]).toEqual([
      3,
      1,
      undefined,
    ]);
    expect(counts.size).toBe(2);
  });

  test("another project's variables are not counted", async () => {
    const w = await world();
    const other = await world();
    const mine = await make(w, "/", "same");
    const theirs = await make(other, "/", "same");
    await variableIn(other, "/same");
    const counts = await folderVariableCounts(t.db, w.project.id);
    expect(counts.get(mine.id)).toBeUndefined();
    // nor is it listed: a map of every project's folders is not the project's
    expect(counts.has(theirs.id)).toBe(false);
    expect((await folderVariableCounts(t.db, other.project.id)).get(theirs.id)).toBe(1);
  });
});

describe("renaming a folder", () => {
  test("changes its name and the path of everything under it, and nothing else", async () => {
    const w = await world();
    const other = await world();
    const a = await make(w, "/", "a");
    await make(w, "/a", "b");
    await make(w, "/a/b", "c");
    await make(w, "/", "ab");
    await make(w, "/", "keep");
    await make(w, "/keep", "b");
    await make(other, "/", "a");
    const done = await renameFolder(t.db, { projectId: w.project.id, path: "/a", name: "z" });
    expect(done).toMatchObject({ row: { id: a.id, path: "/z" } });
    expect(await paths(w)).toEqual(["/ab", "/keep", "/keep/b", "/z", "/z/b", "/z/b/c"]);
    // another project's tree, and a name that only starts like the old one, were not touched
    expect(await paths(other)).toEqual(["/a"]);
  });

  test("an underscore in a name is a letter, not a wildcard: a sibling that fits the pattern is left alone", async () => {
    const w = await world();
    await make(w, "/", "a_b");
    await make(w, "/a_b", "c");
    await make(w, "/", "axb");
    await make(w, "/axb", "c");
    // `axb` has no folder under `a_b`, so deleting `/a_b/c` then `/a_b` must not be held up by `/axb/c`
    expect(await deleteFolder(t.db, { projectId: w.project.id, path: "/a_b" })).toEqual({
      error: "not_empty",
    });
    await renameFolder(t.db, { projectId: w.project.id, path: "/a_b", name: "z" });
    expect(await paths(w)).toEqual(["/axb", "/axb/c", "/z", "/z/c"]);
    await deleteFolder(t.db, { projectId: w.project.id, path: "/z/c" });
    expect(await deleteFolder(t.db, { projectId: w.project.id, path: "/z" })).toMatchObject({
      row: { path: "/z" },
    });
    expect(await paths(w)).toEqual(["/axb", "/axb/c"]);
  });

  test("renames within the same parent", async () => {
    const w = await world();
    await make(w, "/", "p");
    await make(w, "/p", "old");
    await make(w, "/p/old", "x");
    expect(
      await renameFolder(t.db, { projectId: w.project.id, path: "/p/old", name: "new" }),
    ).toMatchObject({ row: { path: "/p/new" } });
    expect(await paths(w)).toEqual(["/p", "/p/new", "/p/new/x"]);
  });

  test("a live sibling with the new name stops it, and a deleted one does not", async () => {
    const w = await world();
    await make(w, "/", "a");
    await make(w, "/", "b");
    await make(w, "/b", "child");
    expect(
      await refusedBy(renameFolder(t.db, { projectId: w.project.id, path: "/a", name: "b" })),
    ).toBe("variable_folders_project_path");
    expect(await paths(w)).toEqual(["/a", "/b", "/b/child"]);
    await deleteFolder(t.db, { projectId: w.project.id, path: "/b/child" });
    await deleteFolder(t.db, { projectId: w.project.id, path: "/b" });
    expect(
      await renameFolder(t.db, { projectId: w.project.id, path: "/a", name: "b" }),
    ).toMatchObject({ row: { path: "/b" } });
  });

  test("a folder that is not there, or was deleted, is not_found; a bad name is refused and changes nothing", async () => {
    const w = await world();
    const other = await world();
    await make(other, "/", "mine");
    expect(await renameFolder(t.db, { projectId: w.project.id, path: "/mine", name: "x" })).toEqual(
      { error: "not_found" },
    );
    await make(w, "/", "gone");
    await deleteFolder(t.db, { projectId: w.project.id, path: "/gone" });
    expect(await renameFolder(t.db, { projectId: w.project.id, path: "/gone", name: "x" })).toEqual(
      { error: "not_found" },
    );
    await make(w, "/", "ok");
    for (const name of ["No Good", "a/b", ""]) {
      expect(await renameFolder(t.db, { projectId: w.project.id, path: "/ok", name })).toEqual({
        error: "bad_name",
      });
    }
    expect(await paths(w)).toEqual(["/ok"]);
  });

  test("a folder deleted earlier under the old name stays as it was", async () => {
    const w = await world();
    await make(w, "/", "a");
    await make(w, "/a", "old");
    await deleteFolder(t.db, { projectId: w.project.id, path: "/a/old" });
    await renameFolder(t.db, { projectId: w.project.id, path: "/a", name: "z" });
    const rows = await t.db
      .select()
      .from(variableFolders)
      .where(eq(variableFolders.projectId, w.project.id));
    expect(rows.map((r) => [r.path, r.deletedAt === null]).sort()).toEqual([
      ["/a/old", false],
      ["/z", true],
    ]);
  });
});

describe("deleting a folder", () => {
  test("an empty folder is soft deleted and its path is free again", async () => {
    const w = await world();
    const a = await make(w, "/", "a");
    const done = await deleteFolder(t.db, { projectId: w.project.id, path: "/a" });
    expect(done).toMatchObject({ row: { id: a.id } });
    expect(await paths(w)).toEqual([]);
    const [kept] = await t.db.select().from(variableFolders).where(eq(variableFolders.id, a.id));
    expect(kept?.deletedAt).toBeInstanceOf(Date);
    expect((await make(w, "/", "a")).id).not.toBe(a.id);
  });

  test("a folder with a live sub-folder is not_empty, and is deleted once that is gone", async () => {
    const w = await world();
    await make(w, "/", "a");
    await make(w, "/a", "b");
    await make(w, "/", "ab");
    expect(await deleteFolder(t.db, { projectId: w.project.id, path: "/a" })).toEqual({
      error: "not_empty",
    });
    expect(await paths(w)).toEqual(["/a", "/a/b", "/ab"]);
    await deleteFolder(t.db, { projectId: w.project.id, path: "/a/b" });
    expect(await deleteFolder(t.db, { projectId: w.project.id, path: "/a" })).toMatchObject({
      row: { path: "/a" },
    });
    // a sibling that only starts with the same letters was never in the way
    expect(await paths(w)).toEqual(["/ab"]);
  });

  test("a folder with a live variable in it is not_empty, and is deleted once the variable is", async () => {
    const w = await world();
    await make(w, "/", "a");
    await make(w, "/", "b");
    const held = await variableIn(w, "/a");
    expect(await deleteFolder(t.db, { projectId: w.project.id, path: "/a" })).toEqual({
      error: "not_empty",
    });
    // a variable in a sibling, or at the root, is no reason to keep this one
    expect(await deleteFolder(t.db, { projectId: w.project.id, path: "/b" })).toMatchObject({
      row: { path: "/b" },
    });
    await deleteVariable(t.db, at(w), held.id);
    expect(await deleteFolder(t.db, { projectId: w.project.id, path: "/a" })).toMatchObject({
      row: { path: "/a" },
    });
  });

  test("a folder that is not there, was deleted, or is another project's is not_found", async () => {
    const w = await world();
    const other = await world();
    await make(other, "/", "theirs");
    expect(await deleteFolder(t.db, { projectId: w.project.id, path: "/theirs" })).toEqual({
      error: "not_found",
    });
    expect(await deleteFolder(t.db, { projectId: w.project.id, path: "/nope" })).toEqual({
      error: "not_found",
    });
    await make(w, "/", "x");
    await deleteFolder(t.db, { projectId: w.project.id, path: "/x" });
    expect(await deleteFolder(t.db, { projectId: w.project.id, path: "/x" })).toEqual({
      error: "not_found",
    });
    expect(await paths(other)).toEqual(["/theirs"]);
  });
});

describe("folders changed at the same time", () => {
  /** Runs `inside` in a transaction that stays open until the returned `commit` is called. */
  async function holding(
    inside: (tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0]) => Promise<unknown>,
  ) {
    let commit!: () => void;
    const release = new Promise<void>((r) => {
      commit = r;
    });
    let ready!: () => void;
    const started = new Promise<void>((r) => {
      ready = r;
    });
    const done = t.db.transaction(async (tx) => {
      await inside(tx);
      ready();
      await release;
    });
    await started;
    return { commit, done };
  }
  const settlesWithin = async (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  test("a folder made under one that is being renamed waits, and then finds its parent gone", async () => {
    const w = await world();
    await make(w, "/", "a");
    const renaming = await holding((tx) =>
      renameFolder(tx, { projectId: w.project.id, path: "/a", name: "z" }),
    );
    const creating = createFolder(t.db, { ...at(w), parent: "/a", name: "x" });
    expect(await settlesWithin(creating, 200)).toBe(false);
    renaming.commit();
    await renaming.done;
    expect(await creating).toEqual({ error: "no_parent" });
    expect(await paths(w)).toEqual(["/z"]);
  });

  test("a folder made under one that is being deleted waits, and then finds its parent gone", async () => {
    const w = await world();
    await make(w, "/", "a");
    const deleting = await holding((tx) =>
      deleteFolder(tx, { projectId: w.project.id, path: "/a" }),
    );
    const creating = createFolder(t.db, { ...at(w), parent: "/a", name: "x" });
    expect(await settlesWithin(creating, 200)).toBe(false);
    deleting.commit();
    await deleting.done;
    expect(await creating).toEqual({ error: "no_parent" });
    expect(await paths(w)).toEqual([]);
  });

  test("a rename waits for a folder being made below it, and moves that one too", async () => {
    const w = await world();
    await make(w, "/", "a");
    await make(w, "/a", "b");
    const making = await holding((tx) => createFolder(tx, { ...at(w), parent: "/a/b", name: "c" }));
    const renaming = renameFolder(t.db, { projectId: w.project.id, path: "/a", name: "z" });
    expect(await settlesWithin(renaming, 200)).toBe(false);
    making.commit();
    await making.done;
    expect(await renaming).toMatchObject({ row: { path: "/z" } });
    expect(await paths(w)).toEqual(["/z", "/z/b", "/z/b/c"]);
  });

  test("a delete waits for a folder being made inside it, and is then refused", async () => {
    const w = await world();
    await make(w, "/", "a");
    const making = await holding((tx) => createFolder(tx, { ...at(w), parent: "/a", name: "b" }));
    const deleting = deleteFolder(t.db, { projectId: w.project.id, path: "/a" });
    expect(await settlesWithin(deleting, 200)).toBe(false);
    making.commit();
    await making.done;
    expect(await deleting).toEqual({ error: "not_empty" });
    expect(await paths(w)).toEqual(["/a", "/a/b"]);
  });
});

describe("variables and folders changed at the same time", () => {
  async function holding(
    inside: (tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0]) => Promise<unknown>,
  ) {
    let commit!: () => void;
    const release = new Promise<void>((r) => {
      commit = r;
    });
    let ready!: () => void;
    const started = new Promise<void>((r) => {
      ready = r;
    });
    const done = t.db.transaction(async (tx) => {
      await inside(tx);
      ready();
      await release;
    });
    await started;
    return { commit, done };
  }
  const settlesWithin = async (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  test("a delete waits for a variable being made in the folder, and is then refused", async () => {
    const w = await world();
    await make(w, "/", "a");
    const making = await holding((tx) =>
      createVariable(tx, keys, {
        ...at(w),
        key: "K",
        kind: "plain",
        value: "v",
        folder: "/a",
        actor: { kind: "user", id: "u1" },
      }),
    );
    const deleting = deleteFolder(t.db, { projectId: w.project.id, path: "/a" });
    expect(await settlesWithin(deleting, 200)).toBe(false);
    making.commit();
    await making.done;
    expect(await deleting).toEqual({ error: "not_empty" });
  });

  test("a variable made in a folder being deleted waits, and then finds the folder gone", async () => {
    const w = await world();
    await make(w, "/", "a");
    const deleting = await holding((tx) =>
      deleteFolder(tx, { projectId: w.project.id, path: "/a" }),
    );
    const making = variableIn(w, "/a").then(
      () => "made",
      (e: unknown) => (e as Error).name,
    );
    expect(await settlesWithin(making, 200)).toBe(false);
    deleting.commit();
    await deleting.done;
    expect(await making).toBe("FolderNotFoundError");
  });
});

describe("what the database holds on its own", () => {
  const raw = (w: World, path: string, over: Partial<typeof variableFolders.$inferInsert> = {}) =>
    t.db.insert(variableFolders).values({ ...at(w), path, ...over });

  test("a path that is not names from the root down is refused whoever writes it", async () => {
    const w = await world();
    for (const path of ["", "/", "a", "a/b", "//a", "/a/", "/a//b", "/A", "/a b", "/a/b/c/d/e/f"]) {
      expect([path, await refusedBy(raw(w, path))]).toEqual([path, "variable_folders_path_check"]);
    }
    expect(await refusedBy(raw(w, "/a/b/c/d/e"))).toBeUndefined();
  });

  test("a live path is held once per project, whoever writes it", async () => {
    const w = await world();
    await raw(w, "/a");
    expect(await refusedBy(raw(w, "/a"))).toBe("variable_folders_project_path");
    expect(await refusedBy(raw(w, "/a", { deletedAt: new Date() }))).toBeUndefined();
  });

  test("a project of another organization is refused, and a project's folders go with it", async () => {
    const w = await world();
    const other = await world();
    expect(await refusedBy(raw(w, "/a", { organizationId: other.org.id }))).toBe(
      "variable_folders_project_org_fk",
    );
    await make(w, "/", "a");
    await make(w, "/a", "b");
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(await listFolders(t.db, w.project.id)).toEqual([]);
    const left = await t.db
      .select()
      .from(variableFolders)
      .where(eq(variableFolders.projectId, w.project.id));
    expect(left).toEqual([]);
  });

  test("updated_at is kept current by the trigger", async () => {
    const w = await world();
    const a = await make(w, "/", "a");
    await new Promise((r) => setTimeout(r, 15));
    await renameFolder(t.db, { projectId: w.project.id, path: "/a", name: "b" });
    const [after] = await t.db.select().from(variableFolders).where(eq(variableFolders.id, a.id));
    expect(after && after.updatedAt > a.updatedAt).toBe(true);
  });
});

describe("finding a folder by its path", () => {
  test("a live folder of the project is found; a deleted one, another project's and the root are not", async () => {
    const w = await world();
    const other = await world();
    const a = await make(w, "/", "a");
    await make(w, "/", "gone");
    await deleteFolder(t.db, { projectId: w.project.id, path: "/gone" });
    expect(await getFolderByPath(t.db, w.project.id, "/a")).toEqual(a);
    expect(await getFolderByPath(t.db, w.project.id, "/gone")).toBeUndefined();
    expect(await getFolderByPath(t.db, other.project.id, "/a")).toBeUndefined();
    expect(await getFolderByPath(t.db, w.project.id, "/")).toBeUndefined(); // the root is no folder
  });

  test("a search narrowed to a folder finds that folder's variables of the organization, not another organization's, and none once it is deleted", async () => {
    const [w, other] = [await world(), await world()];
    for (const x of [w, other]) await make(x, "/", "pay");
    await make(w, "/", "gone");
    const key = `S${++n}`;
    const pay = await variableIn(w, "/pay", key);
    await variableIn(other, "/pay", key);
    const gone = await variableIn(w, "/gone", key);
    const root = await variableIn(w, "/", key);
    const find = async (folder?: string) =>
      (
        await searchVariables(t.db, keys, {
          organizationId: w.org.id,
          projects: true,
          key,
          folder,
          limit: 10,
        })
      ).items
        .map((v) => v.id)
        .sort();
    // `other` is another organization: only `w`'s rows are in this search
    expect(await find("/pay")).toEqual([pay.id]);
    expect(await find("/")).toEqual([root.id]);
    expect(await find()).toEqual([pay.id, gone.id, root.id].sort());
    await deleteVariable(t.db, at(w), gone.id);
    await deleteFolder(t.db, { projectId: w.project.id, path: "/gone" });
    expect(await find("/gone")).toEqual([]);
  });
});

describe("finding a folder by its id", () => {
  test("a live folder of the project is found; a deleted one, another project's and a stranger's are not", async () => {
    const w = await world();
    const other = await world();
    const a = await make(w, "/", "a");
    const gone = await make(w, "/", "gone");
    await deleteFolder(t.db, { projectId: w.project.id, path: "/gone" });
    expect(await lockFolderById(t.db, w.project.id, a.id)).toEqual(a);
    expect(await lockFolderById(t.db, w.project.id, gone.id)).toBeUndefined();
    expect(await lockFolderById(t.db, other.project.id, a.id)).toBeUndefined();
    expect(await lockFolderById(t.db, w.project.id, Bun.randomUUIDv7())).toBeUndefined();
  });

  test("it holds the folder, so a rename in another transaction waits for this one", async () => {
    const w = await world();
    const a = await make(w, "/", "a");
    const order: string[] = [];
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const gotIt = new Promise<void>((r) => {
      locked = r;
    });
    const first = t.db.transaction(async (tx) => {
      await lockFolderById(tx, w.project.id, a.id);
      locked();
      await held;
      order.push("first done");
    });
    await gotIt;
    const second = renameFolder(t.db, { projectId: w.project.id, path: "/a", name: "b" }).then(() =>
      order.push("rename done"),
    );
    await new Promise((r) => setTimeout(r, 50));
    try {
      expect(order).toEqual([]);
    } finally {
      release(); // also on a failure, or the held transaction would stall the database's drop
    }
    await Promise.all([first, second]);
    expect(order).toEqual(["first done", "rename done"]);
  });
});
