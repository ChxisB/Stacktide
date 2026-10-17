import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  claimSyncRun,
  createSyncRun,
  enqueue,
  failStuckApplies,
  getSyncRun,
  getSyncTarget,
  listSyncRunItems,
  type SyncRun,
} from "@orch/db";
import {
  type ItemInput,
  type PlanAction,
  plan,
  type SyncAdapter,
  SyncError,
  type UnmanagedPolicy,
} from "@orch/sync";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys } from "../connections";
import { guardPlugin } from "../guard";
import { SYNC_APPLY } from "../sync-apply";
import { type Desired, desiredSnapshot, openTarget, untouchable } from "../sync-plan";
import {
  iso,
  mapDbError,
  notFound,
  type RouteDeps,
  readErrors,
  stamps,
  writeErrors,
} from "./shared";
import { failing } from "./variables";

/** How long a plan can be applied for: long enough to read it, short enough that it is still true. */
const PLAN_TTL_MS = 15 * 60_000;
const ACTIONS = ["create", "update", "delete", "noop", "adopt"] as const;
const STATUSES = ["planned", "applying", "applied", "failed"] as const;
/** The plan_invalid message names this many items, then counts the rest. */
const MAX_NAMED = 10;

const itemSchema = z.object({
  key: z.string(),
  scope: z.string(),
  action: z.enum(ACTIONS),
  /** Which fields differ, by name: `value`, `secret`, `file`. */
  changed: z.array(z.string()),
  /** What an apply did to this line; empty before it, for a line with nothing to do, and for one still being retried (its `error` then says why the last try failed). */
  result: z.enum(["applied", "failed"]).nullable(),
  /** Why it failed, in the target's words with no value in them; empty unless it did. */
  error: z.string().nullable(),
});
const runSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  targetId: z.uuid(),
  status: z.enum(STATUSES),
  /** Why the apply failed as a whole; empty unless it did. */
  error: z.string().nullable(),
  /** After this the plan cannot be applied: plan again. */
  expiresAt: z.iso.datetime(),
  counts: z.record(z.enum(ACTIONS), z.number().int()),
  /** What the plan left alone: keys that could not be resolved, and mapped environments that are gone. */
  skipped: z.object({
    unresolved: z.array(z.object({ key: z.string(), scope: z.string(), code: z.string() })),
    missingEnvironments: z.array(z.string()),
  }),
  items: z.array(itemSchema),
  ...stamps,
});

type Line = {
  key: string;
  scope: string;
  action: string;
  changed: string[];
  result?: string | null;
  error?: string | null;
};

const runDto = (run: SyncRun, items: Line[]): z.infer<typeof runSchema> => ({
  id: run.id,
  organizationId: run.organizationId,
  projectId: run.projectId,
  targetId: run.targetId,
  status: run.status as (typeof STATUSES)[number],
  error: run.error,
  expiresAt: iso(run.expiresAt),
  counts: run.counts as z.infer<typeof runSchema>["counts"],
  skipped: run.skipped as z.infer<typeof runSchema>["skipped"],
  items: items.map((i) => ({
    key: i.key,
    scope: i.scope,
    action: i.action as PlanAction,
    changed: i.changed,
    result: (i.result ?? null) as "applied" | "failed" | null,
    error: i.error ?? null,
  })),
  createdAt: iso(run.createdAt),
  updatedAt: iso(run.updatedAt),
});

const params = z.object({ orgId: z.uuid(), projectId: z.uuid(), targetId: z.uuid() });
const runParams = params.extend({ runId: z.uuid() });
const sealed = { 500: z.any(), 502: z.any(), 503: z.any() } as const;
const planned = { 201: runSchema, ...writeErrors, ...sealed } as const;
const applying = { 202: runSchema, ...writeErrors, ...sealed } as const;
const conflict = (code: string, message: string) => new DomainError(code, 409, message);

/** What the target's own words amount to. They name keys and scopes, never a value (the adapter has already put GitLab's failures into its own words). */
const targetError = (e: unknown) => {
  if (!(e instanceof SyncError)) return e;
  return e.kind === "failed"
    ? new DomainError("target_failed", 502, e.message)
    : new DomainError("plan_invalid", 422, e.message);
};

/** Every wanted item the target can never hold, named, so one plan shows all of them at once. */
function refuse(adapter: Pick<SyncAdapter<unknown>, "check">, items: ItemInput[]) {
  const refused: string[] = [];
  for (const item of items) {
    try {
      adapter.check(item);
    } catch (e) {
      if (!(e instanceof SyncError)) throw e;
      refused.push(e.message);
    }
  }
  if (refused.length === 0) return;
  const more = refused.length - MAX_NAMED;
  const named = refused.slice(0, MAX_NAMED).join("; ");
  throw new DomainError(
    "plan_invalid",
    422,
    `The target cannot hold ${refused.length} variable(s), nothing was planned: ${named}${more > 0 ? `; and ${more} more` : ""}`,
  );
}

/**
 * Plans a sync (SYNC-5): what the project's variables would change on a target, stored so that an
 * apply can name it. Nothing is written to the target. A plan holds keys, scopes and actions, never
 * a value. Planning opens every secret of the project and reads the target with the connection's
 * token, so it takes the people who may reveal secrets (`sync.plan`); reading a stored plan does not.
 *
 * Applying (SYNC-6) is by plan id only: a plan that is still `planned`, not expired and still true of
 * the variables is claimed (one apply at a time per target) and handed to the `sync.apply` job,
 * which writes to the target and records what happened to each line.
 */
