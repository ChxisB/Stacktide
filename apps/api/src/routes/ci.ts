import { DomainError, type Logger } from "@orch/core";
import {
  createCiToken,
  environmentBySlug,
  MAX_CI_TTL_MS,
  projectsOfGithubRepository,
  projectsOfIssuer,
} from "@orch/db";
import { GITHUB_OIDC_ISSUER } from "@orch/github";
import { GitlabError, type Jwk } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import { type IdClaims, IdTokenError, peekIssuer, verifyIdToken } from "../id-token";
import { rateLimitPlugin } from "../rate-limit";
import { newCiToken } from "../tokens";
import { iso, problemSchema, type RouteDeps, writeErrors } from "./shared";

export interface CiDeps {
  /** The GitLab signing key with this `kid` (see `keyCache`); throws when GitLab cannot be reached. */
  key: (kid: string) => Promise<Jwk | undefined>;
  /** The `iss` of GitLab's job tokens: the instance URL. This deployment's own GitLab (`GITLAB_URL`). */
  issuer: string;
  /**
   * The signing keys of another GitLab, when a connection is registered at exactly this `iss` (FRG-5);
   * undefined when none is, and the token is refused without any call to that address.
   */
  forIssuer?: (issuer: string) => Promise<CiDeps["key"] | undefined>;
  /**
   * The signing keys of GitHub Actions' identity tokens (FRG-23), when this deployment takes them; undefined
   * and a token of that issuer is refused without any call. Every repository on github.com signs with these
   * and may ask for our audience, so what makes a token ours is the repository it names (`projectsOfGithubRepository`).
   */
  github?: CiDeps["key"];
  /** The `aud` jobs ask for in their `id_tokens:`; a token meant for another service is refused. */
  audience: string;
  /** How long an exchanged token lasts, at most. Default 15 minutes; never beyond the `id_token` itself. A token asked for state (`state: true`) lasts up to an hour instead. */
  ttlMs?: number;
  /** Test seam: milliseconds since the epoch. */
  now?: () => number;
}

export const DEFAULT_CI_TTL_MS = 15 * 60_000;

/** A job in an environment reads it and its project, and reveals the environment's values; nothing more. */
export const ENVIRONMENT_SCOPES: readonly string[] = [
  "project.read",
  "environment.read",
  "secret.reveal",
];

/** A job in no environment reads its project, and posts the plan summary of an IaC run's stack (see `runRoutes`); nothing more. */
const PROJECT_SCOPES: readonly string[] = ["project.read", "run.summary"];

/**
 * What a job on a protected ref and in no environment may also do: take a read-only lease on its own
 * project's repository and end it (ROT-11). A job in an environment is tied to it, and a lease belongs
 * to the project, so it has none; neither does a job on a branch anyone can push to.
 */
const LEASE_SCOPES: readonly string[] = ["lease.issue", "lease.revoke"];

/**
 * What a token asked for state holds (STATE-3, ADR-0017): reading the project's Terraform state, and, for a job on
 * a protected ref with a job id, writing, deleting and locking it (`state.write`). A job on a branch anyone can push
 * to reads state and never writes it. It is a token of its own, tied to no environment: an environment's token
 * cannot reach the state routes, and this one holds nothing of the environment's.
 */
const STATE_SCOPES: readonly string[] = ["project.read", "state.read"];

// GitLab writes every claim as text, booleans and ids included.
const numeric = z.string().regex(/^[1-9]\d{0,14}$/);
const flag = z.enum(["true", "false"]);
const jobClaims = z.object({
  project_id: numeric,
  job_id: numeric.optional(),
  ref: z.string().min(1).max(255),
  ref_protected: flag,
  environment: z.string().min(1).max(255).optional(),
  environment_protected: flag.optional(),
});

// GitHub writes its claims as text too. It has no job id (its run stands for one, FRG-33) and no word on whether an
// environment is protected, and a `ref_protected` that may be missing: every one of those fails closed below.
const githubClaims = z.object({
  repository_id: numeric,
  ref: z.string().min(1).max(255),
  ref_protected: flag.optional(),
  event_name: z.string().max(64).optional(),
  run_id: numeric.optional(),
  environment: z.string().min(1).max(255).optional(),
});

/**
 * What starts a run whose branch can be trusted to be the repository's own: a push, a dispatch someone with write
 * access made, a schedule or a release. A pull request (a fork's included), `pull_request_target` and `workflow_run`
 * run in a fork's context or on its code, whatever branch the token names; `ref_protected` says nothing there.
 */
const TRUSTED_EVENTS: ReadonlySet<string> = new Set([
  "push",
  "workflow_dispatch",
  "schedule",
  "release",
]);

