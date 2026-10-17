import { createLogger, loadConfig } from "@orch/core";
import { z } from "zod";
import { createDb, migrateDb } from "./index";

const { DATABASE_URL } = loadConfig(z.object({ DATABASE_URL: z.string().min(1) }));
// shortcut: no advisory lock, so two concurrent runs against one database can race; deploys must
// run this as a single step until OPS adds a lock.
const db = createDb(DATABASE_URL, 1);
try {
  await migrateDb(db);
  createLogger().info("migrations applied");
} finally {
  await db.$client.close();
}
