import { createLogger, loadConfig } from "@orch/core";
import { envKeyProvider, type KeyProvider } from "@orch/crypto";
import {
  AUTO_SYNC_QUEUE,
  createDb,
  DRIFT_CHECK_QUEUE,
  DRIFT_TICK_QUEUE,
  describeError,
  upsertSchedule,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { z } from "zod";
import { pipelineEventHandler, workerGitlab } from "./pipeline-runs";
import { runEventHandler } from "./run-ingest";
import { SYNC_APPLY, syncApplyHandler } from "./sync-apply";
import { syncAutoHandler } from "./sync-auto";
import { driftCheckHandler, driftTickHandler } from "./sync-drift";
import { chain, createWorker, type JobHandler } from "./worker";

const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
    WORKER_POLL_MS: z.coerce.number().int().min(10).max(60_000).default(1_000),
    ORCH_MASTER_KEYS: z.string().min(1).optional(),
    /** How often every sync target is checked for drift (SYNC-8); 0 switches the checks off. */
    DRIFT_CHECK_SECONDS: z.coerce
      .number()
      .int()
      .max(86_400)
      .refine((n) => n === 0 || n >= 60, "0 (off) or at least 60")
      .default(900),
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
  handlers[DRIFT_TICK_QUEUE] = driftTickHandler({ db });
  handlers[DRIFT_CHECK_QUEUE] = driftCheckHandler({ db, keys, logger });
  // one queue, two consumers: a pipeline event updates the pipeline's record (PIPE-8) and the run it belongs to (IAC-6)
  const gitlab = { db, gitlab: workerGitlab({ db, keys, logger }) };
  handlers[WEBHOOK_QUEUE] = chain(pipelineEventHandler(gitlab), runEventHandler(gitlab));
  // the schedule lives in the database, so every worker states it; the same timing keeps its place
  // shortcut: workers started with different values take turns setting it; give it one owner when that matters.
  await upsertSchedule(db, {
    name: "sync.drift",
    intervalSeconds: config.DRIFT_CHECK_SECONDS || 900,
    queue: DRIFT_TICK_QUEUE,
    enabled: config.DRIFT_CHECK_SECONDS > 0,
  });
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
