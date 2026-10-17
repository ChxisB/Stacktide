import { createLogger, loadConfig } from "@orch/core";
import { createDb, describeError } from "@orch/db";
import { z } from "zod";
import { createWorker, type JobHandler } from "./worker";

const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
    WORKER_POLL_MS: z.coerce.number().int().min(10).max(60_000).default(1_000),
  }),
);
const logger = createLogger({ level: config.LOG_LEVEL });

// Later features register their handlers here, keyed by queue.
const handlers: Record<string, JobHandler> = {};

const db = createDb(config.DATABASE_URL, config.WORKER_CONCURRENCY + 2);
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
