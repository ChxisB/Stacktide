import {
  DomainError,
  NOTIFICATION_EVENTS,
  SINK_KINDS,
  type SinkKind,
  takesAudit,
  takesNotifications,
} from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  createSink,
  deleteSink,
  disableForwarding,
  enableForwarding,
  getForwarding,
  getOrganization,
  getProject,
  getSink,
  listSinks,
  listSubscriptions,
  removeSubscriptions,
  type Sink,
  setSubscriptions,
} from "@orch/db";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { guardPlugin } from "../guard";
import { newWebhookSecret, SinkUrlError, sealSink, sinkUrl } from "../notify";
import {
  deleteResponses,
  iso,
  mapDbError,
  name,
  notFound,
  paged,
  pageOf,
  pageQuery,
  problemSchema,
  type RouteDeps,
  readErrors,
  stamps,
  taken,
  writeErrors,
} from "./shared";

const kind = z.enum(SINK_KINDS);
const event = z.enum(NOTIFICATION_EVENTS);

const sinkSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  kind,
  name: z.string(),
  /** The one part of the address that is shown: where it points, not what it says. */
  host: z.string(),
  ...stamps,
});
const sinkDto = (s: Sink): z.infer<typeof sinkSchema> => ({
  id: s.id,
  organizationId: s.organizationId,
  kind: s.kind,
  name: s.name,
  host: s.host,
  createdAt: iso(s.createdAt),
  updatedAt: iso(s.updatedAt),
});

/** The address is a credential: a refusal says what is wrong with it, never what it was. */
const address = (k: SinkKind) =>
  z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .superRefine((v, ctx) => {
      try {
        sinkUrl(k, v);
      } catch (e) {
        if (!(e instanceof SinkUrlError)) throw e;
        ctx.addIssue({ code: "custom", message: e.message });
      }
    });

/** Goes into a header, so printable ASCII without spaces; a refusal says so and does not quote it. */
const credential = z
  .string()
  .max(500)
  .regex(/^[!-~]+$/, "must be printable characters without spaces");

const create = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("webhook"), name, url: address("webhook") }),
  z.strictObject({ kind: z.literal("slack"), name, url: address("slack") }),
  // the collectors of the audit log (GOV-4); the credential is sealed with the address and never shown again
  z.strictObject({ kind: z.literal("syslog"), name, url: address("syslog") }),
  z.strictObject({
    kind: z.literal("datadog"),
    name,
    url: address("datadog"),
    apiKey: credential,
  }),
  z.strictObject({ kind: z.literal("splunk"), name, url: address("splunk"), token: credential }),
]);

const created = sinkSchema.extend({
  /** A webhook's signing secret. Shown here and never again. */
  secret: z.string().optional(),
});

const orgParams = z.object({ orgId: z.uuid() });
const sinkParams = orgParams.extend({ sinkId: z.uuid() });
const subParams = z.object({ orgId: z.uuid(), projectId: z.uuid(), sinkId: z.uuid() });
const projectParams = subParams.omit({ sinkId: true });
const unavailable = { ...writeErrors, 503: problemSchema } as const;

const auditedSink = (
  action: string,
  s: Pick<Sink, "id" | "organizationId">,
  metadata: Record<string, unknown>,
) => ({
  action,
  resourceType: "notification_sink",
  resourceId: s.id,
  organizationId: s.organizationId,
  metadata,
});
const sinkFacts = (s: Sink) => ({ kind: s.kind, name: s.name, host: s.host });

/**
 * Where an organization's notifications go (POL-2). The address, which is a credential, is sealed
 * before it is stored and is never in an answer, a list, a log line or an audit row; a webhook's
 * signing secret is returned once, by the call that makes it. Org admins only.
 */
