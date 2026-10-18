import { audit, type Db, expireChangeRequests } from "@orch/db";
import type { JobHandler } from "./worker";

/** Requests closed in one transaction, and rounds in one run: a backlog is worked off over several ticks. */
export const EXPIRE_BATCH = 500;
export const EXPIRE_ROUNDS = 10;

/**
 * The `change_request.expire` schedule's job (GOV-2): closes the change requests nobody decided in
 * time, drops their sealed values, and writes a `change_request.expire` event for each in the same
 * transaction. It needs no keys: nothing is opened.
 */
export const changeRequestExpireHandler =
  (deps: { db: Db; batch?: number; rounds?: number }): JobHandler =>
  async (ctx) => {
    const { batch: size = EXPIRE_BATCH, rounds = EXPIRE_ROUNDS } = deps;
    let total = 0;
    for (let round = 0; round < rounds; round++) {
      const closed = await deps.db.transaction(async (tx) => {
        const expired = await expireChangeRequests(tx, size);
        for (const r of expired) {
          await audit(
            tx,
            { actor: { kind: "system", id: "change-request-expire" } },
            {
              action: "change_request.expire",
              resourceType: "change_request",
              resourceId: r.id,
              organizationId: r.organizationId,
              projectId: r.projectId,
              metadata: {
                environmentId: r.environmentId,
                authorKind: r.authorKind,
                authorId: r.authorId,
              },
            },
          );
        }
        return expired.length;
      });
      total += closed;
      if (closed < size) break;
    }
    if (total > 0) ctx.log.info("change requests expired", { count: total });
  };
