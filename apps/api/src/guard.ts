import { can, DomainError, isAction } from "@orch/core";
import { Elysia } from "elysia";
import type { Principal } from "./principal";

export const unauthenticated = () => new DomainError("unauthenticated", 401, "Sign in first");

/**
 * Every route says who may call it, in its options:
 *
 *   .get("/organizations/:orgId", handler, { guard: "organization.read" })
 *   .get("/organizations", handler, { signedIn: "lists only what the caller holds a role in" })
 *   .get("/health", handler, { public: "polled by the load balancer" })
 *
 * `guard` names the action `can()` must allow for the caller on the resource in the path
 * (`:orgId`, `:projectId`); `signedIn` only needs a caller, and the handler narrows its answer.
 * The check runs before the body is validated: an unauthorised caller learns nothing about it.
 * Answers: no caller 401; a caller who cannot read the resource's parent 404 (it must not learn
 * whether the resource exists); any other refusal 403. Both markers show up in the OpenAPI
 * document as `x-guard` / `x-signed-in` / `x-public`, and `unguardedRoutes()` finds routes with none.
 */
export const guardPlugin = new Elysia({ name: "orch.guard" })
  .macro({
    guard: (action: string) => {
      if (!isAction(action)) throw new TypeError(`unknown guard action "${action}"`);
      return {
        detail: { "x-guard": action } as object,
        // Not `beforeHandle`: that runs after validation. `principal` is derived before this.
        transform: (ctx: object) => enforce(ctx as Ctx, action),
      };
    },
    signedIn: (reason: string) => {
      if (!reason.trim()) throw new TypeError("signedIn needs a reason");
      return {
        detail: { "x-signed-in": reason } as object,
        transform: (ctx: object) => {
          if (!(ctx as Ctx).principal) throw unauthenticated();
        },
      };
    },
    public: (reason: string) => {
      if (!reason.trim()) throw new TypeError("public needs a reason");
      return { detail: { "x-public": reason } as object };
    },
  })
  .as("scoped");

interface Ctx {
  principal?: Principal;
  params?: Record<string, string | undefined>;
}

function enforce({ principal, params }: Ctx, action: string) {
  if (!principal) throw unauthenticated();
  if (principal.kind === "dev") return;
  const resource = {
    organizationId: params?.orgId,
    projectId: params?.projectId,
    environmentId: params?.envId,
  };
  if (can(principal.subject, action, resource)) return;
  const parent = resource.projectId ? "project.read" : "organization.read";
  if (resource.organizationId && !can(principal.subject, parent, resource)) {
    const what = resource.projectId ? "Project" : "Organization";
    throw new DomainError("not_found", 404, `${what} not found`);
  }
  throw new DomainError("forbidden", 403, `Not allowed: ${action}`);
}

const MARKERS = ["x-guard", "x-signed-in", "x-public"];

/**
 * Routes (any method) that declare none of `guard`, `signedIn` or `public`, as `METHOD /path`.
 * `except` names routes registered by a library that cannot carry the options.
 */
export function unguardedRoutes(
  app: { routes: ReadonlyArray<{ method: string; path: string; hooks?: unknown }> },
  except: readonly string[] = [],
) {
  return app.routes
    .filter((r) => {
      const detail = (r.hooks as { detail?: Record<string, unknown> } | undefined)?.detail;
      return !MARKERS.some((m) => detail?.[m] !== undefined);
    })
    .map((r) => `${r.method} ${r.path}`)
    .filter((route) => !except.includes(route));
}
