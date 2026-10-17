import { createLogger, loadConfig } from "@orch/core";
import { createDb, pingDb } from "@orch/db";
import { z } from "zod";
import { createApp } from "./app";
import { accessEnv, authEnv, authFromEnv } from "./auth-config";
import { devPrincipal } from "./principal";
import { sessionPrincipal } from "./session";

const config = loadConfig(
  z
    .object({
      DATABASE_URL: z.string().min(1),
      // Loopback by default: with ORCH_DEV_AUTH every caller that can reach the port is trusted.
      HOST: z.string().min(1).default("127.0.0.1"),
      PORT: z.coerce.number().int().min(0).max(65535).default(3000),
      LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
      NODE_ENV: z.string().default("development"),
    })
    .and(authEnv)
    .and(accessEnv),
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

const db = createDb(config.DATABASE_URL, 5);
const app = createApp({
  logger,
  db,
  principal: devAuth
    ? devPrincipal
    : sessionPrincipal({ db, platformAdmins: config.ORCH_PLATFORM_ADMIN_GITLAB_IDS }),
  ready: () => pingDb(db),
  auth: authFromEnv(config),
}).listen({
  hostname: config.HOST,
  port: config.PORT,
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
