import { boolean, foreignKey, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { projects } from "./projects";

export const environments = pgTable(
  "environments",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    name: text().notNull(),
    slug: text().notNull(),
    sortOrder: integer().notNull().default(0),
    // A protected environment's variables change only through an approved change request (GOV-2).
    protected: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    unique("environments_project_slug_key").on(t.projectId, t.slug),
    // Target of the composite foreign keys that keep child rows in the environment's project.
    unique("environments_id_project_key").on(t.id, t.projectId),
    // Composite: an environment cannot name a different organization than its project.
    foreignKey({
      name: "environments_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
  ],
);
