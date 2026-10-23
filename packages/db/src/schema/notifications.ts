import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { organizations } from "./organizations";
import { projects } from "./projects";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * Somewhere the platform tells people things (POL-2): an organization's outbound webhook (`webhook`,
 * signed with an HMAC secret) or Slack incoming webhook (`slack`). The address is sealed with the
 * sink's own data key, together with the signing secret of a `webhook`, exactly as a connection's
 * token is (`secret_enc`, `dek_*`, ADR-0007): a Slack address is itself the credential, and a
 * webhook address often carries a token. `host` is the one part of it kept readable, for lists.
 * Only `notifications.ts` in this package reads the three secret columns.
 */
export const notificationSinks = pgTable(
  "notification_sinks",
  {
    id: id(),
    // RESTRICT: removing an organization never silently takes its credentials with it.
    organizationId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    kind: text().notNull(),
    name: text().notNull(),
    host: text().notNull(),
    secretEnc: bytea().notNull(),
    dekKeyId: text().notNull(),
    dekWrapped: bytea().notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("notification_sinks_org_name_key").on(t.organizationId, t.name),
    // Target of the composite foreign key that keeps a subscription in its sink's organization.
    unique("notification_sinks_id_org_key").on(t.id, t.organizationId),
    check(
      "notification_sinks_kind_check",
      sql`${t.kind} in ('webhook', 'slack', 'syslog', 'datadog', 'splunk')`,
    ),
  ],
);

/**
 * A project asking a sink to hear of an event (`stack.drift`, `rotation.failing`, `deployment.failed`). One row per sink, project and event;
 * both foreign keys carry the organization, so a project can only use its own organization's sinks.
 */
export const notificationSubscriptions = pgTable(
  "notification_subscriptions",
  {
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    sinkId: uuid().notNull(),
    event: text().notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.sinkId, t.projectId, t.event] }),
    // the project's side of the cascade, and of "who hears of this project"
    index("notification_subscriptions_project_idx").on(t.projectId),
    // CASCADE: a subscription is configuration of both ends and goes with either.
    foreignKey({
      name: "notification_subscriptions_sink_org_fk",
      columns: [t.sinkId, t.organizationId],
      foreignColumns: [notificationSinks.id, notificationSinks.organizationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "notification_subscriptions_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check(
      "notification_subscriptions_event_check",
      sql`${t.event} in ('stack.drift', 'rotation.failing', 'deployment.failed')`,
    ),
  ],
);

/**
 * A sink that is sent the organization's audit log (GOV-4), and how far it has got. `cursor` is the id
 * of the last event handed over: events are sent in id order, and a batch moves it only after the sink
 * took the batch, so a failure or a crash sends the batch again (at least once; receivers dedupe by
 * event id). `failures`/`last_error` (a fixed sentence, never an address) and `next_attempt_at` are the
 * backoff of an unreachable sink; `delivered_at` is the last batch that went through.
 */
export const auditForwards = pgTable(
  "audit_forwards",
  {
    sinkId: uuid().primaryKey(),
    organizationId: uuid().notNull(),
    cursor: uuid().notNull(),
    deliveredAt: timestamp({ withTimezone: true }),
    failures: integer().notNull().default(0),
    lastError: text(),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    // CASCADE: forwarding is configuration of the sink and goes with it.
    foreignKey({
      name: "audit_forwards_sink_org_fk",
      columns: [t.sinkId, t.organizationId],
      foreignColumns: [notificationSinks.id, notificationSinks.organizationId],
    }).onDelete("cascade"),
    index("audit_forwards_due_idx").on(t.nextAttemptAt),
    check("audit_forwards_failures_check", sql`${t.failures} >= 0`),
  ],
);
