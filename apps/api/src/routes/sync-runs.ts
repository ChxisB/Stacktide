import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  getLastSyncRun,
  getSyncRun,
  getSyncTarget,
  listSyncRunItems,
  type SyncRun,
} from "@orch/db";
import type { GuardrailConfig, PlanAction } from "@orch/sync";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { type CloudDeps, noKeys } from "../connections";
import { guardPlugin } from "../guard";
import { startApply } from "../sync-apply";
import { ACTIONS, planTarget, snapshotDigest, storePlan } from "../sync-plan";
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

const STATUSES = ["planned", "applying", "applied", "failed"] as const;
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

/**
 * Plans a sync (SYNC-5): what the project's variables would change on a target, stored so that an
 * apply can name it. Nothing is written to the target. A plan holds keys, scopes and actions, never
 * a value. Planning opens every secret of the project and reads the target with the connection's
 * token, so it takes the people who may reveal secrets (`sync.plan`); reading a stored plan does not.
 *
 * Applying (SYNC-6) is by plan id only: a plan that is still `planned`, not expired and still true of
 * the variables is claimed (one apply at a time per target) and handed to the `sync.apply` job,
 * which writes to the target and records what happened to each line. `last-run` is the newest run
 * that was applied (or is being, or failed), for a screen that shows when the target was last synced.
 */
export const syncRunRoutes = ({
  db,
  principal,
  keys,
  logger,
  guardrails,
  cloud,
}: RouteDeps & {
  keys?: KeyProvider;
  logger: Logger;
  guardrails?: GuardrailConfig | undefined;
  cloud?: CloudDeps | undefined;
}) =>
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

        const planned = await planTarget(
          { db, keys, logger, guardrails, cloud },
          target,
          requestId,
        ).catch(failing(logger)(set));
        const run = await db.transaction(async (tx) => {
          const run = await storePlan(tx, target, planned);
          await audit(tx, {
            action: "sync_run.plan",
            resourceType: "sync_run",
            resourceId: run.id,
            organizationId: orgId,
            projectId,
            metadata: { targetId, name: target.name, counts: run.counts },
          });
          return run;
        });
        set.status = 201;
        return runDto(run, planned.items);
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
        const digest = await snapshotDigest(db, keys, target).catch(failing(logger)(set));
        if (digest !== run.desiredDigest) {
          throw conflict(
            "plan_stale",
            "The variables or the target's settings changed: plan again",
          );
        }

        const claimed = await db
          .transaction((tx) => startApply(tx, run, target, audit))
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
      "/last-run",
      async ({ params: { orgId, projectId, targetId } }) => {
        if (!(await getSyncTarget(db, orgId, projectId, targetId))) throw notFound("Sync target");
        const run = await getLastSyncRun(db, orgId, projectId, targetId);
        return { run: run ? runDto(run, await listSyncRunItems(db, run.id)) : null };
      },
      {
        params,
        response: { 200: z.object({ run: runSchema.nullable() }), ...readErrors },
        guard: "sync.run.read",
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
