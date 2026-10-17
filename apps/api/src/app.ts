import { DomainError, type Logger } from "@orch/core";
import type { Db } from "@orch/db";
import { Elysia } from "elysia";
import { auditPlugin } from "./audit";
import { http } from "./http";
import { openapiPlugin } from "./openapi";
import type { PrincipalResolver } from "./principal";
import { type AuthDeps, authRoutes } from "./routes/auth";
import { environmentRoutes } from "./routes/environments";
import { organizationRoutes } from "./routes/organizations";
import { projectRoutes } from "./routes/projects";

export type { Problem } from "./routes/shared";

export interface AppDeps {
  logger: Logger;
  db: Db;
  principal: PrincipalResolver;
  /** Resolves when dependencies (the database) are usable; rejects otherwise. */
  ready: () => Promise<unknown>;
  readyTimeoutMs?: number;
  /** GitLab sign-in and sessions (see `AuthDeps`). */
  auth?: AuthDeps;
}

/**
 * Public routes first, then the principal and audit: routes chained onto the result (or onto a
 * plugin that `.use(auditPlugin(...))`) get `ctx.principal` and `ctx.audit`; `/health` and
 * `/ready` never need them.
 */
export function createApp(deps: AppDeps) {
  const { logger, principal, ready, readyTimeoutMs = 2000 } = deps;
  // Unauthenticated and polled: concurrent calls share one check so a slow database is not
  // handed a pile of queries. The timer is always cleared; an abandoned query is not cancelled.
  let inFlight: Promise<void> | undefined;
  const check = () => {
    inFlight ??= (async () => {
      let timer: Timer | undefined;
      try {
        await Promise.race([
          ready(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("readiness check timed out")),
              readyTimeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  return new Elysia({ name: "orch.api" })
    .use(http(logger))
    .use(openapiPlugin())
    .get("/health", () => ({ status: "ok" as const }))
    .get("/ready", async ({ log }) => {
      try {
        await check();
        return { status: "ready" as const };
      } catch (error) {
        log.error("not ready", { error });
        throw new DomainError("not_ready", 503, "Dependencies are not ready");
      }
    })
    .use(auditPlugin(principal))
    .use(authRoutes(deps))
    .use(organizationRoutes(deps))
    .use(projectRoutes(deps))
    .use(environmentRoutes(deps));
}

export type App = ReturnType<typeof createApp>;
