import { DomainError, LEASE_SCOPES, LEASE_TTL_SECONDS, type Logger } from "@orch/core";
import { getLease, getProject, type Lease, listConnections, listLeases } from "@orch/db";
import { type Leaser, RotationError } from "@orch/rotation";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import { issueLease, type Recorder, revokeLease } from "../lease";
import { jobKey, type Principal, personOf } from "../principal";
import { rateLimitPlugin } from "../rate-limit";
import {
  iso,
  notFound,
  paged,
  pageOf,
  pageQuery,
  problemSchema,
  type RouteDeps,
  readErrors,
  writeErrors,
} from "./shared";

const leaseSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  /** Who holds it: `user:<id>` or `ci:<project id>:job-<GitLab job id>`. */
  principal: z.string(),
  provider: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.iso.datetime(),
  /** Set once it has ended, by a revoke or by the sweep at its expiry. */
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
const dto = (l: Lease): z.infer<typeof leaseSchema> => ({
  id: l.id,
  organizationId: l.organizationId,
  projectId: l.projectId,
  principal: l.principal,
  provider: l.provider,
  scopes: l.scopes.split(","),
  expiresAt: iso(l.expiresAt),
  revokedAt: l.revokedAt && iso(l.revokedAt),
  createdAt: iso(l.createdAt),
});
// What names the credential at the provider (the handle, the remote project) is the platform's own: never in an answer.
const issuedSchema = leaseSchema.extend({
  /** The credential. Shown now and never again: only the platform's own record of the lease is kept. */
  value: z.string(),
});

const issueBody = z.strictObject({
  provider: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,31}$/, "a lower-case provider name")
    .default("gitlab-token"),
  scopes: z.array(z.enum(LEASE_SCOPES)).min(1).max(LEASE_SCOPES.length),
  ttlSeconds: z.number().int().min(LEASE_TTL_SECONDS.min).max(LEASE_TTL_SECONDS.max).optional(),
});

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });
const itemParams = params.extend({ leaseId: z.uuid() });
const sealed = { 500: z.any(), 503: z.any() } as const;

/**
 * Who holds a lease, as the cap counts them. A CI job is its GitLab job, so a job that exchanges again
 * for a fresh token does not get a fresh allowance; the project is in the name because the cap counts
 * across organizations and job ids are only unique within one GitLab. Anyone else is the person behind
 * the session or token.
 */
const holderOf = (p: Principal, projectId: string) => {
  const job = p.kind === "ci" && "job" in p ? jobKey(p.job) : undefined;
  return job ? `ci:${projectId}:${job}` : personOf(p).ref;
};

/** A provider failure as a code and a fixed sentence: the provider's text can carry names we keep to ourselves. */
const failed = (e: unknown) => {
  if (!(e instanceof RotationError)) return e;
  return e.kind === "invalid_config"
    ? new DomainError("lease_invalid", 422, "The lease cannot be made for this project")
    : e.kind === "denied"
      ? new DomainError(
          "lease_denied",
          409,
          "The provider refused: its connection cannot do this for the project",
        )
      : new DomainError("lease_failed", 502, "The provider failed; no lease was made");
};

/**
 * Leases (ROT-11, ADR-0014): a short-lived read-only GitLab token for a project's repository, returned
 * once and kept nowhere. The GitLab project is the one the platform project is linked to, never one the
 * request names; the connection is the organization's only GitLab connection (with several, a project's
 * link says nothing about which instance its id belongs to, so a lease is refused rather than guessed).
 */
