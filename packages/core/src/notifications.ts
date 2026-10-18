/** Where a notification can go: an HMAC-signed webhook, or a Slack incoming webhook. */
export const SINK_KINDS = ["webhook", "slack"] as const;
export type SinkKind = (typeof SINK_KINDS)[number];

/** What a project can ask to hear of. Each one's payload is names and counts, never a value. */
export const NOTIFICATION_EVENTS = ["stack.drift"] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
