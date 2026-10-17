import { sql } from "drizzle-orm";
import { bigint, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    slug: text().notNull().unique("organizations_slug_key"),
    name: text().notNull(),
    // The GitLab group whose members are this organization's members (AUTH-5); fixed at creation.
    // shortcut: number mode loses precision above 2^53; GitLab ids are far below that.
    gitlabGroupId: bigint({ mode: "number" }),
    ...timestamps(),
  },
  (t) => [
    // One organization per group: a GitLab membership must not read as two organizations' roles.
    uniqueIndex("organizations_gitlab_group_key")
      .on(t.gitlabGroupId)
      .where(sql`${t.gitlabGroupId} IS NOT NULL`),
  ],
);
