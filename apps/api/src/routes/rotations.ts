import { can, DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  claimOne,
  describeVariable,
  getRotation,
  ROTATION_STATUSES,
  type Rotation,
  removeRotation,
  rotationSubject,
  setRotation,
} from "@orch/db";
import { RotationError, type Rotator } from "@orch/rotation";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { guardPlugin } from "../guard";
import { rateLimitPlugin } from "../rate-limit";
import { type RotateResult, rotateVariable } from "../rotate";
import { recordFailure } from "../rotation-tick";
import { iso, notFound, problemSchema, type RouteDeps, stamps } from "./shared";
import {
  audited,
  environmentLevel,
  itemParams,
  type Level,
  organizationLevel,
  projectLevel,
  reads,
  scopeOf,
  writes,
} from "./variables";

/** What the table allows for a `config` (`variable_rotations_config_check`), checked before it is a 500. */
const MAX_CONFIG = 2000;

const putBody = z
  .strictObject({
    provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, "a lower-case provider name"),
    // Left out: the stored config stays while the provider does, else none.
    config: z
      .record(z.string(), z.unknown())
      .refine((c) => JSON.stringify(c).length <= MAX_CONFIG, `at most ${MAX_CONFIG} characters`)
      .optional(),
    intervalDays: z.number().int().min(1).max(365),
    graceDays: z.number().int().min(0).max(365).default(0),
    enabled: z.boolean().default(true),
  })
  .refine((b) => b.graceDays <= b.intervalDays, "the grace cannot be longer than the interval");

