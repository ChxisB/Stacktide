import {
  DomainError,
  LEASE_SCOPES,
  LEASE_TTL_SECONDS,
  LEASES_PER_PRINCIPAL,
  type Logger,
} from "@orch/core";
import {
  audit,
  type Db,
  describeError,
  dueLeases,
  endLease,
  forgetLease,
  type Lease,
  recordHandle,
  startLease,
  type Tx,
} from "@orch/db";
import type { Leaser } from "@orch/rotation";
import type { JobHandler } from "./worker";

export interface LeaseDeps {
  db: Db;
  leasers: ReadonlyMap<string, Leaser>;
  logger: Logger;
}

/** Writes the audit event of what just happened, in the transaction that records it. */
export type Recorder = (tx: Tx, lease: Lease) => Promise<void>;

const SECOND = 1000;
/** Leases taken per sweep: a backlog is worked off over several ticks. */
export const LEASE_SWEEP_BATCH = 100;

const leaserOf = (deps: LeaseDeps, provider: string) => {
  const leaser = deps.leasers.get(provider);
  if (!leaser) throw new DomainError("unknown_provider", 422, "No such lease provider");
  return leaser;
};
const targetOf = (l: Lease) => ({ connectionId: l.connectionId, projectId: l.remoteProjectId });

export interface IssueInput {
  organizationId: string;
  projectId: string;
  /** GitLab's id for the project, read from the platform project, never from the request. */
  remoteProjectId: number;
  connectionId: string;
  provider: string;
  scopes: readonly string[];
  ttlSeconds?: number | undefined;
  /** `<kind>:<id>`. */
  principal: string;
  now?: Date;
}

/**
 * Issues a lease (ADR-0014): the row first, then the credential, then the handle and the audit event
 * together, so a credential is never made that no row can name. The value is returned here and nowhere
 * else; it is in no row, no audit event and no log. If the provider fails the row is dropped; if
 * recording fails the credential is revoked and the row dropped (a revoke that fails too keeps the row,
 * with the handle, for the sweeper). The one gap: a crash between the
 * provider's answer and the handle leaves a credential nothing can revoke, which ends at its
 * provider's own expiry (a day after the lease at most).
 */
export async function issueLease(deps: LeaseDeps, input: IssueInput, record: Recorder) {
  const { db, logger } = deps;
  const ttl = input.ttlSeconds ?? LEASE_TTL_SECONDS.default;
  if (!Number.isInteger(ttl) || ttl < LEASE_TTL_SECONDS.min || ttl > LEASE_TTL_SECONDS.max) {
    throw new DomainError(
      "invalid_ttl",
      422,
      `A lease lasts from ${LEASE_TTL_SECONDS.min} seconds to ${LEASE_TTL_SECONDS.max} seconds`,
    );
  }
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || scopes.some((s) => !(LEASE_SCOPES as readonly string[]).includes(s))) {
    throw new DomainError("invalid_scope", 422, `A lease takes only ${LEASE_SCOPES.join(", ")}`);
  }
  const leaser = leaserOf(deps, input.provider);
  const at = input.now ?? new Date();
  const expiresAt = new Date(at.getTime() + ttl * SECOND);

  const started = await startLease(db, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    principal: input.principal,
    provider: input.provider,
    connectionId: input.connectionId,
    remoteProjectId: input.remoteProjectId,
    scopes,
    expiresAt,
    ...(input.now && { now: input.now }),
  });
  if ("error" in started) {
    throw new DomainError(
      "too_many_leases",
      429,
      `At most ${LEASES_PER_PRINCIPAL} leases can be live at once; revoke one or wait for one to end`,
    );
  }
  const row = started.lease;
  const target = targetOf(row);

  let made: Awaited<ReturnType<Leaser["issue"]>>;
  try {
    made = await leaser.issue({
      organizationId: input.organizationId,
      target,
      scopes,
      expiresAt,
      name: `orch-lease-${row.id}`,
    });
  } catch (e) {
    await forgetLease(db, row.id);
    throw e;
  }
  try {
    const lease = await db.transaction(async (tx) => {
      if (!(await recordHandle(tx, row.id, made.handle))) throw new Error("the lease was ended");
      const recorded = { ...row, handle: made.handle };
      await record(tx, recorded);
      return recorded;
    });
    return { lease, value: made.value };
  } catch (e) {
    // the handle is not recorded (the transaction rolled back): undo what was made
    const undone = await leaser
      .revoke(target, made.handle, { organizationId: input.organizationId })
      .then(
        () => true,
        (error) => {
          logger.error("lease could not revoke a credential it could not record", {
            lease: row.id,
            handle: made.handle,
            error: describeError(error),
          });
          return false;
        },
      );
    if (undone) await forgetLease(db, row.id).catch(() => undefined);
    // Not undone: the row keeps the handle, so the sweeper ends the credential at the lease's expiry.
    else {
      await recordHandle(db, row.id, made.handle).catch((error) =>
        logger.error("lease could not keep the handle of a credential it could not revoke", {
          lease: row.id,
          handle: made.handle,
          error: describeError(error),
        }),
      );
    }
    throw e;
  }
}

