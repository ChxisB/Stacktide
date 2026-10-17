import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { projects } from "./projects";

/**
 * The IaC stacks of a project (IAC-1): one per directory holding a `stack.yml` on the default
 * branch. The repository is the source of truth; a scan replaces these rows so the platform can
 * answer without reading the repository, and a stack that left the repository leaves the table.
 * Nothing here is a secret: names, paths and the manifest's own fields. `name` is what other
 * stacks and a command address, so it is unique in the project; the scanner gives each directory
 * at most one stack, so a path is only checked for its characters, not for being unique.
 */
export const stacks = pgTable(
  "stacks",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    name: text().notNull(),
    // The stack's directory, relative to the repository root (`.` for the root).
    path: text().notNull(),
    tool: text().$type<"terraform" | "tofu" | "terragrunt">().notNull(),
    version: text(),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    dependsOn: text().array().notNull().default(sql`'{}'::text[]`),
    watch: text().array().notNull().default(sql`'{}'::text[]`),
    applyOn: text().$type<"merge" | "command">().notNull().default("command"),
    // Where the stack's `.tf` files keep state: `http` is what the platform wires up.
    backend: text().$type<"http" | "other" | "none" | "unchecked">().notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("stacks_project_name_key").on(t.projectId, t.name),
    // CASCADE: a project's stacks are read from its repository and go with it.
    foreignKey({
      name: "stacks_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    // the directory goes into shell commands and job names of generated pipelines: the scanner's
    // character set, without a `.` or `..` segment, so a writer other than the scanner cannot widen it
    check(
      "stacks_path_check",
      sql`${t.path} = '.' or (${t.path} ~ '^[A-Za-z0-9._@+=][A-Za-z0-9._@+=-]*(/[A-Za-z0-9._@+=][A-Za-z0-9._@+=-]*)*$' and ${t.path} !~ '(^|/)[.][.]?(/|$)')`,
    ),
    check("stacks_name_check", sql`${t.name} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`),
    check("stacks_tool_check", sql`${t.tool} in ('terraform', 'tofu', 'terragrunt')`),
    check("stacks_apply_on_check", sql`${t.applyOn} in ('merge', 'command')`),
    check("stacks_backend_check", sql`${t.backend} in ('http', 'other', 'none', 'unchecked')`),
  ],
);
