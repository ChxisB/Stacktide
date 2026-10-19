import { CHANGE_REQUEST_TTL_DAYS, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  advanceRotation,
  audit,
  clearRevoked,
  completeRotation,
  createChangeRequest,
  type Db,
  describeError,
  getRotation,
  lockEnvironment,
  openRequestBy,
  type Rotation,
  rotationSubject,
  setVariable,
} from "@orch/db";
import { RotationError, type Rotator } from "@orch/rotation";

export interface RotateDeps {
  db: Db;
  /** Seals the value of a request held for approval; the version of an open environment is sealed by `setVariable`. */
  keys: KeyProvider;
  /** The providers this deployment has, by `Rotator.type`. */
  rotators: ReadonlyMap<string, Rotator>;
  logger: Logger;
}

export type RotateResult =
  /** The new value is the variable's current version. */
  | { result: "rotated"; version: number }
  /** A protected environment: the new value waits in this change request and the old one stays live. */
  | { result: "waiting"; changeRequestId: string }
  /**
   * Nothing was done: the variable is gone, another worker holds the rotation now, or the
   * environment was protected after the rotation began (the next attempt asks for approval).
   */
  | { result: "skipped"; why: SkipReason };

type SkipReason = "variable_gone" | "claim_lost" | "protection_changed";

const DAY_MS = 86_400_000;

/** Thrown inside the write to roll it back and say why. */
class Skip extends Error {
  constructor(readonly why: SkipReason) {
    super(why);
  }
}

function providerOf(deps: RotateDeps, rotation: Rotation) {
  const rotator = deps.rotators.get(rotation.provider);
  // the name is a slug the table checks, but it is still the caller's text: it is not echoed
  if (!rotator) throw new RotationError("invalid_config", "this deployment has no such provider");
  return { rotator, config: rotator.validate(rotation.config) };
}

/**
 * Revokes the credential a rotation replaced and forgets it. A failure leaves it recorded, so the
 * next attempt (the sweep, or the next rotation, which starts here) tries again.
 */
export async function revokePrevious(deps: RotateDeps, rotation: Rotation): Promise<void> {
  if (!rotation.previousHandle) return;
  const { rotator, config } = providerOf(deps, rotation);
  await rotator.revoke(config, rotation.previousHandle, {
    organizationId: rotation.organizationId,
  });
  await clearRevoked(deps.db, rotation.id, rotation.previousHandle);
}

/**
 * After a failed write: whether the credential the provider minted must be left alone. Nobody holds its value
 * (it was only in memory), so an unrevoked one that nothing refers to harms nothing, while a revoked one that the
 * variable does use is an outage: when this cannot tell, it keeps.
 */
async function keepMinted(
  deps: RotateDeps,
  claimed: Rotation,
  rotator: Rotator,
  minted: { handle: string | null; config?: unknown },
  error: unknown,
): Promise<boolean> {
  if (minted.handle === null) return false;
  try {
    // The old credential is already dead, so the rotation takes the new one as its own and the next attempt rotates it:
    // revoking it would leave the rotation pointing at a token that no longer exists.
    if (rotator.endsReplaced) {
      return await advanceRotation(deps.db, claimed, {
        handle: minted.handle,
        ...(minted.config !== undefined && { config: minted.config as Record<string, unknown> }),
      });
    }
    // A verdict of ours says it was not kept; any other error may be a commit whose answer was lost.
    if (error instanceof Skip) return false;
    return (
      (await getRotation(deps.db, claimed.organizationId, claimed.variableId))?.handle ===
      minted.handle
    );
  } catch (e) {
    deps.logger.error("rotation could not tell whether it kept the credential it minted", {
      rotation: claimed.id,
      handle: minted.handle,
      error: describeError(e),
    });
    return true;
  }
}

/**
 * Rotates one claimed rotation (`claimDue`): the provider mints a value, which becomes the
 * variable's next version (history, audit, auto-sync as for any edit) and the rotation records
 * its handle, the credential it replaced and when to revoke that. The version, its audit event and
 * the rotation's bookkeeping commit together; if any of them fails the minted credential is revoked
 * and the old value stays live, unless it is not known to be safe to revoke (`keepMinted`): a
 * provider that ended the old credential keeps the new one for the next attempt to rotate, and a
 * write whose outcome is unknown keeps it when the row names it. A provider that fails throws its
 * `RotationError` with nothing changed.
 *
 * A protected environment does not take the value: it is sealed in a change request that the
 * rotation authors, and the old value stays live until a person approves. At most one such request
 * is open per rotation; a later cycle that finds it still open mints nothing. Only a provider that
 * is not `external` can wait: a minted credential would be stranded by a rejected request, and a
 * provider that ends the old one would break the live value before anyone approved.
 */
