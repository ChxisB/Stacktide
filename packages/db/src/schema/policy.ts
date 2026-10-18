import { sql } from "drizzle-orm";
import { check, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { organizations } from "./organizations";

/**
 * A policy set (POL-3): Rego policies in a repository of the same GitLab, attached to the stacks of
 * the organization that carry `tag`. The plan job of such a stack is judged by it, and a plan that is
 * denied is not applied. It is the organization's, so a stack's repository cannot change what the set
 * says (it does choose, by its tags, which stacks the set reaches). Nothing here is a secret (the runner fetches the policies with its own job token).
 */
export const policySets = pgTable(
  "policy_sets",
  {
    id: id(),
    // CASCADE: configuration of the organization, with no secret in it, goes with it.
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    // a GitLab project path, `group/project`
    source: text().notNull(),
    ref: text().notNull(),
    // the directory of the policies in it
    path: text().notNull().default("."),
    tag: text().notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("policy_sets_org_name_key").on(t.organizationId, t.name),
    index("policy_sets_org_idx").on(t.organizationId, t.id),
    check(
      "policy_sets_text_check",
      sql`length(${t.name}) between 1 and 63 and length(${t.source}) between 3 and 2000 and length(${t.ref}) between 1 and 100 and length(${t.path}) between 1 and 200 and length(${t.tag}) between 1 and 32`,
    ),
  ],
);
