import { pgTable, text } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";

export const organizations = pgTable("organizations", {
  id: id(),
  slug: text().notNull().unique("organizations_slug_key"),
  name: text().notNull(),
  ...timestamps(),
});
