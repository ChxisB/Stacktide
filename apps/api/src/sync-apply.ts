import { DomainError, type Logger } from "@orch/core";
import { CryptoError, type KeyProvider } from "@orch/crypto";
import {
  type AuditEvent,
  audit,
  claimSyncRun,
  consumeApproval,
  type Db,
  describeError,
  enqueue,
  failStuckApplies,
  finishSyncRun,
  getSyncRun,
  getSyncTarget,
  listSyncRunItems,
  recordSyncItem,
  type SyncRun,
  type SyncTarget,
  type Tx,
} from "@orch/db";
import { type ItemInput, type PlanAction, type Remote, refId, SyncError } from "@orch/sync";
import { z } from "zod";
import { approvalRequired, protectedMappings } from "./apply-approval";
import type { CloudDeps } from "./connections";
import { desiredSnapshot, openTarget } from "./sync-plan";
import type { JobContext, JobHandler } from "./worker";

export const SYNC_APPLY = "sync.apply";

/** Ids only: the job looks everything else up, so no value is ever queued. */
const payloadSchema = z.object({
  organizationId: z.uuid(),
  projectId: z.uuid(),
  targetId: z.uuid(),
  runId: z.uuid(),
});

/**
 * Hands a planned run to the `sync.apply` job and marks it applying, in the caller's transaction:
 * the one place that decides a plan may be applied (the database's clock decides expiry and the
 * one-at-a-time rule; a second apply on the target is a unique violation of
 * `sync_runs_one_applying`). `record` writes the audit rows as whoever asked. A target mapped to a
 * protected environment (GOV-3) also needs an approved change request for this plan, which is used
 * up here, in the same transaction: an apply that does not start keeps the approval.
 */
export async function startApply(
  tx: Tx,
  run: SyncRun,
  target: SyncTarget,
  record: (tx: Tx, event: AuditEvent) => Promise<unknown>,
): Promise<SyncRun> {
  const { organizationId, projectId } = run;
  const guarded = await protectedMappings(tx, target);
  const approval =
    guarded.length === 0
      ? undefined
      : await consumeApproval(
          tx,
          { organizationId, projectId },
          { kind: "sync_apply", runId: run.id, targetId: target.id },
        );
  if (guarded.length > 0 && !approval) throw approvalRequired(`Target ${target.name}`, guarded);
  // an apply that cannot finish must not block the target for good
  for (const id of await failStuckApplies(tx, organizationId, projectId, target.id)) {
    await record(tx, {
      action: "sync_run.failed",
      resourceType: "sync_run",
      resourceId: id,
      organizationId,
      projectId,
      metadata: { targetId: target.id, name: target.name, reason: "stuck" },
    });
  }
  const job = await enqueue(tx, {
    queue: SYNC_APPLY,
    payload: { organizationId, projectId, targetId: target.id, runId: run.id },
  });
  const claimed = await claimSyncRun(tx, organizationId, projectId, target.id, run.id, job.id);
  if (!claimed) {
    throw new DomainError(
      "plan_not_applicable",
      409,
      "This plan can no longer be applied: plan again",
    );
  }
  await record(tx, {
    action: "sync_run.apply",
    resourceType: "sync_run",
    resourceId: run.id,
    organizationId,
    projectId,
    metadata: {
      targetId: target.id,
      name: target.name,
      counts: run.counts,
      ...(approval && { changeRequestId: approval.id }),
    },
  });
  return claimed;
}

/** Creates first and deletes last, so a failure part-way leaves more than it removes. */
const ORDER: Partial<Record<PlanAction, number>> = { create: 0, update: 1, delete: 2 };

const isKind = (e: unknown, kind: SyncError["kind"]) => e instanceof SyncError && e.kind === kind;

/** What an item is written as; a create that finds it there updates it, an update that finds nothing creates it, so a line can be repeated. */
async function write(remote: Remote, action: PlanAction, want: ItemInput) {
  if (action === "create") {
    await remote.create(want).catch((e) => {
      if (!isKind(e, "exists")) throw e;
      return remote.update(want);
    });
  } else {
    await remote.update(want).catch((e) => {
      if (!isKind(e, "not_found")) throw e;
      return remote.create(want);
    });
  }
}

/** Words for a run that cannot go on at all, or nothing when another try may work. They name no value. */
function fatal(e: unknown): string | undefined {
  if (e instanceof DomainError || e instanceof SyncError) return e.message;
  if (e instanceof CryptoError) return "A stored secret cannot be opened: check ORCH_MASTER_KEYS";
  return undefined;
}

/**
 * Writes the lines of a run to its target, recording what happened to each. Returns how many lines
 * failed in a way worth another try (the target did not answer): the queue brings the job back for
 * them, and a line already `applied` is never written again.
 */
