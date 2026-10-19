import { DomainError, FINDING_SEVERITIES, FINDING_STATUSES } from "@orch/core";
import {
  dismissFinding,
  type FindingChange,
  getFinding,
  getProject,
  listFindings,
  reopenFinding,
  type SecretFinding,
} from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import { personOf } from "../principal";
import {
  iso,
  notFound,
  paged,
  pageOf,
  pageQuery,
  type RouteDeps,
  readErrors,
  writeErrors,
} from "./shared";

// Where a leaked secret was seen, never what it was: the platform holds nothing else (SCAN-2), so there is nothing more to leave out.
const findingSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  rule: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  commit: z.string(),
  severity: z.enum(FINDING_SEVERITIES),
  ref: z.string(),
  status: z.enum(FINDING_STATUSES),
  /** Who dismissed it (`user:<id>`), why, and when; all null unless it is dismissed. */
  dismissedBy: z.string().nullable(),
  dismissedReason: z.string().nullable(),
  dismissedAt: z.iso.datetime().nullable(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
const dto = (f: SecretFinding): z.infer<typeof findingSchema> => ({
  id: f.id,
  organizationId: f.organizationId,
  projectId: f.projectId,
  rule: f.rule,
  path: f.path,
  line: f.line,
  commit: f.commit,
  severity: f.severity as z.infer<typeof findingSchema>["severity"],
  ref: f.ref,
  status: f.status as z.infer<typeof findingSchema>["status"],
  dismissedBy: f.dismissedBy,
  dismissedReason: f.dismissedReason,
  dismissedAt: f.dismissedAt && iso(f.dismissedAt),
  firstSeenAt: iso(f.firstSeenAt),
  lastSeenAt: iso(f.lastSeenAt),
  createdAt: iso(f.createdAt),
});

const dismissBody = z.strictObject({ reason: z.string().trim().min(1).max(1000) });
const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });
const itemParams = params.extend({ findingId: z.uuid() });
const sealed = { 500: z.any(), 503: z.any() } as const;

/** The outcome of a triage call as an answer: the finding, or why it could not move. */
function settled(out: FindingChange, wanted: "open" | "dismissed") {
  if (!out) throw notFound("Finding");
  if (out.result === "changed") return dto(out.finding);
  throw wanted === "open"
    ? new DomainError("finding_not_open", 409, `This finding is already ${out.status}`)
    : new DomainError("finding_not_dismissed", 409, `This finding is ${out.status}, not dismissed`);
}

/**
 * Secret findings (SCAN-4): what the project's secret-detection job reported, read by any member and
 * triaged by a maintainer. Dismissing needs a reason and is audited; reopening is audited too, and since
 * it clears the row's reason, the audit event keeps what was said. A finding is a secret that was in the
 * repository: dismissing it does not make it safe, and the platform cannot revoke it (docs/secret-scanning.md).
 */
export const findingRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/findings" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: p, query }) => {
        if (!(await getProject(db, p.orgId, p.projectId))) throw notFound("Project");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (f: SecretFinding) => [f.id],
          fetch: (after, limit) =>
            listFindings(
              db,
              p.orgId,
              p.projectId,
              { after: after?.[0], limit },
              { status: query.status },
            ),
          dto,
        });
      },
      {
        params,
        query: pageQuery.extend({ status: z.enum(FINDING_STATUSES).optional() }),
        response: { 200: pageOf(findingSchema), ...readErrors, ...sealed },
        guard: "finding.read",
      },
    )
    .get(
      "/:findingId",
      async ({ params: p }) => {
        const finding = await getFinding(db, p.orgId, p.projectId, p.findingId);
        if (!finding) throw notFound("Finding");
        return dto(finding);
      },
      {
        params: itemParams,
        response: { 200: findingSchema, ...readErrors, ...sealed },
        guard: "finding.read",
      },
    )
    .post(
      "/:findingId/dismiss",
      async ({ params: p, body, principal: caller, audit }) => {
        if (!caller) throw new Error("the guard lets no anonymous caller through");
        const scope = { organizationId: p.orgId, projectId: p.projectId, id: p.findingId };
        const out = await db.transaction(async (tx) => {
          const r = await dismissFinding(tx, scope, personOf(caller).ref, body.reason);
          if (r?.result === "changed") {
            await audit(tx, {
              action: "finding.dismiss",
              resourceType: "finding",
              resourceId: r.finding.id,
              organizationId: p.orgId,
              projectId: p.projectId,
              metadata: { rule: r.finding.rule, path: r.finding.path, reason: body.reason },
            });
          }
          return r;
        });
        return settled(out, "open");
      },
      {
        params: itemParams,
        body: dismissBody,
        parse: "json",
        response: { 200: findingSchema, ...writeErrors, ...sealed },
        audit: "finding.dismiss",
        guard: "finding.dismiss",
      },
    )
    .post(
      "/:findingId/reopen",
      async ({ params: p, audit }) => {
        const scope = { organizationId: p.orgId, projectId: p.projectId, id: p.findingId };
        const out = await db.transaction(async (tx) => {
          const r = await reopenFinding(tx, scope);
          if (r?.result === "changed") {
            await audit(tx, {
              action: "finding.reopen",
              resourceType: "finding",
              resourceId: r.finding.id,
              organizationId: p.orgId,
              projectId: p.projectId,
              metadata: { rule: r.finding.rule, path: r.finding.path },
            });
          }
          return r;
        });
        return settled(out, "dismissed");
      },
      {
        params: itemParams,
        response: { 200: findingSchema, ...writeErrors, ...sealed },
        audit: "finding.reopen",
        guard: "finding.reopen",
      },
    );
