import { DomainError, type Logger } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  createSyncRun,
  getSyncRun,
  getSyncTarget,
  listSyncRunItems,
  type SyncRun,
  type SyncRunItem,
} from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import {
  gitlabVariablesAdapter,
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
import { noKeys, openGitlabConnection } from "../connections";
import { guardPlugin } from "../guard";
import { type Desired, desiredState, untouchable } from "../sync-plan";
import { iso, notFound, type RouteDeps, readErrors, stamps, writeErrors } from "./shared";
import { failing } from "./variables";

/** How long a plan can be applied for (SYNC-6 enforces it): long enough to read it, short enough that it is still true. */
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
});
const runSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  targetId: z.uuid(),
  status: z.enum(STATUSES),
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

const runDto = (run: SyncRun, items: SyncRunItem[]): z.infer<typeof runSchema> => ({
  id: run.id,
  organizationId: run.organizationId,
  projectId: run.projectId,
  targetId: run.targetId,
  status: run.status as (typeof STATUSES)[number],
  expiresAt: iso(run.expiresAt),
  counts: run.counts as z.infer<typeof runSchema>["counts"],
  skipped: run.skipped as z.infer<typeof runSchema>["skipped"],
  items: items.map((i) => ({ ...i, action: i.action as PlanAction })),
  createdAt: iso(run.createdAt),
  updatedAt: iso(run.updatedAt),
});

const params = z.object({ orgId: z.uuid(), projectId: z.uuid(), targetId: z.uuid() });
const runParams = params.extend({ runId: z.uuid() });
const sealed = { 500: z.any(), 502: z.any(), 503: z.any() } as const;
const planned = { 201: runSchema, ...writeErrors, ...sealed } as const;

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

        const { baseUrl, token } = await openGitlabConnection(
          { db, keys, logger },
          orgId,
          target.connectionId,
          requestId,
        );
        // shortcut: one target type; a registry of builders replaces this when a second one comes
        const adapter = gitlabVariablesAdapter(
          createGitlab({
            baseUrl,
            auth: { type: "private-token", token },
            timeoutMs: 15_000,
            maxRetries: 1,
            maxRetryDelayMs: 2_000,
          }),
        );
        let desired: Desired;
        let items: ReturnType<typeof plan>;
        try {
          // before any secret is opened: a target that cannot be planned costs nothing
          const config = adapter.validate(target.config);
          // one snapshot, so the variables, the lines and the digest are of the same moment
          desired = await db
            .transaction((tx) => desiredState(tx, keys, target), {
              isolationLevel: "repeatable read",
              accessMode: "read only",
            })
            .catch(failing(logger)(set));
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
