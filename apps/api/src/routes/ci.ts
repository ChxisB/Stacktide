import { DomainError, type Logger } from "@orch/core";
import { createCiToken, environmentBySlug, MAX_CI_TTL_MS, projectsByGitlabId } from "@orch/db";
import { GitlabError, type Jwk } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import { type IdClaims, IdTokenError, verifyIdToken } from "../id-token";
import { newCiToken } from "../tokens";
import { iso, problemSchema, type RouteDeps, writeErrors } from "./shared";

export interface CiDeps {
  /** The GitLab signing key with this `kid` (see `keyCache`); throws when GitLab cannot be reached. */
  key: (kid: string) => Promise<Jwk | undefined>;
  /** The `iss` of GitLab's job tokens: the instance URL. */
  issuer: string;
  /** The `aud` jobs ask for in their `id_tokens:`; a token meant for another service is refused. */
  audience: string;
  /** How long an exchanged token lasts, at most. Default 15 minutes; never beyond the `id_token` itself. */
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

const exchangeBody = z.strictObject({ id_token: z.string().min(1).max(8192) });
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
 * slug; neither is guessed. An environment GitLab calls protected (or does not say) is only
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

        let raw: IdClaims;
        try {
          raw = await verifyIdToken(body.id_token, { ...ci, now });
        } catch (error) {
          if (error instanceof GitlabError) {
            logger.warn("ci exchange could not fetch gitlab keys", {
              request_id: requestId,
              kind: error.kind,
              error: error.message,
            });
            throw new DomainError(
              "gitlab_unavailable",
              502,
              "GitLab could not be reached. Try again.",
            );
          }
          if (error instanceof IdTokenError) throw refuse(error.reason);
          throw error;
        }
        const parsed = jobClaims.safeParse(raw);
        if (!parsed.success) throw refuse("claims");
        const claims = parsed.data;

        // Never longer than the job's own token: a finished job holds nothing.
        const ttlMs = Math.min(ttl, Math.floor(raw.exp * 1000 - now()));
        if (ttlMs < 1000) throw refuse("expired");

        const gitlabProjectId = Number(claims.project_id);
        const found = await projectsByGitlabId(db, gitlabProjectId);
        const [project, other] = found;
        if (!project) {
          throw new DomainError(
            "project_not_registered",
            403,
            "This GitLab project is not registered",
          );
        }
        if (other) {
          throw new DomainError(
            "project_ambiguous",
            409,
            "This GitLab project is linked more than once",
          );
        }

        const refProtected = claims.ref_protected === "true";
        let environmentId: string | undefined;
        if (claims.environment !== undefined) {
          // Unknown or missing counts as protected: only a protected ref gets in.
          if (claims.environment_protected !== "false" && !refProtected) {
            throw new DomainError(
              "ref_not_protected",
              403,
              "A protected environment can only be reached from a protected ref",
            );
          }
          environmentId = (await environmentBySlug(db, project.id, claims.environment))?.id;
          if (!environmentId) {
            throw new DomainError(
              "environment_not_found",
              403,
              "This environment is not registered",
            );
          }
        }

        const fresh = newCiToken();
        const scopes = environmentId ? ENVIRONMENT_SCOPES : PROJECT_SCOPES;
        const row = await db.transaction(async (tx) => {
          const row = await createCiToken(tx, {
            organizationId: project.organizationId,
            projectId: project.id,
            environmentId,
            tokenHash: fresh.tokenHash,
            scopes,
            gitlabProjectId,
            gitlabJobId: claims.job_id === undefined ? undefined : Number(claims.job_id),
            ref: claims.ref,
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
                gitlabProjectId,
                gitlabJobId: row.gitlabJobId,
                ref: row.ref,
                refProtected,
                environment: claims.environment,
                environmentId,
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
      },
    );
};