export const syncRunRoutes = ({
  db,
  principal,
  keys,
  logger,
}: RouteDeps & { keys?: KeyProvider; logger: Logger }) =>
  new Elysia({
    prefix: "/organizations/:orgId/projects/:projectId/sync-targets/:targetId",
  })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .post(
      "/plan",
      async ({ params: { orgId, projectId, targetId }, audit, set }) => {
        if (!keys) throw noKeys();
        const requestId = set.headers["x-request-id"];
        const target = await getSyncTarget(db, orgId, projectId, targetId);
        if (!target) throw notFound("Sync target");

        const adapter = await openTarget({ db, keys, logger }, target, requestId);
        let desired: Desired;
        let items: ReturnType<typeof plan>;
        try {
          // before any secret is opened: a target that cannot be planned costs nothing
          const config = adapter.validate(target.config);
          desired = await desiredSnapshot(db, keys, target).catch(failing(logger)(set));
          refuse(adapter, desired.items);
          const skip = untouchable(desired);
          const actual = (await adapter.connect(config).read()).filter((i) => !skip(i));
          items = plan(desired.items, actual, {
            unmanaged: target.unmanagedPolicy as UnmanagedPolicy,
          });
        } catch (e) {
          throw targetError(e);
        }

        const counts = Object.fromEntries(ACTIONS.map((a) => [a, 0])) as Record<PlanAction, number>;
        for (const item of items) counts[item.action]++;
        const run = await db.transaction(async (tx) => {
          const run = await createSyncRun(
            tx,
            {
              organizationId: orgId,
              projectId,
              targetId,
              expiresAt: new Date(Date.now() + PLAN_TTL_MS),
              desiredDigest: desired.digest,
              counts,
              skipped: {
                unresolved: desired.unresolved,
                missingEnvironments: desired.missingEnvironments,
              },
            },
            items,
          );
          await audit(tx, {
            action: "sync_run.plan",
            resourceType: "sync_run",
            resourceId: run.id,
            organizationId: orgId,
            projectId,
            metadata: { targetId, name: target.name, counts },
          });
          return run;
        });
        set.status = 201;
        return runDto(run, items);
      },
      {
        params,
        response: planned,
        audit: "sync_run.plan",
        guard: "sync.plan",
      },
    )
    .post(
      "/apply",
      async ({ params: { orgId, projectId, targetId }, body, audit, set }) => {
        if (!keys) throw noKeys();
        const target = await getSyncTarget(db, orgId, projectId, targetId);
        if (!target) throw notFound("Sync target");
        const run = await getSyncRun(db, orgId, projectId, targetId, body.planId);
        if (!run) throw notFound("Plan");
        if (run.status !== "planned") {
          throw conflict(
            "plan_not_applicable",
            "This plan was already applied or is being applied",
          );
        }
        if (run.expiresAt.getTime() <= Date.now()) {
          throw conflict("plan_expired", "This plan has expired: plan again");
        }
        const desired = await desiredSnapshot(db, keys, target).catch(failing(logger)(set));
        if (desired.digest !== run.desiredDigest) {
          throw conflict(
            "plan_stale",
            "The variables or the target's settings changed: plan again",
          );
        }

        const claimed = await db
          .transaction(async (tx) => {
            // an apply that cannot finish must not block the target for good
            for (const id of await failStuckApplies(tx, orgId, projectId, targetId)) {
              await audit(tx, {
                action: "sync_run.failed",
                resourceType: "sync_run",
                resourceId: id,
                organizationId: orgId,
                projectId,
                metadata: { targetId, name: target.name, reason: "stuck" },
              });
            }
            const job = await enqueue(tx, {
              queue: SYNC_APPLY,
              payload: { organizationId: orgId, projectId, targetId, runId: run.id },
            });
            // the database's clock decides expiry and the one-at-a-time rule
            const claimed = await claimSyncRun(tx, orgId, projectId, targetId, run.id, job.id);
            if (!claimed) {
              throw conflict(
                "plan_not_applicable",
                "This plan can no longer be applied: plan again",
              );
            }
            await audit(tx, {
              action: "sync_run.apply",
              resourceType: "sync_run",
              resourceId: run.id,
              organizationId: orgId,
              projectId,
              metadata: { targetId, name: target.name, counts: run.counts },
            });
            return claimed;
          })
          .catch(
            mapDbError({
              sync_runs_one_applying: conflict(
                "apply_in_progress",
                "Another apply is running on this target",
              ),
            }),
          );
        set.status = 202;
        return runDto(claimed, await listSyncRunItems(db, claimed.id));
      },
      {
        params,
        body: z.strictObject({ planId: z.uuid() }),
        parse: "json",
        response: applying,
        audit: ["sync_run.apply", "sync_run.failed"],
        guard: "sync.apply",
      },
    )
    .get(
      "/runs/:runId",
      async ({ params: { orgId, projectId, targetId, runId } }) => {
        const run = await getSyncRun(db, orgId, projectId, targetId, runId);
        if (!run) throw notFound("Sync run");
        return runDto(run, await listSyncRunItems(db, run.id));
      },
      {
        params: runParams,
        response: { 200: runSchema, ...readErrors },
        guard: "sync.run.read",
      },
    );
