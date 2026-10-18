import { audit, type Db, purgeExpiredAudit } from "@orch/db";
import type { JobHandler } from "./worker";

/** Events deleted in one transaction, and rounds in one run: a backlog is worked off over several ticks, not in one long lock. */
export const PURGE_BATCH = 1000;
export const PURGE_ROUNDS = 20;

/**
 * The `audit.purge` schedule's job (GOV-1): deletes the audit events that are older than their
 * organization's retention, and writes an `audit.purge` event (the count, nothing else) for each
 * organization it took from, in the transaction that deletes, so the log always says it was cut.
 * The cutoff is not computed here: `purgeExpiredAudit` leaves it to the organization's own setting.
 */
export const auditPurgeHandler =
  (deps: { db: Db; batch?: number; rounds?: number }): JobHandler =>
  async (ctx) => {
    const { batch: size = PURGE_BATCH, rounds = PURGE_ROUNDS } = deps;
    let total = 0;
    for (let round = 0; round < rounds; round++) {
      const batch = await deps.db.transaction(async (tx) => {
        const gone = await purgeExpiredAudit(tx, size);
        for (const g of gone) {
          await audit(
            tx,
            { actor: { kind: "system", id: "audit-purge" } },
            {
              action: "audit.purge",
              resourceType: "audit_log",
              resourceId: g.organizationId,
              organizationId: g.organizationId,
              metadata: { count: g.purged },
            },
          );
        }
        return gone.reduce((n, g) => n + g.purged, 0);
      });
      total += batch;
      if (batch < size) break;
    }
    if (total > 0) ctx.log.info("audit events purged", { count: total });
  };
