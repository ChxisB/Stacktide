import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { projects } from "./projects";

/**
 * The one note the platform keeps on a merge request (IAC-7): which GitLab note it is, and a line
 * about the latest commit that is not in any run (why nothing could be planned). The row is also the
 * lock that serialises the handlers that write the note, so that two events never make two notes.
 * Nothing here is a secret; `notice` is text the platform wrote, escaped, never a tool's output.
 */
export const mergeRequestNotes = pgTable(
  "merge_request_notes",
  {
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    mergeRequestIid: integer().notNull(),
    // null until the note is first created; recreated when someone deleted it in GitLab
    noteId: bigint({ mode: "number" }),
    notice: text(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.mergeRequestIid] }),
    // CASCADE: the note's record goes with its project.
    foreignKey({
      name: "merge_request_notes_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check("merge_request_notes_iid_check", sql`${t.mergeRequestIid} > 0`),
    check("merge_request_notes_note_check", sql`coalesce(${t.noteId}, 1) > 0`),
    check("merge_request_notes_notice_check", sql`length(${t.notice}) <= 1000`),
  ],
);
