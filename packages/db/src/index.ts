import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as schema from "./schema";

export * from "./audit";
export * from "./audit-forwarding";
export * from "./audit-log";
export * from "./auth";
export * from "./auto-sync";
export * from "./change-requests";
export * from "./ci";
export * from "./connections";
export * from "./cost-limits";
export * from "./deployments";
export * from "./dns-zones";
export * from "./folders";
export * from "./imports";
export * from "./jobs";
export * from "./leases";
export * from "./merge-request-notes";
export * from "./metrics";
export * from "./notifications";
export * from "./pg-error";
export * from "./pipeline-configs";
export * from "./pipeline-runs";
export * from "./policy";
export * from "./project-connection";
export * from "./repo";
export * from "./resources";
export * from "./rewrap";
export * from "./rotations";
export * from "./run-plans";
export * from "./runs";
export * from "./schedules";
export * from "./schema";
export * from "./secret-findings";
export * from "./sso";
export * from "./stack-drift";
export * from "./stacks";
export * from "./state";
export * from "./state-locks";
export * from "./sync-drift";
export * from "./sync-runs";
export * from "./sync-targets";
export * from "./variables";
export * from "./webhooks";
export * from "./worker-pools";

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
