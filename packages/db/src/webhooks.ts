import { and, eq } from "drizzle-orm";
import { enqueue } from "./jobs";
import type { Executor } from "./repo";
import { connections, webhookDeliveries } from "./schema";

/** The queue every received webhook becomes a job on. */
export const WEBHOOK_QUEUE = "gitlab.event";

/**
 * Stores the hash of a connection's webhook secret, replacing the one before (which stops
 * working). True when the connection exists in the organization.
 */
export async function setWebhookSecretHash(
  db: Executor,
  organizationId: string,
  id: string,
  hash: string,
) {
  const rows = await db
    .update(connections)
    .set({ webhookSecretHash: hash })
    .where(and(eq(connections.id, id), eq(connections.organizationId, organizationId)))
    .returning({ id: connections.id });
  return rows.length > 0;
}

/**
 * What the receiver needs from a connection id alone (a webhook carries no organization): who
 * owns it and the hash of its secret, null when it takes no webhooks.
 */
export async function webhookTarget(db: Executor, id: string) {
  const [row] = await db
    .select({
      organizationId: connections.organizationId,
      type: connections.type,
      secretHash: connections.webhookSecretHash,
    })
    .from(connections)
    .where(eq(connections.id, id));
  return row;
}

/**
 * Turns one webhook into one job. With a `deliveryId` the delivery is recorded first: a repeat
 * (GitLab retries, or two requests at once) finds the row and creates nothing, and a failure to
 * enqueue rolls the row back so the retry can succeed. Without one there is nothing to dedupe on.
 * `payload` is ids and fields picked from the event, never the body (see `enqueue`).
 */
export function recordDelivery(
  db: Executor,
  d: {
    connectionId: string;
    deliveryId?: string;
    event: string;
    payload: Record<string, unknown>;
  },
): Promise<"queued" | "duplicate"> {
  return db.transaction(async (tx) => {
    const { connectionId, deliveryId, event } = d;
    if (deliveryId !== undefined) {
      const fresh = await tx
        .insert(webhookDeliveries)
        .values({ connectionId, deliveryId, event })
        .onConflictDoNothing()
        .returning({ deliveryId: webhookDeliveries.deliveryId });
      if (fresh.length === 0) return "duplicate";
    }
    const job = await enqueue(tx, { queue: WEBHOOK_QUEUE, payload: d.payload });
    if (deliveryId !== undefined) {
      await tx
        .update(webhookDeliveries)
        .set({ jobId: job.id })
        .where(
          and(
            eq(webhookDeliveries.connectionId, connectionId),
            eq(webhookDeliveries.deliveryId, deliveryId),
          ),
        );
    }
    return "queued";
  });
}
