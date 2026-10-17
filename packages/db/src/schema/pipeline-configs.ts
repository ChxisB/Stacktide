import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { connections } from "./connections";
import { projects } from "./projects";

/**
 * The pipeline a project was last set up with (PIPE-6): which template and version, the parameters
 * and overrides it was rendered from (never a secret: they are written into the repository), the
 * connection that reached the project, and the merge request that carries it. One row per project,
 * replaced by each apply; `rendered_hash` is the SHA-256 of the file as committed, so a later run
 * can tell whether anything changed. The repository stays the source of truth for what is live.
 */
export const pipelineConfigs = pgTable(
  "pipeline_configs",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    connectionId: uuid().notNull(),
    template: text().notNull(),
    version: text().notNull(),
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    overrides: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    renderedHash: text().notNull(),
    // The merge request that carries the file (null while it is already on the default branch).
    mrIid: integer(),
    mrUrl: text(),
    ...timestamps(),
  },
  (t) => [
    unique("pipeline_configs_project_key").on(t.projectId),
    // CASCADE: a project's pipeline is its configuration and goes with it.
    foreignKey({
      name: "pipeline_configs_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    // RESTRICT: a connection in use is never silently taken away; it also stays in the organization.
    foreignKey({
      name: "pipeline_configs_connection_org_fk",
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [connections.id, connections.organizationId],
    }).onDelete("restrict"),
    check("pipeline_configs_hash_check", sql`${t.renderedHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
