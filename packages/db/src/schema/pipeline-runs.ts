import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { connections } from "./connections";
import { projects } from "./projects";

/**
 * The state of one GitLab pipeline as last read from GitLab (PIPE-8). A webhook only says "this
 * pipeline changed": the row holds what GitLab answered when asked, so a repeated, late or
 * out-of-order event cannot put an old state back. `observed_at` is when that read began; a write
 * only replaces a row whose own `observed_at` is not newer. `failure_reason` and `failed_job` are
 * GitLab's words for the first job that failed and did not allow it (null otherwise).
 */
export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    // The connection that last read it (a retry uses it again); null once that connection is deleted.
    connectionId: uuid().references(() => connections.id, { onDelete: "set null" }),
    // shortcut: number mode loses precision above 2^53; GitLab ids are far below that.
    gitlabPipelineId: bigint({ mode: "number" }).notNull(),
    iid: integer().notNull(),
    status: text().notNull(),
    ref: text().notNull(),
    sha: text().notNull(),
    webUrl: text().notNull(),
    failureReason: text(),
    failedJob: text(),
    observedAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("pipeline_runs_project_pipeline_key").on(t.projectId, t.gitlabPipelineId),
    // the latest run of each ref
    index("pipeline_runs_project_ref_idx").on(t.projectId, t.ref, t.gitlabPipelineId),
    // CASCADE: a project's runs are its history and go with it.
    foreignKey({
      name: "pipeline_runs_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check("pipeline_runs_status_check", sql`${t.status} ~ '^[a-z_]{1,32}$'`),
  ],
);