async function applyLines(
  deps: { db: Db; keys: KeyProvider; logger: Logger; cloud?: CloudDeps | undefined },
  ctx: JobContext,
  run: SyncRun,
  target: SyncTarget,
): Promise<number> {
  const { db, keys } = deps;
  const adapter = await openTarget(deps, target, ctx.id);
  const config = adapter.validate(target.config);
  // the same check the endpoint made: a plan is only applied while it is still true
  const desired = await desiredSnapshot(db, keys, target);
  if (desired.digest !== run.desiredDigest) {
    throw new DomainError(
      "plan_stale",
      409,
      "The variables or the target's settings changed after the plan was made: plan again",
    );
  }
  const wanted = new Map(desired.items.map((i) => [refId(i), i]));
  const remote = adapter.connect(config);
  const last = ctx.attempt >= ctx.maxAttempts;

  const todo = (await listSyncRunItems(db, run.id))
    .filter((l) => l.result === null && ORDER[l.action as PlanAction] !== undefined)
    .sort(
      (a, b) =>
        (ORDER[a.action as PlanAction] ?? 0) - (ORDER[b.action as PlanAction] ?? 0) ||
        a.position - b.position,
    );
  let retry = 0;
  for (const line of todo) {
    // the lock is about to pass: stop, the retry carries on from the lines not yet recorded
    ctx.signal.throwIfAborted();
    const action = line.action as PlanAction;
    const want = wanted.get(refId(line));
    let outcome: Parameters<typeof recordSyncItem>[3];
    try {
      if (action === "delete") {
        await remote.delete(line).catch((e) => {
          if (!isKind(e, "not_found")) throw e;
        });
      } else if (want) {
        await write(remote, action, want);
      } else {
        throw new SyncError("invalid", `${line.key} (${line.scope}) is no longer wanted`);
      }
      outcome = { result: "applied", error: null };
    } catch (e) {
      // the adapter's words name the key and scope, never a value; anything else is only logged
      const message = e instanceof SyncError ? e.message : "unexpected error";
      if (!(e instanceof SyncError)) ctx.log.warn("apply line failed", { error: describeError(e) });
      const again = isKind(e, "failed") && !last;
      if (again) retry++;
      outcome = { result: again ? null : "failed", error: message };
    }
    await recordSyncItem(db, run.id, line.position, outcome);
  }
  return retry;
}

/** Ends the run, and says so in the audit log as the job. */
async function end(
  db: Db,
  ctx: JobContext,
  run: SyncRun,
  target: SyncTarget,
  failure: string | undefined,
) {
  const lines = await listSyncRunItems(db, run.id);
  const applied = lines.filter((l) => l.result === "applied").length;
  const failed = lines.filter((l) => l.result === "failed").length;
  const error =
    failure ?? (failed > 0 ? `${failed} of ${applied + failed} changes failed` : undefined);
  const status = error === undefined ? "applied" : "failed";
  await db.transaction(async (tx) => {
    if (!(await finishSyncRun(tx, run.id, { status, error }))) return;
    await audit(
      tx,
      { actor: { kind: "job", id: ctx.id } },
      {
        action: `sync_run.${status}`,
        resourceType: "sync_run",
        resourceId: run.id,
        organizationId: run.organizationId,
        projectId: run.projectId,
        metadata: { targetId: run.targetId, name: target.name, applied, failed },
      },
    );
  });
  ctx.log.info("apply finished", { run: run.id, status, applied, failed });
}

/**
 * The `sync.apply` job (SYNC-6): writes an approved plan to its target. The queue delivers at least
 * once, so a run that is no longer `applying` is left alone, and a line is written so that doing it
 * twice is the same as once. Needs the master keys of its own: the connection token and the secrets
 * it writes are opened here, in this process, and never queued.
 */
export const syncApplyHandler =
  (deps: {
    db: Db;
    keys: KeyProvider;
    logger: Logger;
    cloud?: CloudDeps | undefined;
  }): JobHandler =>
  async (ctx) => {
    const ids = payloadSchema.parse(ctx.payload);
    const { db } = deps;
    const run = await getSyncRun(db, ids.organizationId, ids.projectId, ids.targetId, ids.runId);
    if (run?.status !== "applying") return;
    const target = await getSyncTarget(db, ids.organizationId, ids.projectId, ids.targetId);
    if (!target) return;

    let retry: number;
    try {
      retry = await applyLines(deps, ctx, run, target);
    } catch (e) {
      const why = fatal(e);
      // not ours to settle: let the queue try again, until it has no tries left
      if (why === undefined && ctx.attempt < ctx.maxAttempts) throw e;
      if (why === undefined) ctx.log.error("apply failed", { error: describeError(e) });
      await end(db, ctx, run, target, why ?? "The apply could not be completed");
      return;
    }
    if (retry > 0) throw new Error(`${retry} change(s) not answered, will retry`);
    await end(db, ctx, run, target, undefined);
  };
