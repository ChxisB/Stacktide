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
import { rolesFromEnv } from "./auth-config";
import { mrCommandHandler } from "./mr-commands";
import { mrPlanHandler } from "./mr-plan";
import { pipelineEventHandler, workerGitlab } from "./pipeline-runs";
import { mrApplyHandler } from "./run-apply";
import { runEventHandler } from "./run-ingest";
import { SYNC_APPLY, syncApplyHandler } from "./sync-apply";
import { syncAutoHandler } from "./sync-auto";
import { driftCheckHandler, driftTickHandler } from "./sync-drift";
import { toolImageEnv, toolImages } from "./tool-images";
import { chain, createWorker, type JobHandler } from "./worker";

const config = loadConfig(
  z.object({
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
    WORKER_POLL_MS: z.coerce.number().int().min(10).max(60_000).default(1_000),
    ORCH_MASTER_KEYS: z.string().min(1).optional(),
    /**
     * Merge request plans (IAC-7) need these three: where CI jobs reach the API, the `aud` of the token
     * they ask for (the API's own setting) and an image with `orch`, `curl` and `jq`. The pipeline
     * generator checks their form; what it refuses is shown on the merge request.
     */
    ORCH_API_URL: z.string().min(1).optional(),
    ORCH_CI_AUDIENCE: z.string().min(1).optional(),
    ORCH_HELPER_IMAGE: z.string().min(1).optional(),
    /**
     * `orch plan` / `orch apply` in a merge request note (IAC-9) are run as the person who wrote them, with
     * the roles their GitLab membership gives: the API's two settings for that. Without them nobody holds a
     * role, so no command is answered.
     */
    GITLAB_URL: z.url().optional(),
    GITLAB_MEMBERSHIP_TOKEN: z.string().min(1).optional(),
    /** The image repository (no tag) per tool; Terragrunt has no default, and a stack with an `environment` needs one with `orch`. */
    ...toolImageEnv,
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
  // one queue, five consumers: a pipeline event updates the pipeline's record (PIPE-8) and the run it
  // belongs to (IAC-6); a merge request event plans the merge request (IAC-7), and its merge applies
  // the stacks that opted in (IAC-8, which needs no setting of its own: no plan, no run to apply); a
  // note may be a command (IAC-9, which needs the roles source)
  const gitlab = { db, gitlab: workerGitlab({ db, keys, logger }) };
  const plans = [
    ["ORCH_API_URL", config.ORCH_API_URL],
    ["ORCH_CI_AUDIENCE", config.ORCH_CI_AUDIENCE],
    ["ORCH_HELPER_IMAGE", config.ORCH_HELPER_IMAGE],
  ] as const;
  const missing = plans.filter(([, value]) => value === undefined).map(([name]) => name);
  const {
    ORCH_API_URL: apiUrl,
    ORCH_CI_AUDIENCE: audience,
    ORCH_HELPER_IMAGE: helperImage,
  } = config;
  const images = toolImages(config);
  const consumers = [
    pipelineEventHandler(gitlab),
    runEventHandler(gitlab),
    mrApplyHandler({ ...gitlab, images }),
  ];
  // a trailing slash is the usual way to write an address; the generator wants none
  const mr =
    apiUrl !== undefined && audience !== undefined && helperImage !== undefined
      ? { apiUrl: apiUrl.replace(/\/+$/, ""), audience, helperImage, images }
      : undefined;
  if (mr) {
    consumers.push(mrPlanHandler({ ...gitlab, config: mr }));
    logger.info("merge request plans are on");
  } else logger.warn("merge requests will not be planned until these are set", { missing });
  const roles = rolesFromEnv(config, db, logger);
  if (roles) {
    consumers.push(mrCommandHandler({ ...gitlab, roles, images, config: mr }));
    logger.info("merge request commands are on");
  } else {
    logger.warn(
      "merge request commands will not be answered until GITLAB_URL and GITLAB_MEMBERSHIP_TOKEN are set",
    );
  }
  handlers[WEBHOOK_QUEUE] = chain(...consumers);
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