export const leaseRoutes = ({
  db,
  principal,
  leasers,
  logger,
}: RouteDeps & { leasers: ReadonlyMap<string, Leaser>; logger: Logger }) => {
  const engine = { db, leasers, logger };
  return new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/leases" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .use(rateLimitPlugin)
    .post(
      "",
      async ({ params: p, body, principal: caller, audit, set }) => {
        if (!caller) throw new Error("the guard lets no anonymous caller through");
        const project = await getProject(db, p.orgId, p.projectId);
        if (!project) throw notFound("Project");
        if (project.gitlabProjectId === null) {
          throw new DomainError("project_not_linked", 409, "The project is not linked to GitLab");
        }
        // shortcut: the first 100 connections are looked at; an organization with more than that and a GitLab one past them is told it has none
        const gitlab = (await listConnections(db, p.orgId, { limit: 100 })).filter(
          (c) => c.type === "gitlab",
        );
        const [connection, other] = gitlab;
        if (!connection) {
          throw new DomainError(
            "no_gitlab_connection",
            409,
            "The organization has no GitLab connection",
          );
        }
        if (other) {
          throw new DomainError(
            "connection_ambiguous",
            409,
            "The organization has more than one GitLab connection, and a lease does not choose between them",
          );
        }
        const holder = holderOf(caller, p.projectId);
        // a CI job's lease ends with the job's own token: a finished job holds nothing
        let ttlSeconds = body.ttlSeconds;
        if (caller.kind === "ci" && "job" in caller && caller.job) {
          const left = Math.floor((caller.job.expiresAt.getTime() - Date.now()) / 1000);
          if (left < LEASE_TTL_SECONDS.min) {
            throw new DomainError(
              "ci_token_ending",
              409,
              "The job's token ends before the shortest lease would",
            );
          }
          ttlSeconds = Math.min(ttlSeconds ?? LEASE_TTL_SECONDS.default, left);
        }
        const record: Recorder = (tx, lease) =>
          audit(tx, {
            action: "lease.issue",
            resourceType: "lease",
            resourceId: lease.id,
            organizationId: p.orgId,
            projectId: p.projectId,
            metadata: {
              provider: lease.provider,
              scopes: lease.scopes,
              principal: holder,
              expiresAt: iso(lease.expiresAt),
            },
          });
        const made = await issueLease(
          engine,
          {
            organizationId: p.orgId,
            projectId: p.projectId,
            remoteProjectId: project.gitlabProjectId,
            connectionId: connection.id,
            provider: body.provider,
            scopes: body.scopes,
            ttlSeconds,
            principal: holder,
          },
          record,
        ).catch((e) => {
          throw failed(e);
        });
        set.status = 201;
        set.headers["cache-control"] = "no-store";
        // The only time the value is shown.
        return { ...dto(made.lease), value: made.value };
      },
      {
        params,
        body: issueBody,
        parse: "json",
        response: { 201: issuedSchema, ...writeErrors, 502: problemSchema, ...sealed },
        audit: "lease.issue",
        guard: "lease.issue",
        limit: "lease_issue",
      },
    )
    .get(
      "",
      async ({ params: p, query }) => {
        if (!(await getProject(db, p.orgId, p.projectId))) throw notFound("Project");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (l: Lease) => [l.id],
          fetch: (after, limit) =>
            listLeases(db, p.orgId, p.projectId, { after: after?.[0], limit }),
          dto,
        });
      },
      {
        params,
        query: pageQuery,
        response: { 200: pageOf(leaseSchema), ...readErrors, ...sealed },
        guard: "lease.read",
      },
    )
    .delete(
      "/:leaseId",
      async ({ params: p, principal: caller, audit, set }) => {
        if (!caller) throw new Error("the guard lets no anonymous caller through");
        const lease = await getLease(db, p.orgId, p.projectId, p.leaseId);
        // a CI job ends its own leases and finds no others
        if (!lease || (caller.kind === "ci" && lease.principal !== holderOf(caller, p.projectId))) {
          throw notFound("Lease");
        }
        const done = await revokeLease(engine, lease, (tx, ended) =>
          audit(tx, {
            action: "lease.revoke",
            resourceType: "lease",
            resourceId: ended.id,
            organizationId: p.orgId,
            projectId: p.projectId,
            metadata: { provider: ended.provider, principal: ended.principal },
          }),
        ).catch((e) => {
          throw failed(e);
        });
        if (done === "already") {
          throw new DomainError("lease_ended", 409, "This lease has already ended");
        }
        set.status = 204;
      },
      {
        params: itemParams,
        response: { 204: z.undefined(), ...writeErrors, 502: problemSchema, ...sealed },
        audit: "lease.revoke",
        guard: "lease.revoke",
      },
    );
};
