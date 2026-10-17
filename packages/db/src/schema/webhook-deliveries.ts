import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { connections } from "./connections";
import { jobs } from "./jobs";

/**
 * One row per webhook GitLab delivered with an id (`Idempotency-Key` / `X-Gitlab-Event-UUID`): the
 * primary key is what makes a redelivery a no-op. Holds ids and the event name, never a body.
 * Rows go with their connection; there is no retention job yet.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    connectionId: uuid()
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    deliveryId: text().notNull(),
    event: text().notNull(),
    jobId: uuid().references(() => jobs.id, { onDelete: "set null" }),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.deliveryId] }),
    index("webhook_deliveries_received_idx").on(t.receivedAt),
  ],
);
