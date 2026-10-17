import type { Subject } from "@orch/core";
import { Elysia } from "elysia";

/**
 * Who is calling. `dev` is the local-development stand-in and may do anything; every other kind
 * is held to its `subject` by the route guards.
 */
export type Principal =
  | { id: string; kind: "dev" }
  | { id: string; kind: Subject["kind"]; subject: Subject };

/**
 * Resolves the caller: nothing for an anonymous request (a guard turns that into 401), a
 * `DomainError` for a credential that is present but unusable.
 */
export type PrincipalResolver = (
  request: Request,
) => Promise<Principal | undefined> | Principal | undefined;

/** Everyone is the same all-powerful principal: tests and `ORCH_DEV_AUTH` only (see `index.ts`). */
export const devPrincipal: PrincipalResolver = () => ({ id: "dev", kind: "dev" });

/**
 * Adds `principal` to the context of routes registered after it. Route modules `.use()` this too
 * (Elysia applies a named plugin once) so they get the type.
 */
export const principalPlugin = (resolve: PrincipalResolver) =>
  new Elysia({ name: "orch.principal" }).derive({ as: "scoped" }, async ({ request }) => ({
    principal: await resolve(request),
  }));
