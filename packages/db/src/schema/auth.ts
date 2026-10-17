import { bigint, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";

/** A person who signed in with GitLab. Roles and org membership come with AUTH-2/3, not here. */
export const users = pgTable("users", {
  id: id(),
  gitlabId: bigint({ mode: "number" }).notNull().unique("users_gitlab_id_key"),
  username: text().notNull(),
  name: text().notNull(),
  lastLoginAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  ...timestamps(),
});

/**
 * A browser session. The cookie holds a random token; only its SHA-256 is stored, so a database
 * read does not yield a usable cookie. Absolute expiry, no sliding window.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique("sessions_token_hash_key"),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

/**
 * A personal API token. The token is `orch_<id>.<secret>`; only its SHA-256 is stored, and `prefix`
 * (`orch_<id>`) is what lists show so a token can be recognised without being revealed. It acts as
 * its owner, narrowed to `scopes`. Always expires; revoking keeps the row.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    prefix: text().notNull(),
    tokenHash: text().notNull().unique("api_tokens_token_hash_key"),
    scopes: text().array().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lastUsedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [index("api_tokens_user_idx").on(t.userId)],
);