export async function rotateVariable(
  deps: RotateDeps,
  claimed: Rotation,
  opts: { now?: Date } = {},
): Promise<RotateResult> {
  const { db, keys } = deps;
  const at = opts.now ?? new Date();
  const subject = await rotationSubject(db, claimed.organizationId, claimed.variableId);
  if (!subject) return { result: "skipped", why: "variable_gone" };
  const { rotator, config } = providerOf(deps, claimed);
  const env =
    subject.protected && subject.projectId && subject.environmentId
      ? {
          organizationId: claimed.organizationId,
          projectId: subject.projectId,
          environmentId: subject.environmentId,
        }
      : undefined;
  if (env && rotator.external) {
    throw new RotationError(
      "denied",
      "a protected environment cannot wait for approval of a provider that changes something outside",
    );
  }
  const actor = { kind: "rotation", id: claimed.id };

  if (env) {
    const open = await openRequestBy(db, env, actor);
    if (open) {
      await completeRotation(db, claimed, {
        handle: claimed.handle,
        status: "pending_approval",
        now: at,
      });
      return { result: "waiting", changeRequestId: open };
    }
  }

  // An earlier replaced credential that is still valid ends first: recording a new one would forget it.
  await revokePrevious(deps, claimed);
  const minted = await rotator.rotate({
    config,
    key: subject.key,
    organizationId: claimed.organizationId,
  });
  const replaced = claimed.handle;

  try {
    return await db.transaction(async (tx) => {
      let result: RotateResult;
      if (env) {
        const request = await createChangeRequest(tx, keys, {
          ...env,
          ops: [{ op: "set", key: subject.key, value: minted.value }],
          author: { ...actor, ref: `${actor.kind}:${actor.id}` },
          expiresAt: new Date(at.getTime() + CHANGE_REQUEST_TTL_DAYS * DAY_MS),
        });
        result = { result: "waiting", changeRequestId: request.id };
      } else {
        // As every direct write does: hold the environment so protection cannot be switched on
        // between this check and the write (GOV-2).
        if (subject.projectId && subject.environmentId) {
          const held = await lockEnvironment(
            tx,
            claimed.organizationId,
            subject.projectId,
            subject.environmentId,
            "share",
          );
          if (held?.protected) throw new Skip("protection_changed");
        }
        const written = await setVariable(
          tx,
          keys,
          {
            organizationId: claimed.organizationId,
            projectId: subject.projectId ?? undefined,
            environmentId: subject.environmentId ?? undefined,
          },
          claimed.variableId,
          { value: minted.value, actor, reason: "rotation" },
        );
        if (!written) throw new Skip("variable_gone");
        result = { result: "rotated", version: written.currentVersion };
      }
      await audit(
        tx,
        { actor },
        {
          action: "variable.rotate",
          resourceType: "variable",
          resourceId: claimed.variableId,
          organizationId: claimed.organizationId,
          ...(subject.projectId && { projectId: subject.projectId }),
          metadata: {
            provider: claimed.provider,
            key: subject.key,
            ...(result.result === "rotated"
              ? { version: result.version }
              : { changeRequestId: result.changeRequestId }),
          },
        },
      );
      const kept = await completeRotation(tx, claimed, {
        handle: minted.handle,
        ...(minted.config !== undefined && { config: minted.config as Record<string, unknown> }),
        // a provider that ends the replaced credential itself leaves nothing to revoke later
        ...(replaced &&
          !rotator.endsReplaced && {
            previousHandle: replaced,
            revokeAt: new Date(at.getTime() + claimed.graceDays * DAY_MS),
          }),
        status: result.result === "waiting" ? "pending_approval" : "ok",
        now: at,
      });
      if (!kept) throw new Skip("claim_lost");
      return result;
    });
  } catch (e) {
    if (minted.handle !== null && !(await keepMinted(deps, claimed, rotator, minted, e))) {
      try {
        await rotator.revoke(config, minted.handle, { organizationId: claimed.organizationId });
      } catch (revokeError) {
        // shortcut: only logged; a credential that could not be revoked here needs a person (the handle is the id to revoke)
        deps.logger.error("rotation could not revoke the credential it minted", {
          rotation: claimed.id,
          handle: minted.handle,
          error: describeError(revokeError),
        });
      }
    }
    if (e instanceof Skip) return { result: "skipped", why: e.why };
    throw e;
  }
}