/** What the exchange needs of a job's claims, whichever forge made them. */
interface Job {
  project: number;
  jobId?: number;
  /** The run a GitHub Actions job belongs to: all the identity a job of GitHub has. */
  pipelineId?: number;
  ref: string;
  refProtected: boolean;
  environment?: string;
  /** What the forge says of the environment: unknown (undefined) counts as protected. */
  environmentProtected?: boolean;
}

function gitlabJob(raw: IdClaims): Job | undefined {
  const parsed = jobClaims.safeParse(raw);
  if (!parsed.success) return undefined;
  const c = parsed.data;
  return {
    project: Number(c.project_id),
    jobId: c.job_id === undefined ? undefined : Number(c.job_id),
    ref: c.ref,
    refProtected: c.ref_protected === "true",
    environment: c.environment,
    environmentProtected:
      c.environment_protected === undefined ? undefined : c.environment_protected === "true",
  };
}

// shortcut: whether the environment has protection rules is not read from GitHub (the connection's token could); an
// environment job needs a protected ref, so it is refused wherever GitHub does not send `ref_protected`. Upgrade by
// asking GitHub for the environment's rules when it is found that the claim is not sent.
const BRANCH = "refs/heads/";
function githubJob(raw: IdClaims): Job | undefined {
  const parsed = githubClaims.safeParse(raw);
  if (!parsed.success) return undefined;
  const c = parsed.data;
  return {
    project: Number(c.repository_id),
    pipelineId: c.run_id === undefined ? undefined : Number(c.run_id),
    // the branch's name, as a run keeps it; a tag or a pull request's merge ref stays whole and so is no branch of a run
    ref: c.ref.startsWith(BRANCH) ? c.ref.slice(BRANCH.length) : c.ref,
    refProtected: c.ref_protected === "true" && TRUSTED_EVENTS.has(c.event_name ?? ""),
    environment: c.environment,
  };
}

const exchangeBody = z.strictObject({
  id_token: z.string().min(1).max(8192),
  /** A token for the project's Terraform state: it lasts as long as the job (up to an hour) and holds nothing else. */
  state: z.boolean().optional(),
});
const exchanged = z.object({
  token: z.string(),
  type: z.literal("Bearer"),
  expiresAt: z.iso.datetime(),
  scopes: z.array(z.string()),
  /** What the token is for, so a client can name it without the list endpoints it may not call. */
  organizationId: z.uuid(),
  projectId: z.uuid(),
  environmentId: z.uuid().optional(),
});

/**
 * `POST /auth/ci/exchange`: a CI job swaps its GitLab `id_token` for a short-lived token that
 * reads its own project, posts the plan summary of an IaC run if it runs in no environment (the
 * route checks that it is the job recorded for that stack), and reads and reveals the variables
 * of its own environment if it runs in one (`orch run` needs them). The project is the one
 * linked to the token's `project_id`, the environment the one with the token's `environment` as
 * slug; neither is guessed. A token is checked against the GitLab that issued it: this deployment's, or
 * another one a connection is registered for (`forIssuer`), and reaches only that instance's projects. An environment GitLab calls protected (or does not say) is only
 * reached from a protected ref. The token holds nothing else and cannot mint more tokens. Both
 * `scopes` and the role in `ciSubject` hold it to those actions, on that environment alone.
 */
