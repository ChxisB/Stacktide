import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  audit,
  type Db,
  describeError,
  getSyncTarget,
  isApplying,
  queueDriftChecks,
  queueTargetSync,
  recordDrift,
} from "@orch/db";
import type { GuardrailConfig } from "@orch/sync";
import { z } from "zod";
import { countActions, planTarget } from "./sync-plan";
import type { JobHandler } from "./worker";

/** Ids only: the check reads the variables and the target when it runs. */
const payloadSchema = z.object({
  organizationId: z.uuid(),
  projectId: z.uuid(),
  targetId: z.uuid(),
});

/** The schedule's job: asks for a check of every target (see `queueDriftChecks`). */
export const driftTickHandler =
  (deps: { db: Db }): JobHandler =>
  async (ctx) => {
    const queued = await queueDriftChecks(deps.db);
    ctx.log.info("drift checks queued", { count: queued });
  };

/**
 * The `sync.drift` job (SYNC-8): plans one target without storing or applying anything and records
 * whether applying that plan would change it. Drift is what an apply would write (create, update,
 * delete); an `adopt` line changes nothing and is not drift. A target that opted in to remediation
 * gets an automatic sync (the SYNC-7 job: creates and updates, never deletes) when something is
 * there to write. A target applying right now is left alone, and one that cannot be checked
 * (unreachable, refused, unreadable secret) keeps its last result with its old time: the next tick
 * tries again, so the queue does not retry. Needs the master keys of its own.
 */
export const driftCheckHandler =
  (deps: {
    db: Db;
    keys: KeyProvider;
    logger: Logger;
    guardrails?: GuardrailConfig | undefined;
  }): JobHandler =>
  async (ctx) => {
    const ids = payloadSchema.parse(ctx.payload);
    const { db } = deps;
    const target = await getSyncTarget(db, ids.organizationId, ids.projectId, ids.targetId);
    if (!target || (await isApplying(db, target.id))) return;

    let counts: ReturnType<typeof countActions>;
    try {
      counts = countActions((await planTarget(deps, target, ctx.id)).items);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      ctx.log.warn("drift not checked", { target: target.id, error: describeError(e) });
      return;
    }
    const writes = counts.create + counts.update;
    const status = writes + counts.delete > 0 ? "drifted" : "in_sync";
    await db.transaction(async (tx) => {
      const before = await recordDrift(tx, target, status, counts);
      // a target never checked counts as in sync: only a change of state is news
      if (status !== (before ?? "in_sync")) {
        await audit(
          tx,
          { actor: { kind: "job", id: ctx.id } },
          {
            action: "sync_target.drift",
            resourceType: "sync_target",
            resourceId: target.id,
            organizationId: target.organizationId,
            projectId: target.projectId,
            metadata: { name: target.name, status, counts },
          },
        );
      }
      if (writes > 0 && target.autoRemediate) await queueTargetSync(tx, target, true);
    });
  };
