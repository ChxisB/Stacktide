import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as schema from "./schema";

export * from "./pg-error";
export * from "./repo";
export * from "./schema";

/** `max` caps the pool; Bun opens several connections per client by default. */
export function createDb(url: string, max = 10) {
  return drizzle({ client: new SQL(url, { max }), schema, casing: "snake_case" });
}

export type Db = ReturnType<typeof createDb>;

/** Forward-only: applies pending SQL files from `packages/db/drizzle`. */
export function migrateDb(db: Db): Promise<void> {
  return migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
}
