import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { organizations } from "./organizations";

/**
 * What an organization allows one plan to add to its monthly cost (COST-2). The row with no `tag` is
 * the organization's own limit and reaches every stack; a row with a `tag` overrides it for the stacks
 * that carry the tag. A plan whose estimated delta is above `max_monthly_delta` is denied, one that
 * reaches `warn_at` is warned about. Both are in `currency`, which is never converted. It is the
 * organization's: a stack's repository cannot change what the limit says. Nothing here is a secret.
 */
export const costLimits = pgTable(
  "cost_limits",
  {
    id: id(),
    // CASCADE: configuration of the organization, with no secret in it, goes with it.
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tag: text(),
    maxMonthlyDelta: doublePrecision().notNull(),
    warnAt: doublePrecision(),
    currency: text().notNull(),
    ...timestamps(),
  },
  (t) => [
    // one limit per scope, and the organization's own (no tag) is a scope too
    uniqueIndex("cost_limits_org_scope_key").on(t.organizationId, sql`coalesce(${t.tag}, '')`),
    index("cost_limits_org_idx").on(t.organizationId, t.id),
    // NaN and infinity compare above any limit in Postgres, so the bounds refuse them too.
    check(
      "cost_limits_check",
      sql`(${t.tag} is null or ${t.tag} ~ '^[a-z0-9][a-z0-9._-]{0,31}$')
        and ${t.maxMonthlyDelta} between 0 and 1e12
        and (${t.warnAt} is null or ${t.warnAt} between 0 and ${t.maxMonthlyDelta})
        and ${t.currency} ~ '^[A-Z]{3}$'`,
    ),
  ],
);