export const notificationSinkRoutes = ({
  db,
  principal,
  keys,
}: RouteDeps & { keys?: KeyProvider }) =>
  new Elysia({ prefix: "/organizations/:orgId/notification-sinks" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId }, query }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (s) => [s.id],
          fetch: (after, limit) => listSinks(db, orgId, { after: after?.[0], limit }),
          dto: sinkDto,
        });
      },
      {
        params: orgParams,
        query: pageQuery,
        response: { 200: pageOf(sinkSchema), ...readErrors },
        guard: "notification.sink.read",
      },
    )
    .post(
      "",
      async ({ params: { orgId }, body, audit, set }) => {
        if (!keys) throw noKeys();
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        // a webhook's secret is made here and shown once; a collector's credential came with the request
        const generated = body.kind === "webhook" ? newWebhookSecret() : undefined;
        const secret =
          body.kind === "datadog" ? body.apiKey : body.kind === "splunk" ? body.token : generated;
        const sink = await db
          .transaction(async (tx) => {
            const s = await createSink(tx, keys, {
              organizationId: orgId,
              kind: body.kind,
              name: body.name,
              host: new URL(body.url).host,
              secret: sealSink({ url: body.url, secret }),
            });
            await audit(tx, auditedSink("notification.sink.create", s, sinkFacts(s)));
            return s;
          })
          .catch(
            mapDbError({
              notification_sinks_org_name_key: taken("name_taken", "The name"),
              notification_sinks_organization_id_organizations_id_fk: notFound("Organization"),
            }),
          );
        set.status = 201;
        // the signing secret is in this answer and nowhere else
        set.headers["cache-control"] = "no-store";
        return { ...sinkDto(sink), ...(generated === undefined ? {} : { secret: generated }) };
      },
      {
        params: orgParams,
        body: create,
        parse: "json",
        response: { 201: created, ...unavailable },
        audit: "notification.sink.create",
        guard: "notification.sink.create",
      },
    )
    .delete(
      "/:sinkId",
      async ({ params: { orgId, sinkId }, audit, set }) => {
        await db.transaction(async (tx) => {
          const s = await getSink(tx, orgId, sinkId);
          // its subscriptions go with it
          if (!s || !(await deleteSink(tx, orgId, sinkId))) throw notFound("Notification sink");
          await audit(tx, auditedSink("notification.sink.delete", s, sinkFacts(s)));
        });
        set.status = 204;
      },
      {
        params: sinkParams,
        response: deleteResponses,
        audit: "notification.sink.delete",
        guard: "notification.sink.delete",
      },
    );

const subscriptionSchema = z.object({
  sinkId: z.uuid(),
  event,
  name: z.string(),
  kind,
  host: z.string(),
});
type Subscription = Awaited<ReturnType<typeof listSubscriptions>>[number];
const subscribed = z.object({ sinkId: z.uuid(), events: z.array(event) });
const subscribe = z.strictObject({ events: z.array(event).min(1).max(20) });

const auditedSubscription = (
  action: string,
  s: { organizationId: string; projectId: string; sinkId: string },
  metadata: Record<string, unknown>,
) => ({
  action,
  resourceType: "notification_sink",
  resourceId: s.sinkId,
  organizationId: s.organizationId,
  projectId: s.projectId,
  metadata,
});

/**
 * What a project asks of the organization's sinks (POL-2): which events each one hears of. Anyone
 * who can read the project sees the list (names and hosts, nothing else); org admins change it.
 */
export const notificationSubscriptionRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/notifications" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId, projectId }, query }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        return paged(query, {
          key: z.tuple([z.uuid(), z.string()]),
          keyOf: (s: Subscription): [string, string] => [s.sinkId, s.event],
          fetch: (after, limit) => listSubscriptions(db, orgId, projectId, { after, limit }),
          dto: (s) => s,
        });
      },
      {
        params: projectParams,
        query: pageQuery,
        response: { 200: pageOf(subscriptionSchema), ...readErrors },
        guard: "notification.subscription.read",
      },
    )
    .put(
      "/:sinkId",
      async ({ params: { orgId, projectId, sinkId }, body, audit }) => {
        const events = [...new Set(body.events)];
        await db
          .transaction(async (tx) => {
            if (!(await getProject(tx, orgId, projectId))) throw notFound("Project");
            const sink = await getSink(tx, orgId, sinkId);
            if (!sink) throw notFound("Notification sink");
            if (!takesNotifications(sink.kind)) {
              throw new DomainError(
                "sink_kind_not_for_notifications",
                409,
                "This kind of sink takes the audit log, not notifications",
              );
            }
            await setSubscriptions(tx, { organizationId: orgId, projectId, sinkId, events });
            await audit(
              tx,
              auditedSubscription(
                "notification.subscription.update",
                { organizationId: orgId, projectId, sinkId },
                { events },
              ),
            );
          })
          .catch(
            mapDbError({
              // the sink or the project went between the check and the write
              notification_subscriptions_sink_org_fk: notFound("Notification sink"),
              notification_subscriptions_project_org_fk: notFound("Project"),
            }),
          );
        return { sinkId, events };
      },
      {
        params: subParams,
        body: subscribe,
        parse: "json",
        response: { 200: subscribed, ...writeErrors },
        audit: "notification.subscription.update",
        guard: "notification.subscription.update",
      },
    )
    .delete(
      "/:sinkId",
      async ({ params: { orgId, projectId, sinkId }, audit, set }) => {
        await db.transaction(async (tx) => {
          if (!(await getProject(tx, orgId, projectId))) throw notFound("Project");
          if (!(await removeSubscriptions(tx, orgId, projectId, sinkId))) {
            throw notFound("Subscription");
          }
          await audit(
            tx,
            auditedSubscription(
              "notification.subscription.delete",
              { organizationId: orgId, projectId, sinkId },
              {},
            ),
          );
        });
        set.status = 204;
      },
      {
        params: subParams,
        response: deleteResponses,
        audit: "notification.subscription.delete",
        // A project's say in a sink is the organization's to give and take (no separate action).
        guard: "notification.subscription.update",
      },
    );

