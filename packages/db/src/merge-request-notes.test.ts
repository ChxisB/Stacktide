import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { saveMergeRequestNote, withMergeRequest } from "./merge-request-notes";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import { mergeRequestNotes } from "./schema";
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
  const org = await createOrganization(t.db, { slug: `m${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
  return { org, project };
}

describe("the note of a merge request", () => {
  test("is made on first use, empty, and found again as it was left", async () => {
    const w = await world();
    const first = await withMergeRequest(t.db, w.org.id, w.project.id, 7, async (tx, row) => {
      expect(row).toMatchObject({ mergeRequestIid: 7, noteId: null, notice: null });
      await saveMergeRequestNote(tx, row, { noteId: 99, notice: "something" });
      return row;
    });
    expect(first.projectId).toBe(w.project.id);
    await withMergeRequest(t.db, w.org.id, w.project.id, 7, async (_tx, row) => {
      expect(row).toMatchObject({ noteId: 99, notice: "something" });
    });
    // another merge request has its own
    await withMergeRequest(t.db, w.org.id, w.project.id, 8, async (_tx, row) => {
      expect(row).toMatchObject({ noteId: null, notice: null });
    });
  });

  test("saves only what is given, and null clears the notice", async () => {
    const w = await world();
    const seen = () =>
      withMergeRequest(t.db, w.org.id, w.project.id, 7, async (_tx, r) => [r.noteId, r.notice]);
    await withMergeRequest(t.db, w.org.id, w.project.id, 7, (tx, row) =>
      saveMergeRequestNote(tx, row, { noteId: 5, notice: "a" }),
    );
    await withMergeRequest(t.db, w.org.id, w.project.id, 7, (tx, row) =>
      saveMergeRequestNote(tx, row, { noteId: 6 }),
    );
    expect(await seen()).toEqual([6, "a"]);
    await withMergeRequest(t.db, w.org.id, w.project.id, 7, (tx, row) =>
      saveMergeRequestNote(tx, row, { notice: null }),
    );
    expect(await seen()).toEqual([6, null]);
  });

  test("two at once take turns: the second sees what the first saved, so there is one note", async () => {
    const w = await world();
    const order: string[] = [];
    const turn = (name: string, hold: number) =>
      withMergeRequest(t.db, w.org.id, w.project.id, 7, async (tx, row) => {
        order.push(`${name} in`);
        await Bun.sleep(hold);
        if (row.noteId === null)
          await saveMergeRequestNote(tx, row, { noteId: name === "a" ? 1 : 2 });
        order.push(`${name} out`);
        return row.noteId;
      });
    const [a, b] = await Promise.all([turn("a", 100), turn("b", 0)]);
    // whoever came second saw the first one's note
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
    expect(order[1]?.endsWith("out")).toBe(true);
    const rows = await t.db
      .select()
      .from(mergeRequestNotes)
      .where(eq(mergeRequestNotes.projectId, w.project.id));
    expect(rows).toHaveLength(1);
  });

  test("a failure inside rolls back the save, and the row stays", async () => {
    const w = await world();
    await expect(
      withMergeRequest(t.db, w.org.id, w.project.id, 7, async (tx, row) => {
        await saveMergeRequestNote(tx, row, { noteId: 5 });
        throw new Error("GitLab was down");
      }),
    ).rejects.toThrow("GitLab was down");
    await withMergeRequest(t.db, w.org.id, w.project.id, 7, async (_tx, row) => {
      expect(row.noteId).toBeNull();
    });
  });

  test("belongs to its project only: another organization's id is refused, and it goes with the project", async () => {
    const w = await world();
    const other = await world();
    await expect(
      withMergeRequest(t.db, other.org.id, w.project.id, 7, async () => {}).catch((e) =>
        pgConstraint(e),
      ),
    ).resolves.toBe("merge_request_notes_project_org_fk");
    await withMergeRequest(t.db, w.org.id, w.project.id, 7, async () => {});
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(
      await t.db
        .select()
        .from(mergeRequestNotes)
        .where(and(eq(mergeRequestNotes.projectId, w.project.id))),
    ).toEqual([]);
  });

  test("the database refuses a merge request number or note id that is not one, and a notice too long", async () => {
    const w = await world();
    const at = { organizationId: w.org.id, projectId: w.project.id };
    const refused = (values: Partial<typeof mergeRequestNotes.$inferInsert>) =>
      t.db
        .insert(mergeRequestNotes)
        .values({ ...at, mergeRequestIid: 1, ...values })
        .then(() => undefined)
        .catch((e) => pgConstraint(e));
    expect(await refused({ mergeRequestIid: 0 })).toBe("merge_request_notes_iid_check");
    expect(await refused({ mergeRequestIid: 2, noteId: 0 })).toBe("merge_request_notes_note_check");
    expect(await refused({ mergeRequestIid: 3, notice: "x".repeat(1001) })).toBe(
      "merge_request_notes_notice_check",
    );
    expect(await refused({ mergeRequestIid: 4, notice: "x".repeat(1000) })).toBeUndefined();
  });
});
