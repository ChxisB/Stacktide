import { createLogger, loadConfig } from "@orch/core";
import { createDb, pingDb } from "@orch/db";
import { z } from "zod";
import { createApp } from "./app";
import { authEnv, authFromEnv } from "./auth-config";
import { devPrincipal } from "./principal";

const config = loadConfig(
  z
    .object({
      DATABASE_URL: z.string().min(1),
      // Loopback by default: the dev principal trusts every caller that can reach the port.
      HOST: z.string().min(1).default("127.0.0.1"),
      PORT: z.coerce.number().int().min(0).max(65535).default(3000),
      LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
      NODE_ENV: z.string().default("development"),
    })
    .and(authEnv),
);
const logger = createLogger({ level: config.LOG_LEVEL });

// Fail closed: until AUTH-3 every caller is the dev principal, so only run it where that is safe.
const LOOPBACK = ["127.0.0.1", "localhost", "::1", "[::1]"];
if (!["development", "test"].includes(config.NODE_ENV.toLowerCase())) {
  logger.error("refusing to start outside development: no authentication provider is configured");
  process.exit(1);
}
if (!LOOPBACK.includes(config.HOST)) {
  logger.error("refusing to start: the dev principal may only listen on a loopback address");
  process.exit(1);
}

const db = createDb(config.DATABASE_URL, 5);
const app = createApp({
  logger,
  db,
  principal: devPrincipal,
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
