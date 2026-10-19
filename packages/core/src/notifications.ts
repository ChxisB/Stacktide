/**
 * Where an organization sends things (POL-2, GOV-4): an HMAC-signed webhook, a Slack incoming webhook,
 * or a collector for the audit log: syslog over TLS, Datadog logs, Splunk HEC.
 */
export const SINK_KINDS = ["webhook", "slack", "syslog", "datadog", "splunk"] as const;
export type SinkKind = (typeof SINK_KINDS)[number];

/** The kinds that can hear of a project's events: a person's chat or a receiver of JSON. */
export const NOTIFICATION_SINK_KINDS = ["webhook", "slack"] as const satisfies readonly SinkKind[];
/** The kinds that can be sent the audit log (GOV-4): the ones that take a batch of records. */
export const FORWARDING_SINK_KINDS = [
  "webhook",
  "syslog",
  "datadog",
  "splunk",
] as const satisfies readonly SinkKind[];

export const takesNotifications = (k: SinkKind): k is (typeof NOTIFICATION_SINK_KINDS)[number] =>
  (NOTIFICATION_SINK_KINDS as readonly string[]).includes(k);
export const takesAudit = (k: SinkKind): k is (typeof FORWARDING_SINK_KINDS)[number] =>
  (FORWARDING_SINK_KINDS as readonly string[]).includes(k);

/** What a project can ask to hear of. Each one's payload is names and counts, never a value. */
export const NOTIFICATION_EVENTS = ["stack.drift", "rotation.failing"] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
