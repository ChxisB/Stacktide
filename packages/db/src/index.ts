import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as schema from "./schema";

export * from "./audit";
export * from "./auth";
export * from "./auto-sync";
export * from "./ci";
export * from "./connections";
export * from "./imports";
export * from "./jobs";
export * from "./merge-request-notes";
export * from "./pg-error";
export * from "./pipeline-configs";
export * from "./pipeline-runs";
export * from "./repo";
export * from "./runs";
export * from "./schedules";
export * from "./schema";
export * from "./stack-drift";
export * from "./stacks";
export * from "./sync-drift";
export * from "./sync-runs";
export * from "./sync-targets";
export * from "./variables";
export * from "./webhooks";

/** `max` caps the pool; Bun opens several connections per client by default. */
export function createDb(url: string, max = 10) {
  return drizzle({ client: new SQL(url, { max }), schema, casing: "snake_case" });
}

export type Db = ReturnType<typeof createDb>;

/** Resolves when the database answers; rejects otherwise. */
export function pingDb(db: Db) {
  return db.execute(sql`SELECT 1`);
}

/** Forward-only: applies pending SQL files from `packages/db/drizzle`. */
export function migrateDb(db: Db): Promise<void> {
  return migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
}
