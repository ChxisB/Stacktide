import { personRef, type Subject } from "@orch/core";
import type { Person } from "@orch/db";
import { Elysia } from "elysia";

/** The GitLab job a CI token was issued to: what a route may check beyond the token's scopes. */
export interface CiJob {
  /** Null when the exchange's claims carried no job id. */
  gitlabJobId: number | null;
  /** The GitHub Actions run a job without a job id belongs to; null for a GitLab job. */
  gitlabPipelineId: number | null;
  ref: string;
  /** The ref is protected: a branch anyone can push to is not, and its jobs may not change what outlives them. */
  refProtected: boolean;
  /** When the CI token ends: nothing it makes may outlive it. */
  expiresAt: Date;
}

/**
 * What a CI job is called where the platform counts jobs (the cap on leases, the owner of a state lock): its GitLab
 * job id, or, for a GitHub Actions job, which sends none, its run. shortcut: the jobs of one GitHub run share a
 * name, so they share a lease allowance and a lock; upgrade by recording the job from the `check_run_id` claim if
 * GitHub sends it.
 */
export const jobKey = (job: CiJob | undefined) =>
  job?.gitlabJobId
    ? `job-${job.gitlabJobId}`
    : job?.gitlabPipelineId
      ? `run-${job.gitlabPipelineId}`
      : undefined;

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