export const ciRoutes = ({
  db,
  principal,
  logger,
  ci,
}: RouteDeps & { logger: Logger; ci?: CiDeps }) => {
  const ttl = ci?.ttlMs ?? DEFAULT_CI_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < 1000 || ttl > MAX_CI_TTL_MS) {
    throw new TypeError("ci token ttl must be between one second and one hour");
  }
  return new Elysia({ prefix: "/auth/ci" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .use(rateLimitPlugin)
    .post(
      "/exchange",
      async ({ body, audit, set }) => {
        if (!ci)
          throw new DomainError("ci_unavailable", 503, "CI token exchange is not configured");
        const now = ci.now ?? Date.now;
        const requestId = set.headers["x-request-id"]; // set by the `http` plugin
        const refuse = (reason: string) => {
          logger.warn("ci exchange refused", { request_id: requestId, reason });
          return new DomainError("invalid_id_token", 401, "The id_token is not valid");
        };

        // Whose keys check this token: GitHub Actions', the deployment's GitLab, or the one a connection is registered
        // for. The unverified `iss` only picks among those; `verifyIdToken` then needs the signed one to be the same.
        const iss = peekIssuer(body.id_token);
        const github = iss === GITHUB_OIDC_ISSUER;
        const own = iss === undefined || iss === ci.issuer; // a token with no readable `iss` fails `verifyIdToken` as ever
        const key = github ? ci.github : own ? ci.key : await ci.forIssuer?.(iss);
        if (!key) throw refuse("issuer");
        const issuer = github ? GITHUB_OIDC_ISSUER : own ? ci.issuer : iss;

        let raw: IdClaims;
        try {
          raw = await verifyIdToken(body.id_token, { key, issuer, audience: ci.audience, now });
        } catch (error) {
          if (error instanceof GitlabError) {
            logger.warn(`ci exchange could not fetch ${github ? "github" : "gitlab"} keys`, {
              request_id: requestId,
              kind: error.kind,
              error: error.message,
            });
            throw github
              ? new DomainError(
                  "github_unavailable",
                  502,
                  "GitHub could not be reached. Try again.",
                )
              : new DomainError(
                  "gitlab_unavailable",
                  502,
                  "GitLab could not be reached. Try again.",
                );
          }
          if (error instanceof IdTokenError) throw refuse(error.reason);
          throw error;
        }
        const job = github ? githubJob(raw) : gitlabJob(raw);
        if (!job) throw refuse("claims");

        // Never longer than the job's own token: a finished job holds nothing. A job that applies writes its state at
        // the end, so a state token may last up to the longest a token can.
        const state = body.state === true;
        const ttlMs = Math.min(state ? MAX_CI_TTL_MS : ttl, Math.floor(raw.exp * 1000 - now()));
        if (ttlMs < 1000) throw refuse("expired");

        const gitlabProjectId = job.project; // a GitHub repository's id is kept where a GitLab project's is
        // Project 42 of one GitLab is not project 42 of another: only a project that issuer owns (FRG-5). A GitHub
        // repository is found through a github.com connection, never by a bare number (FRG-23).
        const found = github
          ? await projectsOfGithubRepository(db, gitlabProjectId)
          : await projectsOfIssuer(db, gitlabProjectId, issuer, ci.issuer);
        const [project, other] = found;
        const noun = github ? "repository" : "project";
        const where = github ? "GitHub" : "GitLab";
        if (!project) {
          throw new DomainError(
            "project_not_registered",
            403,
            `This ${where} ${noun} is not registered`,
          );
        }
        if (other) {
          throw new DomainError(
            "project_ambiguous",
            409,
            `This ${where} ${noun} is linked more than once`,
          );
        }

        const { refProtected } = job;
        let environmentId: string | undefined;
        if (job.environment !== undefined && !state) {
          // Unknown or missing counts as protected: only a protected ref gets in.
          if (job.environmentProtected !== false && !refProtected) {
            throw new DomainError(
              "ref_not_protected",
              403,
              "A protected environment can only be reached from a protected ref",
            );
          }
          environmentId = (await environmentBySlug(db, project.id, job.environment))?.id;
          if (!environmentId) {
            throw new DomainError(
              "environment_not_found",
              403,
              "This environment is not registered",
            );
          }
        }

        const fresh = newCiToken();
        // the cap on leases, and the lock of a state, count a CI job by its job id (a GitHub run's id): with none there is no one to count against
        const byJob = refProtected && (job.jobId !== undefined || job.pipelineId !== undefined);
        const scopes = state
          ? [...STATE_SCOPES, ...(byJob ? ["state.write"] : [])]
          : environmentId
            ? ENVIRONMENT_SCOPES
            : byJob
              ? [...PROJECT_SCOPES, ...LEASE_SCOPES]
              : PROJECT_SCOPES;
        const row = await db.transaction(async (tx) => {
          const row = await createCiToken(tx, {
            organizationId: project.organizationId,
            projectId: project.id,
            environmentId,
            tokenHash: fresh.tokenHash,
            scopes,
            gitlabProjectId,
            gitlabJobId: job.jobId,
            gitlabPipelineId: job.pipelineId,
            ref: job.ref,
            refProtected,
            ttlMs,
          });
          await audit(
            tx,
            {
              action: "auth.ci_exchange",
              resourceType: "ci_token",
              resourceId: row.id,
              organizationId: row.organizationId,
              projectId: row.projectId,
              metadata: {
                ...(github && { forge: "github" }),
                gitlabProjectId,
                gitlabJobId: row.gitlabJobId,
                gitlabPipelineId: row.gitlabPipelineId,
                ref: row.ref,
                refProtected,
                environment: job.environment,
                environmentId,
                state,
                scopes,
                expiresAt: iso(row.expiresAt),
              },
            },
            { kind: "ci", id: row.id },
          );
          return row;
        });
        set.status = 201;
        set.headers["cache-control"] = "no-store";
        // The only time the token is shown: only its hash is kept.
        return {
          token: fresh.token,
          type: "Bearer" as const,
          expiresAt: iso(row.expiresAt),
          scopes,
          organizationId: row.organizationId,
          projectId: row.projectId,
          environmentId,
        };
      },
      {
        body: exchangeBody,
        parse: "json",
        response: {
          201: exchanged,
          ...writeErrors,
          502: problemSchema,
          503: problemSchema,
        },
        audit: "auth.ci_exchange",
        public: "a CI job proves itself with its GitLab id_token; there is no session or token yet",
        limit: "ci_exchange",
      },
    );
};
