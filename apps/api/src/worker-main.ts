import { createLogger, loadConfig } from "@orch/core";
import { envKeyProvider, type KeyProvider } from "@orch/crypto";
import {
  AUDIT_FORWARD_QUEUE,
  AUDIT_PURGE_QUEUE,
  AUTO_SYNC_QUEUE,
  CHANGE_REQUEST_EXPIRE_QUEUE,
  createDb,
  DRIFT_CHECK_QUEUE,
  DRIFT_TICK_QUEUE,
  describeError,
  LEASE_SWEEP_QUEUE,
  NOTIFY_QUEUE,
  ROTATION_TICK_QUEUE,
  STACK_DRIFT_CHECK_QUEUE,
  STACK_DRIFT_TICK_QUEUE,
  upsertSchedule,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { awsEnv, awsFromEnv } from "@orch/sync";
import { z } from "zod";
import { auditForwardHandler } from "./audit-forward";
import { auditPurgeHandler } from "./audit-purge";
import { rolesFromEnv } from "./auth-config";
import { changeRequestExpireHandler } from "./change-request-expire";
import { deploymentEventHandler } from "./deployments";
import { guardrailEnv, guardrailsOf } from "./guardrails";
import { leaseSweepHandler } from "./lease";
import { mrCommandHandler } from "./mr-commands";
import { mrPlanHandler } from "./mr-plan";
import { notifyDeliverHandler } from "./notify";
import { pipelineEventHandler, workerForge, workerGitlab } from "./pipeline-runs";
import { rotationTickHandler } from "./rotation-tick";
import { builtInLeasers, builtInRotators } from "./rotators";
import { mrApplyHandler } from "./run-apply";
import { runEventHandler } from "./run-ingest";
import { stackDriftCheckHandler, stackDriftTickHandler } from "./stack-drift";
import { SYNC_APPLY, syncApplyHandler } from "./sync-apply";
import { syncAutoHandler } from "./sync-auto";
import { driftCheckHandler, driftTickHandler } from "./sync-drift";
import { platformOf, toolImageEnv, toolImages } from "./tool-images";
import { chain, createWorker, type JobHandler } from "./worker";

const config = loadConfig(
  z
    .object({
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
      /** POL-3: the helper's tools and `conftest`, for the summary job of a stack that policy judges. Without it such a stack is not planned. */
      ORCH_POLICY_IMAGE: z.string().min(1).optional(),
      /** COST-4: `infracost` and `jq`, for the estimate job of a stack a cost limit reaches. Without it nothing is estimated and such a stack's apply is denied. */
      ORCH_COST_IMAGE: z.string().min(1).optional(),
      /**
       * `orch plan` / `orch apply` in a merge request note (IAC-9) are run as the person who wrote them, with
       * the roles their GitLab membership gives: the API's two settings for that. Without them nobody holds a
       * role, so no command is answered.
       */
      GITLAB_URL: z.url().optional(),
      GITLAB_MEMBERSHIP_TOKEN: z.string().min(1).optional(),
      /** The image repository (no tag) per tool; Terragrunt has no default, and a stack with an `environment` needs one with `orch`. */
      ...toolImageEnv,
      ...guardrailEnv,
      /** How often every sync target is checked for drift (SYNC-8); 0 switches the checks off. */
      DRIFT_CHECK_SECONDS: z.coerce
        .number()
        .int()
        .max(86_400)
        .refine((n) => n === 0 || n >= 60, "0 (off) or at least 60")
        .default(900),
      /** How often every project with stacks is looked at for a stack due its drift check (POL-1); 0 switches them off. */
      STACK_DRIFT_CHECK_SECONDS: z.coerce
        .number()
        .int()
        .max(86_400)
        .refine((n) => n === 0 || n >= 60, "0 (off) or at least 60")
        .default(3600),
      /** How often the audit events past their organization's retention are deleted (GOV-1); 0 switches the purge off. */
      AUDIT_PURGE_SECONDS: z.coerce
        .number()
        .int()
        .max(86_400)
        .refine((n) => n === 0 || n >= 60, "0 (off) or at least 60")
        .default(3600),
      /** How often change requests nobody decided in time are closed (GOV-2); 0 switches it off. */
      CHANGE_REQUEST_EXPIRE_SECONDS: z.coerce
        .number()
        .int()
        .max(86_400)
        .refine((n) => n === 0 || n >= 60, "0 (off) or at least 60")
        .default(300),
      /** How often the audit log is handed to the sinks that were told to take it (GOV-4); 0 switches forwarding off. */
      AUDIT_FORWARD_SECONDS: z.coerce
        .number()
        .int()
        .max(3600)
        .refine((n) => n === 0 || n >= 10, "0 (off) or at least 10")
        .default(30),
      /** How often secrets due for rotation are rotated and replaced credentials past their grace are revoked (ROT-4); 0 switches rotation off. */
      ROTATION_CHECK_SECONDS: z.coerce
        .number()
        .int()
        .max(86_400)
        .refine((n) => n === 0 || n >= 60, "0 (off) or at least 60")
        .default(300),
    })
    .and(awsEnv),
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

const guardrails = guardrailsOf(config);
// the platform's own AWS identity, for the targets whose connection is a role to assume
const cloud = { aws: () => awsFromEnv(config) };

// Later features register their handlers here, keyed by queue.
const handlers: Record<string, JobHandler> = {};
// The purge reads no secret, so it needs no keys. Which events it may delete is each organization's setting. Off means off: no schedule and no handler for a job that is already waiting.
if (config.AUDIT_PURGE_SECONDS > 0) handlers[AUDIT_PURGE_QUEUE] = auditPurgeHandler({ db });
await upsertSchedule(db, {
  name: "audit.purge",
  intervalSeconds: config.AUDIT_PURGE_SECONDS || 3600,
  queue: AUDIT_PURGE_QUEUE,
  enabled: config.AUDIT_PURGE_SECONDS > 0,
});
// Closing a lapsed change request opens nothing either. A request past its time cannot be approved whether or not this has run.
if (config.CHANGE_REQUEST_EXPIRE_SECONDS > 0) {
  handlers[CHANGE_REQUEST_EXPIRE_QUEUE] = changeRequestExpireHandler({ db });
}
await upsertSchedule(db, {
  name: "change_request.expire",
  intervalSeconds: config.CHANGE_REQUEST_EXPIRE_SECONDS || 300,
  queue: CHANGE_REQUEST_EXPIRE_QUEUE,
  enabled: config.CHANGE_REQUEST_EXPIRE_SECONDS > 0,
});
// A job that opens secrets needs the master keys here too: without them its queue is not served and its jobs wait.
if (keys) {
  handlers[SYNC_APPLY] = syncApplyHandler({ db, keys, logger, cloud });
  handlers[AUTO_SYNC_QUEUE] = syncAutoHandler({ db, keys, logger, guardrails, cloud });
  handlers[DRIFT_TICK_QUEUE] = driftTickHandler({ db });
  handlers[DRIFT_CHECK_QUEUE] = driftCheckHandler({ db, keys, logger, guardrails, cloud });
  // POL-2: the sink's address is sealed, so delivering needs the keys
  handlers[NOTIFY_QUEUE] = notifyDeliverHandler({ db, keys });
  // GOV-4: so is the collector's; off means off, with no handler for a job that is already waiting
  if (config.AUDIT_FORWARD_SECONDS > 0) {
    handlers[AUDIT_FORWARD_QUEUE] = auditForwardHandler({ db, keys });
  }
  await upsertSchedule(db, {
    name: "audit.forward",
    intervalSeconds: config.AUDIT_FORWARD_SECONDS || 30,
    queue: AUDIT_FORWARD_QUEUE,
    enabled: config.AUDIT_FORWARD_SECONDS > 0,
  });
  // ROT-4: rotating opens and writes secrets, so it needs the keys; off means off, with no handler for a job that is already waiting
  if (config.ROTATION_CHECK_SECONDS > 0) {
    handlers[ROTATION_TICK_QUEUE] = rotationTickHandler({
      db,
      keys,
      logger,
      rotators: builtInRotators({ db, keys, logger }),
    });
  }
  await upsertSchedule(db, {
    name: "rotation.tick",
    intervalSeconds: config.ROTATION_CHECK_SECONDS || 300,
    queue: ROTATION_TICK_QUEUE,
    enabled: config.ROTATION_CHECK_SECONDS > 0,
  });
  // ROT-10: a lease is a live token, so ending it on time does not depend on whether rotation is on
  handlers[LEASE_SWEEP_QUEUE] = leaseSweepHandler({
    db,
    leasers: builtInLeasers({ db, keys, logger }),
    logger,
  });
  await upsertSchedule(db, {
    name: "lease.sweep",
    intervalSeconds: 60,
    queue: LEASE_SWEEP_QUEUE,
    enabled: true,
  });
  // one queue, six consumers: a pipeline event updates the pipeline's record (PIPE-8) and the run it
  // belongs to (IAC-6); a deployment event updates the deployment's record (DEP-4); a merge request
  // event plans the merge request (IAC-7), and its merge applies the stacks that opted in (IAC-8,
  // which needs no setting of its own: no plan, no run to apply); a note may be a command (IAC-9,
  // which needs the roles source)
  const gitlab = { db, gitlab: workerGitlab({ db, keys, logger }) };
  // a GitHub connection's run events (FRG-22) are read through the connection's own forge
  const runs = { ...gitlab, forge: workerForge({ db, keys, logger }) };
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
    pipelineEventHandler(runs),
    deploymentEventHandler(gitlab),
    runEventHandler(runs),
    mrApplyHandler({ ...gitlab, images, platform: platformOf(apiUrl, audience) }),
  ];
  // a trailing slash is the usual way to write an address; the generator wants none
  const mr =
    apiUrl !== undefined && audience !== undefined && helperImage !== undefined
      ? {
          apiUrl: apiUrl.replace(/\/+$/, ""),
          audience,
          helperImage,
          policyImage: config.ORCH_POLICY_IMAGE,
          costImage: config.ORCH_COST_IMAGE,
          images,
        }
      : undefined;
  if (mr) {
    consumers.push(mrPlanHandler({ ...runs, config: mr }));
    logger.info("merge request plans are on");
    handlers[STACK_DRIFT_TICK_QUEUE] = stackDriftTickHandler({ db });
    handlers[STACK_DRIFT_CHECK_QUEUE] = stackDriftCheckHandler({ ...gitlab, config: mr });
  } else logger.warn("merge requests will not be planned until these are set", { missing });
  // a GitHub commenter's role is read from GitHub, so GitHub pull request commands need no roles source
  const roles = rolesFromEnv(config, db, logger);
  consumers.push(mrCommandHandler({ ...runs, roles, images, config: mr }));
  if (roles) logger.info("merge request commands are on");
  else {
    logger.warn(
      "GitLab merge request commands will not be answered until GITLAB_URL and GITLAB_MEMBERSHIP_TOKEN are set",
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
  // a drift check plans stacks like a merge request does, so it needs the same settings
  await upsertSchedule(db, {
    name: "stack.drift",
    intervalSeconds: config.STACK_DRIFT_CHECK_SECONDS || 3600,
    queue: STACK_DRIFT_TICK_QUEUE,
    enabled: config.STACK_DRIFT_CHECK_SECONDS > 0 && mr !== undefined,
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
