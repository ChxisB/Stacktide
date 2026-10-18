import {
  latestRunOfMergeRequest,
  type MergeRequestNote,
  type RunStack,
  saveMergeRequestNote,
  type Tx,
  withMergeRequest,
} from "@orch/db";
import { type Gitlab, GitlabError } from "@orch/gitlab";
import type { RunDeps } from "./pipeline-runs";

export interface NoteView {
  /** The newest run of the merge request, if it has had one: its commit and where each stack is. */
  run?: { sha: string; stacks: readonly RunStack[] } | undefined;
  /** A line about the latest commit that no run shows: why nothing was planned. Already escaped. */
  notice: string | null;
  /** The project's address in GitLab, for links to jobs. */
  projectUrl: string | undefined;
}

// Text that came from a repository or a tool is shown in a code span, where GitLab makes no link,
// mention or heading of it; a backtick or a line break could end the span, so they are replaced.
export const inline = (text: string, max = 200) =>
  `\`${text.replace(/[\p{Cc}\p{Cf}`]/gu, " ").slice(0, max)}\``;
// Table cells: no character that markdown reads, and no line break.
const plain = (text: string, max: number) =>
  text.replace(/[\p{Cc}\p{Cf}<>[\]()`*_|@\\]/gu, "").slice(0, max);

const SAFE_URL = /^https?:\/\/[^\s()<>[\]`]+$/;
const dash = "–";

/**
 * The note on a merge request: one table, a row per stack of the newest run, with its state, the
 * counts of its plan and a link to its plan job. Counts only: no address of a resource and no
 * plan (a plan holds secrets); whoever may see the plan opens the job.
 */
export function renderNote({ run, notice, projectUrl }: NoteView): string {
  const base = projectUrl?.replace(/\/+$/, "");
  const out = ["**orch plan**"];
  if (run) {
    out.push(
      "",
      `Commit \`${plain(run.sha, 64)}\``,
      "",
      "| Stack | Status | Add | Change | Destroy | Plan |",
      "| --- | --- | ---: | ---: | ---: | --- |",
    );
    for (const s of run.stacks) {
      const counts =
        s.planAdd === null ? [dash, dash, dash] : [s.planAdd, s.planChange, s.planDestroy];
      const link =
        s.planJobId !== null && base !== undefined && SAFE_URL.test(base)
          ? `[job](${base}/-/jobs/${s.planJobId})`
          : dash;
      const status = `${plain(s.status, 20)}${s.error === null ? "" : ` (${plain(s.error, 100)})`}`;
      out.push(`| \`${plain(s.stack, 63)}\` | ${status} | ${counts.join(" | ")} | ${link} |`);
    }
  }
  if (notice) out.push("", notice);
  out.push(
    "",
    "<sub>Counts only: the plan itself stays in the job. This note is updated, not added to.</sub>",
  );
  return out.join("\n");
}

/** Updates the note, or makes it when there is none or someone deleted it; returns its id. */
export async function upsertNote(
  gitlab: Gitlab,
  project: number,
  iid: number,
  noteId: number | null,
  body: string,
): Promise<number> {
  if (noteId !== null) {
    try {
      await gitlab.mergeRequests.updateNote(project, iid, noteId, body);
      return noteId;
    } catch (error) {
      if (!(error instanceof GitlabError && error.kind === "not_found")) throw error;
    }
  }
  return (await gitlab.mergeRequests.createNote(project, iid, body)).id;
}

/**
 * Writes the merge request's note from the database as it is now. Call it holding the merge
 * request's row (`withMergeRequest`). With `only`, writes nothing unless that run is the newest
 * (an event of a run a newer commit replaced has nothing to add), and nothing when there is
 * neither a run nor a notice to show.
 */
export async function writeNote(
  tx: Tx,
  row: MergeRequestNote,
  gitlab: Gitlab,
  gitlabProjectId: number,
  only?: string,
): Promise<void> {
  const run = await latestRunOfMergeRequest(
    tx,
    row.organizationId,
    row.projectId,
    row.mergeRequestIid,
  );
  if (only !== undefined && run?.id !== only) return;
  if (!run && !row.notice) return;
  const { webUrl } = await gitlab.projects.get(gitlabProjectId);
  const body = renderNote({ run, notice: row.notice, projectUrl: webUrl });
  const noteId = await upsertNote(gitlab, gitlabProjectId, row.mergeRequestIid, row.noteId, body);
  if (noteId !== row.noteId) await saveMergeRequestNote(tx, row, { noteId });
}

/** `writeNote` for a caller that does not hold the row yet. */
export const refreshNote = (
  deps: RunDeps,
  at: { organizationId: string; projectId: string; gitlabProjectId: number },
  iid: number,
  gitlab: Gitlab,
  only?: string,
) =>
  withMergeRequest(deps.db, at.organizationId, at.projectId, iid, (tx, row) =>
    writeNote(tx, row, gitlab, at.gitlabProjectId, only),
  );