/**
 * Revokes a lease on request: at the provider first, then the row, so a provider that fails leaves a
 * lease that still says it is live. "already" when it had ended (nothing was done now). A lease with
 * no recorded handle cannot be revoked from here: 409.
 */
export async function revokeLease(
  deps: LeaseDeps,
  lease: Lease,
  record: Recorder,
  now?: Date,
): Promise<"revoked" | "already"> {
  if (lease.revokedAt) return "already";
  if (!lease.handle) {
    throw new DomainError(
      "lease_unrevocable",
      409,
      "This lease has no recorded credential to revoke; it ends at its provider's own expiry",
    );
  }
  await leaserOf(deps, lease.provider).revoke(targetOf(lease), lease.handle, {
    organizationId: lease.organizationId,
  });
  return deps.db.transaction(async (tx) => {
    const ended = await endLease(tx, lease.id, now);
    if (!ended) return "already" as const;
    await record(tx, ended);
    return "revoked" as const;
  });
}

/**
 * The sweeper (ROT-10): revokes every lease past its expiry that is still valid and marks it ended,
 * auditing `lease.expire` as `system:lease-sweep`. A provider error leaves the lease for the next tick
 * and never stops the others; running it twice does nothing the second time.
 */
export async function sweepLeases(
  deps: LeaseDeps,
  opts: { now?: Date; limit?: number; signal?: AbortSignal } = {},
) {
  const { db, logger } = deps;
  const counts = { revoked: 0, failed: 0 };
  const due = await dueLeases(db, {
    ...(opts.now && { now: opts.now }),
    limit: opts.limit ?? LEASE_SWEEP_BATCH,
  });
  for (const lease of due) {
    if (opts.signal?.aborted) break;
    try {
      const done = await revokeLease(
        deps,
        lease,
        (tx, ended) =>
          audit(
            tx,
            { actor: { kind: "system", id: "lease-sweep" } },
            {
              action: "lease.expire",
              resourceType: "lease",
              resourceId: ended.id,
              organizationId: ended.organizationId,
              projectId: ended.projectId,
              metadata: { provider: ended.provider, principal: ended.principal },
            },
          ),
        opts.now,
      );
      if (done === "revoked") counts.revoked += 1;
    } catch (error) {
      counts.failed += 1;
      logger.error("lease could not be revoked at expiry", {
        lease: lease.id,
        handle: lease.handle,
        error: describeError(error),
      });
    }
  }
  return counts;
}

/**
 * The `lease.sweep` schedule's job (ROT-10): `sweepLeases` on its own clock, so that switching rotation
 * off does not leave a token alive past its expiry, and a failing sweep cannot hold up a rotation.
 */
export const leaseSweepHandler =
  (deps: LeaseDeps & { now?: () => Date }): JobHandler =>
  async (ctx) => {
    const swept = await sweepLeases(deps, {
      ...(deps.now && { now: deps.now() }),
      signal: ctx.signal,
    });
    if (swept.revoked > 0 || swept.failed > 0) ctx.log.info("lease sweep", swept);
  };
