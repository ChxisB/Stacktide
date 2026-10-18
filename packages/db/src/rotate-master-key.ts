import { createLogger, loadConfig } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import { z } from "zod";
import { createDb, KEY_TABLES, keyUsage, rewrapAll, stillOnOldKeys } from "./index";

// bun packages/db/src/rotate-master-key.ts [--status]
// Put the new master key FIRST in ORCH_MASTER_KEYS (the old ones after it) on every api and worker, then run this;
// when it exits 0 nothing is wrapped by an old key and that key can be dropped (docs/runbook-keys-and-backup.md).
const log = createLogger();
const args = process.argv.slice(2);
if (args.some((a) => a !== "--status")) {
  log.error("usage: rotate-master-key [--status]");
  process.exit(2);
}
const { DATABASE_URL, ORCH_MASTER_KEYS } = loadConfig(
  z.object({ DATABASE_URL: z.string().min(1), ORCH_MASTER_KEYS: z.string().min(1) }),
);
let keys: ReturnType<typeof envKeyProvider>;
try {
  keys = envKeyProvider(ORCH_MASTER_KEYS);
} catch (error) {
  log.error("ORCH_MASTER_KEYS is invalid", { error });
  process.exit(2);
}

const db = createDb(DATABASE_URL, 1);
try {
  const report = args.includes("--status") ? undefined : await rewrapAll(db, keys);
  const usage = await keyUsage(db);
  const remaining = stillOnOldKeys(usage, keys.currentKeyId);
  log.info(report ? "master key rotation finished" : "master key status", {
    current: keys.currentKeyId,
    // lists, not objects named after the tables: the logger hides every field whose name has "key" in it
    ...(report
      ? { rewrapped: KEY_TABLES.map((table) => ({ table, count: report.rewrapped[table] })) }
      : {}),
    usage: KEY_TABLES.flatMap((table) =>
      Object.entries(usage[table]).map(([wrappedBy, count]) => ({ table, wrappedBy, count })),
    ),
    remaining,
  });
  if (report?.failed.length)
    log.error("some data keys could not be moved", { failed: report.failed });
  // a key that failed to move is still on its old key, so it counts. Not process.exit: `finally` must close the pool
  if (remaining > 0) process.exitCode = 1;
} catch (error) {
  // not the error itself: a failed query's message carries its parameters, here wrapped data keys
  const cause = (error as { cause?: { code?: unknown } }).cause;
  log.error("master key rotation stopped; what moved stays moved, run it again", {
    reason: error instanceof Error ? error.name : "unknown",
    ...(typeof cause?.code === "string" ? { code: cause.code } : {}),
  });
  process.exitCode = 1;
} finally {
  await db.$client.close();
}
