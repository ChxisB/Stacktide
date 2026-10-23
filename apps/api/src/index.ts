import { createLogger, loadConfig } from "@orch/core";
import { envKeyProvider, type KeyProvider } from "@orch/crypto";
import { createDb, pingDb } from "@orch/db";
import { awsEnv, awsFromEnv } from "@orch/sync";
import { z } from "zod";
import { createApp } from "./app";
import { accessEnv, authEnv, authFromEnv, ciFromEnv, rolesFromEnv } from "./auth-config";
import { callerPrincipal } from "./credentials";
import { githubRoles } from "./github-roles";
import { guardrailEnv, guardrailsOf } from "./guardrails";
import { hardeningEnv, hardeningOf } from "./hardening";
import { metricsEnv } from "./metrics";
import { devPrincipal } from "./principal";
import { platformOf, toolImageEnv, toolImages } from "./tool-images";

const config = loadConfig(
  z
    .object({
      DATABASE_URL: z.string().min(1),
      // Loopback by default: with ORCH_DEV_AUTH every caller that can reach the port is trusted.
      HOST: z.string().min(1).default("127.0.0.1"),
      PORT: z.coerce.number().int().min(0).max(65535).default(3000),
      LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
      NODE_ENV: z.string().default("development"),
      // Master keys for secrets at rest ("k2:<base64>,k1:<base64>", see packages/crypto).
      ORCH_MASTER_KEYS: z.string().min(1).optional(),
      // Image repository per tool, for the pipeline an apply starts (as the worker's).
      ...toolImageEnv,
      // Where CI jobs reach this API (as the worker's): the apply of a stack whose state is on the platform signs in to it.
      ORCH_API_URL: z.string().min(1).optional(),
      ...guardrailEnv,
      ...metricsEnv,
      ...hardeningEnv,
    })
    .and(authEnv)
    .and(accessEnv)
    .and(awsEnv),
);
const logger = createLogger({ level: config.LOG_LEVEL });

// Fail closed: callers are the users behind a session, unless ORCH_DEV_AUTH turns authentication
// off, and that is only safe in development on this machine.
const devAuth = config.ORCH_DEV_AUTH !== undefined;
const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];
if (devAuth && !["development", "test"].includes(config.NODE_ENV.toLowerCase())) {
  logger.error("refusing to start outside development: ORCH_DEV_AUTH turns authentication off");
  process.exit(1);
}
if (devAuth && !LOOPBACK.includes(config.HOST)) {
  logger.error("refusing to start: ORCH_DEV_AUTH may only listen on a loopback address");
  process.exit(1);
}
if (devAuth) logger.warn("authentication is off: every caller is the dev principal");

// A key list that does not parse stops the start: secrets sealed under a guess are lost.
let keys: KeyProvider | undefined;
if (config.ORCH_MASTER_KEYS === undefined) {
  logger.warn("ORCH_MASTER_KEYS is not set: connections cannot store or use secrets");
} else {
  try {
    keys = envKeyProvider(config.ORCH_MASTER_KEYS);
  } catch (error) {
    logger.error("refusing to start: ORCH_MASTER_KEYS is invalid", { error });
    process.exit(1);
  }
}

const db = createDb(config.DATABASE_URL, 5);
if (!devAuth && !config.GITLAB_MEMBERSHIP_TOKEN) {
  logger.warn(
    "GITLAB_MEMBERSHIP_TOKEN is not set: nobody holds a role in any organization or project",
  );
}
const auth = authFromEnv(config);
// Sign in with GitHub needs the OAuth app and a way to read the connections' tokens (roles come from a repository's
// permission, read with them).
const hubRoles = auth.github && keys && !devAuth ? githubRoles({ db, keys, logger }) : undefined;
if (auth.github && !hubRoles && !devAuth) {
  logger.warn("GitHub sign-in is off: it needs ORCH_MASTER_KEYS to read the connections' tokens");
}
auth.githubRoles = hubRoles;
const app = createApp({
  logger,
  db,
  principal: devAuth
    ? devPrincipal
    : callerPrincipal({
        db,
        platformAdmins: config.ORCH_PLATFORM_ADMIN_GITLAB_IDS,
        roles: rolesFromEnv(config, db, logger),
        githubRoles: hubRoles,
      }),
  ready: () => pingDb(db),
  auth,
  ci: ciFromEnv(config, db),
  keys,
  images: toolImages(config),
  platform: platformOf(config.ORCH_API_URL, config.ORCH_CI_AUDIENCE),
  guardrails: guardrailsOf(config),
  metrics: config.ORCH_METRICS_TOKEN ? { token: config.ORCH_METRICS_TOKEN } : undefined,
  hardening: hardeningOf(config, auth?.secureCookies === true),
  cloud: { aws: () => awsFromEnv(config) },
  loopbackConnections: ["development", "test"].includes(config.NODE_ENV.toLowerCase()),
}).listen({
  hostname: config.HOST,
  port: config.PORT,
  // the backstop for bodies that do not declare their length (the app refuses declared ones with a problem)
  maxRequestBodySize: config.ORCH_MAX_BODY_BYTES,
});
logger.info("listening", { host: config.HOST, port: app.server?.port });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info("shutting down", { signal });
  // A stuck connection must not keep the process alive forever.
  setTimeout(() => process.exit(1), 10_000).unref();
  try {
    await app.stop(); // lets in-flight requests finish
    await db.$client.close();
  } catch (error) {
    logger.error("shutdown failed", { error });
    process.exit(1);
  }
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => void shutdown(signal));
