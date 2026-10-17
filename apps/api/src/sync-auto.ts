import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  audit,
  type Db,
  describeError,
  getSyncTarget,
  pgConstraint,
  queueTargetSync,
} from "@orch/db";
import { z } from "zod";
import { startApply } from "./sync-apply";
import { planTarget, storePlan } from "./sync-plan";
import type { JobHandler } from "./worker";

/** Ids only: the job reads the variables when it runs, so no value is ever queued. */
const payloadSchema = z.object({
  organizationId: z.uuid(),
  projectId: z.uuid(),
  targetId: z.uuid(),
});

const WRITES = new Set(["create", "update"]);

/**
 * The `sync.auto` job (SYNC-7): a variable changed, so plan the target and apply the plan. It
 * is the same plan and apply as by hand, done as the job: audited, one apply per target, the plan
 * stored. It never deletes: it plans as if the target's policy were `ignore`, so removing what the
 * target holds stays a person's call (their own plan still shows it). A target that is busy applying
 * is queued again for later. A plan that cannot be made because of the target or its variables
 * (a 4xx: a value the target cannot hold) is logged, not retried: a change that fixes it queues the
 * target again. Anything else (the target does not answer, a secret cannot be opened) fails the job,
 * so the queue retries it and, in the end, keeps it dead with its error. Needs the master keys of
 * its own.
 */
export const syncAutoHandler =
  (deps: { db: Db; keys: KeyProvider; logger: Logger }): JobHandler =>
  async (ctx) => {
    const ids = payloadSchema.parse(ctx.payload);
    const { db } = deps;
    const target = await getSyncTarget(db, ids.organizationId, ids.projectId, ids.targetId);
    // gone, or switched to manual since the change
    if (!target?.autoSync) return;

    let planned: Awaited<ReturnType<typeof planTarget>>;
    try {
      planned = await planTarget(deps, target, ctx.id, "ignore");
    } catch (e) {
      if (!(e instanceof DomainError && e.status < 500)) throw e;
      ctx.log.warn("auto-sync not planned", { target: target.id, error: describeError(e) });
      return;
    }
    // nothing to write: no run to show, the change did not reach this target
    if (!planned.items.some((i) => WRITES.has(i.action))) return;

    const actor = { actor: { kind: "job", id: ctx.id } } as const;
    try {
      await db.transaction(async (tx) => {
        const run = await storePlan(tx, target, planned);
        await audit(tx, actor, {
          action: "sync_run.plan",
          resourceType: "sync_run",
          resourceId: run.id,
          organizationId: target.organizationId,
          projectId: target.projectId,
          metadata: { targetId: target.id, name: target.name, counts: run.counts, auto: true },
        });
        await startApply(tx, run, target, (t, event) => audit(t, actor, event));
      });
    } catch (e) {
      if (pgConstraint(e) !== "sync_runs_one_applying") throw e;
      // shortcut: planned again every 30 s while the other apply lasts; a pre-check that also reaps dead applies would save the reads
      ctx.log.info("auto-sync waits: the target is applying", { target: target.id });
      return queueTargetSync(db, target);
    }
  };
