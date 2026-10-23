import type { DetectedType } from "@orch/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  foreignKey,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { connections } from "./connections";
import { organizations } from "./organizations";

export const projects = pgTable(
  "projects",
  {
    id: id(),
    // RESTRICT: removing an organization never silently takes its projects with it.
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    name: text().notNull(),
    // shortcut: number mode loses precision above 2^53; GitLab ids are far below that.
    gitlabProjectId: bigint({ mode: "number" }),
    // The forge connection this project came from. Null is a project from before connections were
    // recorded: it belongs to the organization's only connection of its type, and to none of two.
    connectionId: uuid(),
    defaultBranch: text().notNull().default("main"),
    // What the repository looks like (GL-7), set by an import; never typed in by hand.
    detectedTypes: jsonb().$type<DetectedType[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [
    unique("projects_org_name_key").on(t.organizationId, t.name),
    // Target of the composite foreign key that keeps child rows in the project's organization.
    unique("projects_id_org_key").on(t.id, t.organizationId),
    // RESTRICT: a connection in use is never silently taken away (a null would hand its projects
    // to another connection). The composite key keeps the connection in the project's organization.
    foreignKey({
      name: "projects_connection_org_fk",
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [connections.id, connections.organizationId],
    }).onDelete("restrict"),
    // One row per forge project: per organization while unbound, per connection once bound, so two
    // connections can each hold "project 42".
    uniqueIndex("projects_org_gitlab_project_key")
      .on(t.organizationId, t.gitlabProjectId)
      .where(sql`${t.gitlabProjectId} IS NOT NULL AND ${t.connectionId} IS NULL`),
    uniqueIndex("projects_connection_gitlab_project_key")
      .on(t.connectionId, t.gitlabProjectId)
      .where(sql`${t.gitlabProjectId} IS NOT NULL AND ${t.connectionId} IS NOT NULL`),
  ],
);
