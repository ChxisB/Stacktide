import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { organizations } from "./organizations";

/**
 * A named set of the organization's own GitLab runners (POOL-1): the tags, and optionally the image, that a
 * stack's generated jobs ask for. Tags route a job, they do not isolate it: anyone who can register a runner
 * with a tag receives its jobs. At most one pool is the organization's default, for stacks that name none, and a
 * disabled pool is never the default (a stack must never fall back to shared runners because its pool is off).
 * Nothing here is a secret.
 */
export const workerPools = pgTable(
  "worker_pools",
  {
    id: id(),
    // CASCADE: configuration of the organization, with no secret in it, goes with it.
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    tags: text().array().notNull(),
    image: text(),
    enabled: boolean().notNull().default(true),
    isDefault: boolean().notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("worker_pools_org_name_key").on(t.organizationId, t.name),
    // a partial unique index: one row per organization may be true
    uniqueIndex("worker_pools_one_default_key").on(t.organizationId).where(sql`${t.isDefault}`),
    index("worker_pools_org_idx").on(t.organizationId, t.id),
    // the shapes of `POOL_NAME`, `POOL_TAG` and `POOL_IMAGE` in core; the list is checked joined, and splitting it again must give the same
    // tags back (a tag holding a comma would pass as two, and a null would vanish)
    check(
      "worker_pools_check",
      sql`${t.name} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${t.name}) <= 63
        and cardinality(${t.tags}) <= 10
        and string_to_array(array_to_string(${t.tags}, ','), ',') = ${t.tags}
        and array_to_string(${t.tags}, ',') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(,[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$'
        and (${t.image} is null or ${t.image} ~ '^[A-Za-z0-9][A-Za-z0-9._/:-]{0,254}(@sha256:[0-9a-f]{64})?$')`,
    ),
    check("worker_pools_default_enabled_check", sql`not ${t.isDefault} or ${t.enabled}`),
  ],
);
