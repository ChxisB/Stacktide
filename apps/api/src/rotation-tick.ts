import type { Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  audit,
  claimDue,
  type Db,
  describeError,
  dueRevocations,
  failRotation,
  notifyRotationFailing,
  type Rotation,
  rotationSubject,
} from "@orch/db";
import { RotationError, type Rotator } from "@orch/rotation";
import { revokePrevious, rotateVariable } from "./rotate";
import type { JobHandler } from "./worker";

/** Rotations taken per claim, and claims per run: a backlog is worked off over several ticks. */
export const ROTATION_BATCH = 10;
export const ROTATION_ROUNDS = 10;
/** The wait after a failed attempt doubles from the base up to the cap (10 minutes, 12 hours). */
export const BACKOFF_BASE_MS = 600_000;
export const BACKOFF_CAP_MS = 43_200_000;
/** Failures in a row before a rotation is `failing` and its project is told. */
export const FAILING_AFTER = 3;

const backoffMs = (failures: number) => Math.min(BACKOFF_BASE_MS * 2 ** failures, BACKOFF_CAP_MS);

export interface RotationTickDeps {
  db: Db;
  keys: KeyProvider;
  rotators: ReadonlyMap<string, Rotator>;
  logger: Logger;
  batch?: number;
  rounds?: number;
  /** Test seam. Left out, the database clock decides what is due. */
  now?: () => Date;
}

/**
 * The `rotation.tick` schedule's job (ROT-4): first revokes the credentials that rotations replaced and
 * whose grace has run out, then rotates what is due. (Leases past their expiry are the `lease.sweep`
 * job's.) A revoke that fails stays recorded and is
 * tried again next tick. A rotation that fails keeps its old value and waits 10 minutes, then twice
 * as long each time up to 12 hours; its third failure in a row marks it `failing`, audits that and
 * tells the sinks the project subscribed (the organization's own variables have no project to tell:
 * the audit event, which GOV-4 forwards, is their signal). The row and the news carry a short code,
 * never a provider's text. One rotation failing never stops the others.
 */
export const rotationTickHandler =
  (deps: RotationTickDeps): JobHandler =>
  async (ctx) => {
    const { db, logger } = deps;
    const { batch = ROTATION_BATCH, rounds = ROTATION_ROUNDS } = deps;
    const now = deps.now?.();
    const when = now ?? new Date();
    const clock = now && { now };
    const rotateDeps = { db, keys: deps.keys, rotators: deps.rotators, logger };
    const counts = { revoked: 0, rotated: 0, waiting: 0, skipped: 0, failed: 0 };

    for (const due of await dueRevocations(db, { ...clock, limit: batch * rounds })) {
      if (ctx.signal.aborted) break;
      try {
        await revokePrevious(rotateDeps, due);
        counts.revoked += 1;
      } catch (error) {
        logger.error("rotation could not revoke a replaced credential", {
          rotation: due.id,
          handle: due.previousHandle,
          error: describeError(error),
        });
      }
    }

    // shortcut: a run aborted between claims leaves what it claimed unrotated until the lease (15 minutes) runs out
    for (let round = 0; round < rounds && !ctx.signal.aborted; round++) {
      const claimed = await claimDue(db, { ...clock, limit: batch });
      for (const rotation of claimed) {
        if (ctx.signal.aborted) break;
        try {
          const done = await rotateVariable(rotateDeps, rotation, { ...clock });
          counts[done.result] += 1;
        } catch (error) {
          counts.failed += 1;
          await recordFailure(deps, rotation, error, when);
        }
      }
      if (claimed.length < batch) break;
    }
    if (Object.values(counts).some((c) => c > 0)) ctx.log.info("rotation tick", counts);
  };

/**
 * Counts the failure, backs off, and on the one that makes it `failing` audits it and tells the
 * project. A person's "rotate now" that fails is counted the same way.
 */
export async function recordFailure(
  deps: Pick<RotationTickDeps, "db" | "logger">,
  rotation: Rotation,
  error: unknown,
  at: Date,
) {
  const { db, logger } = deps;
  const code = error instanceof RotationError ? error.kind : "internal";
  logger.error("rotation failed", { rotation: rotation.id, code, error: describeError(error) });
  const failures = rotation.attempts + 1;
  try {
    // Counted on its own: an alert that cannot be made must not undo the count and the backoff.
    const kept = await failRotation(db, rotation, {
      code,
      retryAt: new Date(at.getTime() + backoffMs(rotation.attempts)),
      failing: failures >= FAILING_AFTER,
      now: at,
    });
    // the claim was lost, this failure does not cross the line, or the project was told already
    if (!kept || failures < FAILING_AFTER || rotation.lastStatus === "failing") return;
    const subject = await rotationSubject(db, rotation.organizationId, rotation.variableId);
    if (!subject) return;
    await db.transaction(async (tx) => {
      await audit(
        tx,
        { actor: { kind: "system", id: "rotation-tick" } },
        {
          action: "variable.rotate_failing",
          resourceType: "variable",
          resourceId: rotation.variableId,
          organizationId: rotation.organizationId,
          ...(subject.projectId && { projectId: subject.projectId }),
          metadata: { provider: rotation.provider, key: subject.key, attempts: failures, code },
        },
      );
      if (subject.projectId) {
        await notifyRotationFailing(tx, {
          organizationId: rotation.organizationId,
          projectId: subject.projectId,
          key: subject.key,
          provider: rotation.provider,
          attempts: failures,
          at,
        });
      }
    });
  } catch (e) {
    // shortcut: a failure counted but not announced is not announced later (the rotation still reads `failing`); upgrade with an outbox
    logger.error("rotation could not record its failure or tell of it", {
      rotation: rotation.id,
      error: describeError(e),
    });
  }
}
