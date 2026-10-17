import { sql } from "drizzle-orm";
import { timestamp, uuid } from "drizzle-orm/pg-core";

// Drizzle inserts use Bun.randomUUIDv7(); the database default (PG18 uuidv7()) covers raw SQL.
export const id = () =>
  uuid()
    .primaryKey()
    .default(sql`uuidv7()`)
    .$defaultFn(() => Bun.randomUUIDv7());

/**
 * Every table spreads this in. `updated_at` is kept current by a trigger, so each new table
 * also needs `CREATE TRIGGER <table>_updated BEFORE UPDATE ... EXECUTE FUNCTION set_updated_at()`
 * in its migration (a test fails if one is missing).
 */
export const timestamps = () => ({
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
