import { createLogger, loadConfig } from "@orch/core";
import { envKeyProvider, type KeyProvider } from "@orch/crypto";
import { AUTO_SYNC_QUEUE, createDb, describeError } from "@orch/db";
import { z } from "zod";
import { SYNC_APPLY, syncApplyHandler } from "./sync-apply";
import { syncAutoHandler } from "./sync-auto";
import { createWorker, type JobHandler } from "./worker";

const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
    WORKER_POLL_MS: z.coerce.number().int().min(10).max(60_000).default(1_000),
    ORCH_MASTER_KEYS: z.string().min(1).optional(),
  }),
);
const logger = createLogger({ level: config.LOG_LEVEL });

let keys: KeyProvider | undefined;
if (config.ORCH_MASTER_KEYS !== undefined) {
  try {
    keys = envKeyProvider(config.ORCH_MASTER_KEYS);
  } catch (error) {
    logger.error("refusing to start: ORCH_MASTER_KEYS is invalid", { error });
    process.exit(1);
  }
}

const db = createDb(config.DATABASE_URL, config.WORKER_CONCURRENCY + 2);

// Later features register their handlers here, keyed by queue.
const handlers: Record<string, JobHandler> = {};
// A job that opens secrets needs the master keys here too: without them its queue is not served and its jobs wait.
if (keys) {
  handlers[SYNC_APPLY] = syncApplyHandler({ db, keys, logger });
  handlers[AUTO_SYNC_QUEUE] = syncAutoHandler({ db, keys, logger });
} else logger.warn("ORCH_MASTER_KEYS is not set: syncs will not be applied until it is");
const worker = createWorker({
  db,
  logger,
  handlers,
  concurrency: config.WORKER_CONCURRENCY,
  pollMs: config.WORKER_POLL_MS,
});
worker.start();
logger.info("worker started", { queues: Object.keys(handlers) });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info("shutting down", { signal });
  // A stuck handler must not keep the process alive forever.
  setTimeout(() => process.exit(1), 30_000).unref();
  try {
    await worker.stop();
    await db.$client.close();
  } catch (error) {
    logger.error("shutdown failed", { error: describeError(error) });
    process.exit(1);
  }
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => void shutdown(signal));
