import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
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
 * One GitLab deployment as last read from GitLab (DEP-3, ADR-0020). Like a pipeline run, the row holds what
 * GitLab answered when asked, never what a hook said: `observed_at` is when that read began, and a write only
 * replaces a row whose own `observed_at` is not newer. There is no user and no commit text here, on purpose:
 * the id, the environment's name, the sha, the ref, the status and the times are all it keeps.
 */
export const deployments = pgTable(
  "deployments",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    // The connection that last read it (a refresh uses it again); null once that connection is deleted.
    connectionId: uuid().references(() => connections.id, { onDelete: "set null" }),
    // shortcut: number mode loses precision above 2^53; GitLab ids are far below that.
    gitlabDeploymentId: bigint({ mode: "number" }).notNull(),
    // GitLab's environment name, which is the platform's environment slug (ADR-0020)
    environment: text().notNull(),
    sha: text().notNull(),
    ref: text().notNull(),
    status: text().notNull(),
    // null for a deployment made through the API, which has no job
    jobId: bigint({ mode: "number" }),
    pipelineId: bigint({ mode: "number" }),
    finishedAt: timestamp({ withTimezone: true }),
    observedAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("deployments_project_deployment_key").on(t.projectId, t.gitlabDeploymentId),
    // the newest of an environment
    index("deployments_project_env_idx").on(t.projectId, t.environment, t.gitlabDeploymentId),
    // CASCADE: a project's deployments are its history and go with it.
    foreignKey({
      name: "deployments_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check("deployments_status_check", sql`${t.status} ~ '^[a-z_]{1,32}$'`),
  ],
);