const forwardingSchema = z.object({
  sinkId: z.uuid(),
  /** The id of the last event handed over; every event with a higher id is still to come. */
  cursor: z.string(),
  deliveredAt: z.iso.datetime().nullable(),
  failures: z.number().int().min(0),
  /** Why the last try failed: a fixed sentence, never what the sink said. */
  lastError: z.string().nullable(),
  nextAttemptAt: z.iso.datetime(),
  ...stamps,
});
const forwardingDto = (f: NonNullable<Awaited<ReturnType<typeof getForwarding>>>) => ({
  sinkId: f.sinkId,
  cursor: f.cursor,
  deliveredAt: f.deliveredAt ? iso(f.deliveredAt) : null,
  failures: f.failures,
  lastError: f.lastError,
  nextAttemptAt: iso(f.nextAttemptAt),
  createdAt: iso(f.createdAt),
  updatedAt: iso(f.updatedAt),
});
const forwardStart = z.strictObject({
  /** Where a new forwarding begins: after what is written from now on, or at the start of the log still kept. */
  from: z.enum(["now", "start"]).default("now"),
});

/**
 * Sending an organization's audit log to one of its collectors (GOV-4). A sink of a kind that takes
 * the audit log is told to start; from then on the worker hands it every event, in id order, at least
 * once. The state shown is the cursor and the last failure, never an address or a credential.
 * Org admins only.
 */
export const auditForwardingRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/notification-sinks/:sinkId/audit-forwarding" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId, sinkId } }) => {
        const f = await getForwarding(db, orgId, sinkId);
        if (!f) throw notFound("Audit forwarding");
        return forwardingDto(f);
      },
      {
        params: sinkParams,
        response: { 200: forwardingSchema, ...readErrors },
        guard: "audit.forwarding.read",
      },
    )
    .put(
      "",
      async ({ params: { orgId, sinkId }, body, audit, set }) => {
        const { forwarding, created } = await db
          .transaction(async (tx) => {
            const s = await getSink(tx, orgId, sinkId);
            if (!s) throw notFound("Notification sink");
            if (!takesAudit(s.kind)) {
              throw new DomainError(
                "sink_kind_not_for_audit",
                409,
                "This kind of sink cannot take the audit log",
              );
            }
            const r = await enableForwarding(tx, {
              organizationId: orgId,
              sinkId,
              from: body.from,
              now: new Date(),
            });
            await audit(
              tx,
              auditedSink("audit.forwarding.update", s, {
                ...sinkFacts(s),
                // an existing forwarding keeps its place, so what was asked for is not what happened
                ...(r.created ? { from: body.from } : {}),
                created: r.created,
              }),
            );
            return r;
          })
          // the sink went between the check and the write
          .catch(mapDbError({ audit_forwards_sink_org_fk: notFound("Notification sink") }));
        set.status = created ? 201 : 200;
        return forwardingDto(forwarding);
      },
      {
        params: sinkParams,
        body: forwardStart,
        parse: "json",
        response: { 200: forwardingSchema, 201: forwardingSchema, ...writeErrors },
        audit: "audit.forwarding.update",
        guard: "audit.forwarding.update",
      },
    )
    .delete(
      "",
      async ({ params: { orgId, sinkId }, audit, set }) => {
        await db.transaction(async (tx) => {
          const s = await getSink(tx, orgId, sinkId);
          if (!s || !(await disableForwarding(tx, orgId, sinkId))) {
            throw notFound("Audit forwarding");
          }
          await audit(tx, auditedSink("audit.forwarding.delete", s, sinkFacts(s)));
        });
        set.status = 204;
      },
      {
        params: sinkParams,
        response: deleteResponses,
        audit: "audit.forwarding.delete",
        guard: "audit.forwarding.update",
      },
    );
