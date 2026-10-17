import { foreignKey, integer, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
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
    ...timestamps(),
  },
  (t) => [
    unique("environments_project_slug_key").on(t.projectId, t.slug),
    // Composite: an environment cannot name a different organization than its project.
    foreignKey({
      name: "environments_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
  ],
);
