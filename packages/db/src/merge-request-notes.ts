import { and, eq } from "drizzle-orm";
import type { Executor } from "./repo";
import { mergeRequestNotes } from "./schema";

export type MergeRequestNote = typeof mergeRequestNotes.$inferSelect;

const of = (row: Pick<MergeRequestNote, "organizationId" | "projectId" | "mergeRequestIid">) =>
  and(
    eq(mergeRequestNotes.projectId, row.projectId),
    eq(mergeRequestNotes.organizationId, row.organizationId),
    eq(mergeRequestNotes.mergeRequestIid, row.mergeRequestIid),
  );

/**
 * Runs `fn` in a transaction that holds the merge request's note row (made on first use) locked, so
 * that handlers of the same merge request take turns: the second sees what the first saved, and two
 * events never make two notes. A throw rolls the saves back. An organization that is not the
 * project's is refused by the foreign key.
 *
 * shortcut: the lock is held while `fn` talks to GitLab, so a slow GitLab holds up that merge
 * request's other events (and a pooled connection); upgrade by writing the note after the lock is
 * released once merge requests see enough traffic for that to matter.
 */
export async function withMergeRequest<T>(
  db: Executor,
  organizationId: string,
  projectId: string,
  mergeRequestIid: number,
  fn: (
    tx: Parameters<Parameters<Executor["transaction"]>[0]>[0],
    row: MergeRequestNote,
  ) => Promise<T>,
): Promise<T> {
  const key = { organizationId, projectId, mergeRequestIid };
  return db.transaction(async (tx) => {
    await tx.insert(mergeRequestNotes).values(key).onConflictDoNothing();
    const [row] = await tx.select().from(mergeRequestNotes).where(of(key)).for("update");
    if (!row) throw new Error("the merge request's note row is missing");
    return fn(tx, row);
  });
}

/** Saves the GitLab note's id and/or the notice (null clears it); only what is given is changed. */
export async function saveMergeRequestNote(
  db: Executor,
  row: Pick<MergeRequestNote, "organizationId" | "projectId" | "mergeRequestIid">,
  set: { noteId?: number | undefined; notice?: string | null | undefined },
): Promise<void> {
  const values = {
    ...(set.noteId === undefined ? {} : { noteId: set.noteId }),
    ...(set.notice === undefined ? {} : { notice: set.notice }),
  };
  if (Object.keys(values).length === 0) return;
  await db.update(mergeRequestNotes).set(values).where(of(row));
}
