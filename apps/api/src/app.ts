import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import { type Db, type OperationalStats, operationalStats } from "@orch/db";
import { gitlabRateLimits } from "@orch/gitlab";
import type { Tool } from "@orch/iac";
import type { Template } from "@orch/pipelines";
import type { GuardrailConfig } from "@orch/sync";
import { Elysia } from "elysia";
import { auditPlugin } from "./audit";
import type { CloudDeps } from "./connections";
import { guardPlugin, unauthenticated, unguardedRoutes } from "./guard";
import { HARDENING_DEFAULTS, type Hardening } from "./hardening";
import { http } from "./http";
import { bearerMatches, newRegistry, renderStats, requestMetrics } from "./metrics";
import { openapiPlugin } from "./openapi";
import type { PrincipalResolver } from "./principal";
import { createRateLimiter } from "./rate-limit";
import { auditLogRoutes } from "./routes/audit-log";
import { type AuthDeps, authRoutes } from "./routes/auth";
import { changeRequestRoutes } from "./routes/change-requests";
import { type CiDeps, ciRoutes } from "./routes/ci";
import { cliRoutes } from "./routes/cli";
import { connectionRoutes } from "./routes/connections";
import { environmentRoutes } from "./routes/environments";
import { importRoutes } from "./routes/imports";
import {
  auditForwardingRoutes,
  notificationSinkRoutes,
  notificationSubscriptionRoutes,
} from "./routes/notifications";
import { organizationRoutes } from "./routes/organizations";
import { pipelineRoutes } from "./routes/pipeline";
import { pipelineFleetRoutes } from "./routes/pipeline-fleet";
import { pipelineRunRoutes } from "./routes/pipeline-runs";
import { policySetRoutes } from "./routes/policy";
import { projectRoutes } from "./routes/projects";
import { runRoutes } from "./routes/runs";
import { syncRunRoutes } from "./routes/sync-runs";
import { syncTargetRoutes } from "./routes/sync-targets";
import { tokenRoutes } from "./routes/tokens";
import { variableRoutes } from "./routes/variables";
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
  /** How the AWS, Kubernetes and Vault connections reach their systems (see `CloudDeps`). Left out, the real network and no AWS identity. */
  cloud?: CloudDeps;
  /** The pipeline templates to offer. Left out, the shipped catalog. */
  templates?: readonly Template[];
  /** Image repository per tool that has no default (Terragrunt), for the pipelines an apply starts. */
  images?: Partial<Record<Tool, string>> | undefined;
  /** `GET /metrics` answers to this bearer token only; left out, it answers 404. `stats` is a test seam for the figures read from the database. */
  metrics?: { token: string; stats?: () => Promise<OperationalStats> } | undefined;
  /** The built-in guardrails (POL-4). Left out, every rule is on and production is `production` and `prod`. */
  guardrails?: GuardrailConfig | undefined;
  /** Origins, body cap, proxy hops and rate-limit scale (see `Hardening`). The headers, the cap and the limits apply with the defaults when left out. */
  hardening?: Partial<Hardening> | undefined;
}

// Registered by the OpenAPI plugin, which cannot carry route options. The document describes the
// API (it is committed in docs/) and holds no data.
const DOCS = ["GET /openapi/json"];

/** A scrape reads the tables once in this long, however many scrapers ask. */
const STATS_TTL_MS = 5_000;

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

  const registry = newRegistry();
  const edge: Hardening = { ...HARDENING_DEFAULTS, ...deps.hardening };
  const limited = registry.counter(
    "orch_rate_limited_total",
    "Requests refused with 429, by the limit they hit.",
    ["limit"],
  );
  const limits = createRateLimiter({
    scale: edge.rateLimitScale,
    proxyHops: edge.proxyHops,
    onLimited: (limit) => limited.inc({ limit }),
    warn: (message) => logger.warn(message),
  });
  let cached: { at: number; stats: Promise<OperationalStats> } | undefined;
  const stats = () => {
    if (!cached || Date.now() - cached.at > STATS_TTL_MS) {
      const read = deps.metrics?.stats ?? (() => operationalStats(deps.db));
      const mine = { at: Date.now(), stats: read() };
      cached = mine;
      // a failed read is not kept
      mine.stats.catch(() => {
        if (cached === mine) cached = undefined;
      });
    }
    return cached.stats;
  };

  const app = new Elysia({ name: "orch.api" })
    .decorate("limits", limits)
    .use(http(logger, requestMetrics(registry), edge))
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
    .get(
      "/metrics",
      async ({ request, set, log }) => {
        const token = deps.metrics?.token;
        if (!token) throw new DomainError("not_found", 404, "Route not found");
        if (!bearerMatches(request.headers.get("authorization"), token)) {
          set.headers["www-authenticate"] = "Bearer";
          throw unauthenticated();
        }
        let figures: OperationalStats;
        try {
          figures = await stats();
        } catch (error) {
          log.error("metrics could not be read", { error });
          throw new DomainError("metrics_unavailable", 503, "Metrics could not be read");
        }
        set.headers["content-type"] = "text/plain; version=0.0.4; charset=utf-8";
        return registry.render() + renderStats(figures, gitlabRateLimits());
      },
      {
        public:
          "scraped by Prometheus with the bearer token ORCH_METRICS_TOKEN; answers 404 without one",
      },
    )
    .use(auditPlugin(principal))
    .use(authRoutes(deps))
    .use(cliRoutes(deps))
    .use(ciRoutes(deps))
    .use(organizationRoutes(deps))
    .use(projectRoutes(deps))
    .use(connectionRoutes(deps))
    .use(importRoutes(deps))
    .use(webhookRoutes(deps))
    .use(environmentRoutes(deps))
    .use(changeRequestRoutes(deps))
    .use(syncTargetRoutes(deps))
    .use(notificationSinkRoutes(deps))
    .use(notificationSubscriptionRoutes(deps))
    .use(auditForwardingRoutes(deps))
    .use(policySetRoutes(deps))
    .use(auditLogRoutes(deps))
    .use(syncRunRoutes(deps))
    .use(pipelineRoutes(deps))
    .use(pipelineFleetRoutes(deps))
    .use(pipelineRunRoutes(deps))
    .use(runRoutes(deps))
    .use(tokenRoutes(deps))
    .use(variableRoutes(deps));
  const open = unguardedRoutes(app, DOCS);
  if (open.length > 0) throw new Error(`routes without a guard: ${open.join(", ")}`);
  return app;
}

export type App = ReturnType<typeof createApp>;
