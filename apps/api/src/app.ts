import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import type { Db } from "@orch/db";
import { Elysia } from "elysia";
import { auditPlugin } from "./audit";
import { guardPlugin, unguardedRoutes } from "./guard";
import { http } from "./http";
import { openapiPlugin } from "./openapi";
import type { PrincipalResolver } from "./principal";
import { type AuthDeps, authRoutes } from "./routes/auth";
import { type CiDeps, ciRoutes } from "./routes/ci";
import { connectionRoutes } from "./routes/connections";
import { environmentRoutes } from "./routes/environments";
import { importRoutes } from "./routes/imports";
import { organizationRoutes } from "./routes/organizations";
import { projectRoutes } from "./routes/projects";
import { tokenRoutes } from "./routes/tokens";
import { webhookRoutes } from "./routes/webhooks";

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
  /** CI jobs exchange their GitLab `id_token` for a token (see `CiDeps`). Left out, the exchange answers 503. */
  ci?: CiDeps;
  /** Master keys for secrets at rest. Left out, connections answer 503 where they would seal or open a secret. */
  keys?: KeyProvider;
  /** Let connections point at this machine (tests, development). Production refuses them. */
  loopbackConnections?: boolean;
}

// Registered by the OpenAPI plugin, which cannot carry route options. The document describes the
// API (it is committed in docs/) and holds no data.
const DOCS = ["GET /openapi/json"];

/**
 * Public routes first, then the principal and audit: routes chained onto the result (or onto a
 * plugin that `.use(auditPlugin(...))`) get `ctx.principal` and `ctx.audit`; `/health` and
 * `/ready` never need them. A route that declares no guard (see `guard.ts`) stops the app from
 * being built.
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

  const app = new Elysia({ name: "orch.api" })
    .use(http(logger))
    .use(openapiPlugin())
    .use(guardPlugin)
    .get("/health", () => ({ status: "ok" as const }), { public: "polled by load balancers" })
    .get(
      "/ready",
      async ({ log }) => {
        try {
          await check();
          return { status: "ready" as const };
        } catch (error) {
          log.error("not ready", { error });
          throw new DomainError("not_ready", 503, "Dependencies are not ready");
        }
      },
      { public: "polled by load balancers" },
    )
    .use(auditPlugin(principal))
    .use(authRoutes(deps))
    .use(ciRoutes(deps))
    .use(organizationRoutes(deps))
    .use(projectRoutes(deps))
    .use(connectionRoutes(deps))
    .use(importRoutes(deps))
    .use(webhookRoutes(deps))
    .use(environmentRoutes(deps))
    .use(tokenRoutes(deps));
  const open = unguardedRoutes(app, DOCS);
  if (open.length > 0) throw new Error(`routes without a guard: ${open.join(", ")}`);
  return app;
}

export type App = ReturnType<typeof createApp>;