/** What a rotation looks like from outside: never its config, nor the names of credentials at the provider. */
const rotationSchema = z.object({
  variableId: z.uuid(),
  provider: z.string(),
  intervalDays: z.number().int(),
  graceDays: z.number().int(),
  enabled: z.boolean(),
  nextAt: z.iso.datetime(),
  lastAt: z.iso.datetime().nullable(),
  lastStatus: z.enum(ROTATION_STATUSES),
  /** A short code (`failed`, `denied`), never the provider's text. */
  lastError: z.string().nullable(),
  attempts: z.number().int(),
  /** A replaced credential is still valid and will be revoked when its grace ends. */
  revokePending: z.boolean(),
  ...stamps,
});
const dto = (r: Rotation): z.infer<typeof rotationSchema> => ({
  variableId: r.variableId,
  provider: r.provider,
  intervalDays: r.intervalDays,
  graceDays: r.graceDays,
  enabled: r.enabled,
  nextAt: iso(r.nextAt),
  lastAt: r.lastAt && iso(r.lastAt),
  lastStatus: r.lastStatus,
  lastError: r.lastError,
  attempts: r.attempts,
  revokePending: r.previousHandle !== null,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

const ranSchema = z.object({
  result: z.enum(["rotated", "waiting", "skipped"]),
  /** `rotated`: the variable's new version. */
  version: z.number().int().optional(),
  /** `waiting`: the change request that holds the new value (a protected environment). */
  changeRequestId: z.uuid().optional(),
  /** `skipped`: nothing was done, and why. */
  why: z.enum(["variable_gone", "claim_lost", "protection_changed"]).optional(),
});

/** The provider this deployment has by that name, or the 422 that says it has none. */
function providerOf(rotators: ReadonlyMap<string, Rotator>, provider: string) {
  const rotator = rotators.get(provider);
  // the name is a slug the schema checks, but it is still the caller's text: not echoed
  if (!rotator)
    throw new DomainError("unknown_provider", 422, "This deployment has no such provider");
  return rotator;
}

/** The config as the provider reads it, or the 422 that says why not. */
function checked(rotator: Rotator, config: unknown) {
  try {
    return rotator.validate(config) as Record<string, unknown>;
  } catch (e) {
    // a provider's message never carries the config (the conformance suite holds it to that)
    if (e instanceof RotationError) throw new DomainError("invalid_config", 422, e.message);
    throw e;
  }
}

/** The answer to a provider that failed a person's "rotate now": a code, never the provider's text. */
const failedRun = (e: RotationError) =>
  e.kind === "invalid_config"
    ? new DomainError("invalid_config", 422, "The rotation's settings no longer suit its provider")
    : e.kind === "denied"
      ? new DomainError(
          "rotation_denied",
          409,
          "The provider refused: its own credential cannot do this, or the environment cannot wait for approval",
        )
      : new DomainError(
          "rotation_failed",
          502,
          "The provider failed; the current value is still in use",
        );

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * How a secret rotates (ROT-5), at each of the three levels of variables. The config is write-only:
 * answers never carry it, nor what a provider minted. A change that would lose track of a credential
 * still valid at the provider (a new provider or config, or removal, while one awaits its revoke)
 * is refused; switching the rotation off and changing the interval are not.
 */
const levelRotations = <const P extends string>(
  deps: RouteDeps & { keys?: KeyProvider; logger: Logger; rotators: ReadonlyMap<string, Rotator> },
  spec: Level & { prefix: P },
) => {
  const { db, principal, logger, rotators } = deps;
  const { level, actions } = spec;
  return new Elysia({ prefix: spec.prefix })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .use(rateLimitPlugin)
    .get(
      "/:varId/rotation",
      async ({ params: p }) => {
        await spec.parent(db, p);
        if (!(await describeVariable(db, scopeOf(p), p.varId))) throw notFound("Variable");
        const r = await getRotation(db, p.orgId, p.varId);
        if (!r) throw notFound("Rotation");
        return dto(r);
      },
      {
        params: itemParams,
        response: { 200: rotationSchema, ...reads },
        guard: actions.rotationRead,
      },
    )
    .put(
      "/:varId/rotation",
      async ({ params: p, body, audit, principal: caller }) => {
        await spec.parent(db, p);
        const saved = await db.transaction(async (tx) => {
          const v = await describeVariable(tx, scopeOf(p), p.varId);
          if (!v) throw notFound("Variable");
          const rotator = providerOf(rotators, body.provider);
          // An outside provider acts with the organization's connection token on a target the config names
          // (a numeric id can mean any project): as privileged as the connection, so not a maintainer's to set.
          if (
            rotator.external &&
            caller &&
            "subject" in caller &&
            !can(caller.subject, "connection.read", { organizationId: p.orgId })
          ) {
            throw new DomainError("forbidden", 403, "Not allowed: connection.read");
          }
          if (rotator.endsReplaced && body.graceDays > 0) {
            throw new DomainError(
              "grace_unsupported",
              422,
              "This provider ends the old credential itself, so there is no grace period",
            );
          }
          // shortcut: protection is read here and not held; the engine refuses again when it rotates (`denied`)
          const subject = await rotationSubject(tx, p.orgId, p.varId);
          if (subject?.protected && rotator.external) {
            throw new DomainError(
              "rotation_denied",
              409,
              "A protected environment cannot wait for approval of a provider that changes something outside",
            );
          }
          const result = await setRotation(
            tx,
            {
              organizationId: p.orgId,
              variableId: p.varId,
              provider: body.provider,
              config: body.config ?? {},
              intervalDays: body.intervalDays,
              graceDays: body.graceDays,
              enabled: body.enabled,
            },
            (existing) => {
              // Read here, with the variable held: a rotation that moved its own config on (a new
              // token id) is not put back to what it was. Left out means what is stored for the same provider.
              const config = checked(
                rotator,
                body.config ?? (existing?.provider === body.provider ? existing.config : {}),
              );
              const lifetime = rotator.lifetimeDays?.(config);
              if (lifetime !== undefined && body.intervalDays >= lifetime) {
                throw new DomainError(
                  "interval_exceeds_lifetime",
                  422,
                  `The credential lives ${lifetime} days: rotate it more often than that`,
                );
              }
              if (
                existing?.previousHandle &&
                (existing.provider !== body.provider ||
                  !same(sameShape(rotators, existing), config))
              ) {
                throw revokePending();
              }
              return config;
            },
          );
          if ("error" in result) {
            throw result.error === "not_secret"
              ? new DomainError("not_secret", 422, "Only a secret can rotate")
              : notFound("Variable");
          }
          await audit(
            tx,
            audited("variable.rotation.set", level, v, {
              provider: body.provider,
              intervalDays: body.intervalDays,
              graceDays: body.graceDays,
              enabled: body.enabled,
            }),
          );
          return result.row;
        });
        return dto(saved);
      },
      {
        params: itemParams,
        body: putBody,
        parse: "json",
        response: { 200: rotationSchema, ...writes },
        audit: "variable.rotation.set",
        guard: actions.rotationManage,
      },
    )
    .delete(
      "/:varId/rotation",
      async ({ params: p, audit, set }) => {
        await spec.parent(db, p);
        await db.transaction(async (tx) => {
          const v = await describeVariable(tx, scopeOf(p), p.varId);
          if (!v) throw notFound("Variable");
          const removed = await removeRotation(tx, p.orgId, p.varId);
          if (removed === "revoke_pending") throw revokePending();
          if (removed === "none") throw notFound("Rotation");
          await audit(tx, audited("variable.rotation.delete", level, v));
        });
        set.status = 204;
      },
      {
        params: itemParams,
        response: { 204: z.undefined(), ...writes },
        audit: "variable.rotation.delete",
        guard: actions.rotationManage,
      },
    )
    .post(
      "/:varId/rotation/rotate",
      async ({ params: p, audit }) => {
        if (!deps.keys) throw noKeys();
        const keys = deps.keys;
        await spec.parent(db, p);
        const v = await describeVariable(db, scopeOf(p), p.varId);
        if (!v) throw notFound("Variable");
        // Taken like a worker takes a due one, so a worker rotating it too loses its claim and one run finishes.
        const claimed = await claimOne(db, p.orgId, p.varId);
        if (!claimed) throw notFound("Rotation");
        const recorded = (meta: Record<string, unknown>) =>
          db.transaction((tx) => audit(tx, audited("variable.rotation.run", level, v, meta)));

        let done: RotateResult;
        try {
          done = await rotateVariable({ db, keys, rotators, logger }, claimed);
        } catch (error) {
          // counted and backed off as a worker's failure is (and a third in a row tells the project)
          await recordFailure({ db, logger }, claimed, error, new Date());
          const code = error instanceof RotationError ? error.kind : "internal";
          await recorded({ code });
          throw error instanceof RotationError ? failedRun(error) : error;
        }
        await recorded(done);
        return done;
      },
      {
        params: itemParams,
        response: { 200: ranSchema, ...writes, 502: problemSchema },
        audit: "variable.rotation.run",
        guard: actions.rotationRun,
        limit: "rotation_run",
      },
    );
};

const revokePending = () =>
  new DomainError(
    "revoke_pending",
    409,
    "A replaced credential is still valid and awaits its revoke: switch the rotation off, or wait until it is revoked",
  );

/** A stored config as its provider reads it, so it compares with a new one by what it means. */
function sameShape(rotators: ReadonlyMap<string, Rotator>, existing: Rotation) {
  try {
    return rotators.get(existing.provider)?.validate(existing.config);
  } catch {
    return undefined;
  }
}

export const rotationRoutes = (
  deps: RouteDeps & { keys?: KeyProvider; logger: Logger; rotators: ReadonlyMap<string, Rotator> },
) =>
  new Elysia()
    .use(levelRotations(deps, organizationLevel))
    .use(levelRotations(deps, projectLevel))
    .use(levelRotations(deps, environmentLevel));
