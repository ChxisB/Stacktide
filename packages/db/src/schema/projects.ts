import type { DetectedType } from "@orch/core";
import { sql } from "drizzle-orm";
import { bigint, jsonb, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
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
    defaultBranch: text().notNull().default("main"),
    // What the repository looks like (GL-7), set by an import; never typed in by hand.
    detectedTypes: jsonb().$type<DetectedType[]>().notNull().default([]),
    ...timestamps(),
  },
  (t) => [
    unique("projects_org_name_key").on(t.organizationId, t.name),
    // Target of the composite foreign key that keeps child rows in the project's organization.
    unique("projects_id_org_key").on(t.id, t.organizationId),
    uniqueIndex("projects_org_gitlab_project_key")
      .on(t.organizationId, t.gitlabProjectId)
      .where(sql`${t.gitlabProjectId} IS NOT NULL`),
  ],
);
