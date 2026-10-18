import { personRef, type Subject } from "@orch/core";
import type { Person } from "@orch/db";
import { Elysia } from "elysia";

/** The GitLab job a CI token was issued to: what a route may check beyond the token's scopes. */
export interface CiJob {
  /** Null when the exchange's claims carried no job id. */
  gitlabJobId: number | null;
  ref: string;
}

/**
 * Who is calling. `dev` is the local-development stand-in and may do anything; every other kind
 * is held to its `subject` by the route guards. A `ci` principal also names its `job`.
 */
export type Principal =
  | { id: string; kind: "dev" }
  | {
      id: string;
      kind: Subject["kind"];
      subject: Subject;
      job?: CiJob;
      /** The person a session or an API token belongs to (`id` of a token is the token's): who counts as one person for four-eyes rules. */
      userId?: string | undefined;
    };

/** The caller as a change request records them: the audit trail's name, and the person behind it. */
export const personOf = (p: Principal): Person => ({
  kind: p.kind,
  id: p.id,
  ref: personRef({ kind: p.kind, id: p.id, userId: "userId" in p ? p.userId : undefined }),
});

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
