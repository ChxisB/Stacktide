import { DomainError, type Logger } from "@orch/core";
import { Elysia } from "elysia";
import { http } from "./http";
import { type PrincipalResolver, principalPlugin } from "./principal";

export interface AppDeps {
  logger: Logger;
  principal: PrincipalResolver;
  /** Resolves when dependencies (the database) are usable; rejects otherwise. */
  ready: () => Promise<unknown>;
  readyTimeoutMs?: number;
}

/**
 * Public routes first, then the principal: routes chained onto the result (or onto a plugin that
 * `.use(principalPlugin(...))`) get `ctx.principal`; `/health` and `/ready` never need it.
 */
export function createApp({ logger, principal, ready, readyTimeoutMs = 2000 }: AppDeps) {
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
    .use(principalPlugin(principal));
}

export type App = ReturnType<typeof createApp>;
