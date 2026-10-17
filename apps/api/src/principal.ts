import { Elysia } from "elysia";

/** Who is calling. AUTH-1/AUTH-3 own the final shape; handlers only rely on `id` and `kind`. */
export interface Principal {
  id: string;
  kind: "dev";
}

/** Resolves the caller or throws a `DomainError` (401). */
export type PrincipalResolver = (request: Request) => Promise<Principal> | Principal;

/**
 * Dev-only stand-in: everyone is the same principal. AUTH-3 replaces it, and `index.ts` refuses
 * to start with it in production.
 */
export const devPrincipal: PrincipalResolver = () => ({ id: "dev", kind: "dev" });

/**
 * Adds `principal` to the context of routes registered after it. Route modules `.use()` this too
 * (Elysia applies a named plugin once) so they get the type.
 */
export const principalPlugin = (resolve: PrincipalResolver) =>
  new Elysia({ name: "orch.principal" }).derive({ as: "scoped" }, async ({ request }) => ({
    principal: await resolve(request),
  }));
