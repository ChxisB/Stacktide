import { DomainError } from "@orch/core";
import {
  createSyncTarget,
  deleteSyncTarget,
  type Executor,
  getConnection,
  getProject,
  getSyncDrift,
  getSyncTarget,
  listEnvironments,
  listSyncTargets,
  type SyncTarget,
  updateSyncTarget,
} from "@orch/db";
import { SyncError, TARGET_TYPE_NAMES, TARGET_TYPES, type TargetType } from "@orch/sync";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import {
  atLeastOne,
  deleteResponses,
  iso,
  mapDbError,
  name,
  nonEmpty,
  notFound,
  paged,
  pageOf,
  pageQuery,
  type RouteDeps,
  readErrors,
  slug,
  stamps,
  taken,
  writeErrors,
} from "./shared";

const POLICIES = ["ignore", "adopt", "prune"] as const;
const MAX_MAPPED = 100;

const targetSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  type: z.string(),
  connectionId: z.uuid(),
  /** Which part of the target, as its type defines it. Never a credential: that stays with the connection. */
  config: z.record(z.string(), z.unknown()),
  /** Environment slug -> the target's scope for it. */
  environmentMapping: z.record(z.string(), z.string()),
  unmanagedPolicy: z.enum(POLICIES),
  autoSync: z.boolean(),
  /** Drift is put right by an automatic sync of creates and updates; it never deletes. */
  autoRemediate: z.boolean(),
  ...stamps,
});
const driftSchema = z.object({
  /** `unchecked` until the first drift check has run. */
  status: z.enum(["unchecked", "in_sync", "drifted"]),
  /** How many lines of each action applying a fresh plan would have; empty while unchecked. */
  counts: z.record(z.string(), z.number().int()),
  /** When the last check found this; empty while unchecked. */
  checkedAt: z.iso.datetime().nullable(),
});
const targetDto = (t: SyncTarget): z.infer<typeof targetSchema> => ({
  id: t.id,
  organizationId: t.organizationId,
  projectId: t.projectId,
  name: t.name,
  type: t.type,
  connectionId: t.connectionId,
  config: t.config,
  environmentMapping: t.environmentMapping,
  unmanagedPolicy: t.unmanagedPolicy as (typeof POLICIES)[number],
  autoSync: t.autoSync,
  autoRemediate: t.autoRemediate,
  createdAt: iso(t.createdAt),
  updatedAt: iso(t.updatedAt),
});

// `*` is the scope of everything not tied to an environment; mapping an environment onto it, or two
// environments onto the same text, would make their variables overwrite each other.
// shortcut: exact text only; a wildcard (`prod*`) or a different case can still overlap another scope.
const scope = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((s) => s !== "*", "* is the scope of variables outside any environment");
const mapping = z
  .record(slug, scope)
  .refine((m) => Object.keys(m).length <= MAX_MAPPED, `at most ${MAX_MAPPED} environments`)
  .refine(
    (m) => new Set(Object.values(m)).size === Object.keys(m).length,
    "two environments cannot share a scope",
  );
const policy = z.enum(POLICIES);

// Defaults (ignore, off, no mapping) are the database's, so a PATCH and a POST agree on them.
const create = z.strictObject({
  name,
  type: z.enum(TARGET_TYPE_NAMES),
  connectionId: z.uuid(),
  config: z.record(z.string(), z.unknown()),
  environmentMapping: mapping.optional(),
  unmanagedPolicy: policy.optional(),
  autoSync: z.boolean().optional(),
  autoRemediate: z.boolean().optional(),
});
// The type is fixed for life: another type is another target.
const patch = z
  .strictObject({
    name: name.optional(),
    connectionId: z.uuid().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    environmentMapping: mapping.optional(),
    unmanagedPolicy: policy.optional(),
    autoSync: z.boolean().optional(),
    autoRemediate: z.boolean().optional(),
  })
  .refine(nonEmpty, atLeastOne);

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });
const itemParams = params.extend({ targetId: z.uuid() });

const invalid = (code: string, message: string) => new DomainError(code, 422, message);
const unknownConnection = () =>
  invalid("unknown_connection", "The connection does not exist in this organization");

/** The type's own check; what it says names the shape, never the config that was sent. */
function validConfig(type: TargetType, config: unknown) {
  try {
    return TARGET_TYPES[type].validate(config);
  } catch (e) {
    if (e instanceof SyncError) throw invalid(e.kind, e.message);
    throw e;
  }
}

async function usableConnection(db: Executor, orgId: string, type: TargetType, id: string) {
  const connection = await getConnection(db, orgId, id);
  if (!connection) throw unknownConnection();
  const needs = TARGET_TYPES[type].connection;
  if (connection.type !== needs) {
    throw invalid("connection_type_mismatch", `A ${type} target needs a ${needs} connection`);
  }
}

async function knownEnvironments(
  db: Executor,
  orgId: string,
  projectId: string,
  environmentMapping: Record<string, string>,
) {
  const have = new Set((await listEnvironments(db, orgId, projectId)).map((e) => e.slug));
  const unknown = Object.keys(environmentMapping).filter((s) => !have.has(s));
  if (unknown.length > 0) {
    throw invalid(
      "unknown_environment",
      `No such environment in this project: ${unknown.join(", ")}`,
    );
  }
}

const audited = (action: string, t: SyncTarget, metadata: Record<string, unknown>) => ({
  action,
  resourceType: "sync_target",
  resourceId: t.id,
  organizationId: t.organizationId,
  projectId: t.projectId,
  metadata: { name: t.name, ...metadata },
});

const onWrite = mapDbError({
  sync_targets_project_name_key: taken("name_taken", "The name"),
  // The composite keys: no such connection in this organization, no such project in it.
  sync_targets_connection_org_fk: unknownConnection(),
  sync_targets_project_org_fk: notFound("Project"),
});

/**
 * Where a project's variables are synced to (SYNC-4): configuration only, no values and no
 * credential (the connection holds that, and it never leaves it). Anyone who can read the project
 * can see its targets; changing one aims the organization's connection at something, so that takes
 * an org admin.
 */
export const syncTargetRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/sync-targets" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId, projectId }, query }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (t): [string] => [t.id],
          fetch: (after, limit) =>
            listSyncTargets(db, orgId, projectId, { after: after?.[0], limit }),
          dto: targetDto,
        });
      },
      {
        params,
        query: pageQuery,
        response: { 200: pageOf(targetSchema), ...readErrors },
        guard: "sync.target.read",
      },
    )
    .get(
      "/:targetId",
      async ({ params: { orgId, projectId, targetId } }) => {
        const target = await getSyncTarget(db, orgId, projectId, targetId);
        if (!target) throw notFound("Sync target");
        return targetDto(target);
      },
      {
        params: itemParams,
        response: { 200: targetSchema, ...readErrors },
        guard: "sync.target.read",
      },
    )
    .get(
      "/:targetId/drift",
      async ({ params: { orgId, projectId, targetId } }) => {
        if (!(await getSyncTarget(db, orgId, projectId, targetId))) throw notFound("Sync target");
        const drift = await getSyncDrift(db, orgId, projectId, targetId);
        return {
          status: (drift?.status ?? "unchecked") as z.infer<typeof driftSchema>["status"],
          counts: drift?.counts ?? {},
          checkedAt: drift ? iso(drift.updatedAt) : null,
        };
      },
      {
        params: itemParams,
        response: { 200: driftSchema, ...readErrors },
        guard: "sync.target.read",
      },
    )
    .post(
      "",
      async ({ params: { orgId, projectId }, body, audit, set }) => {
        const target = await db
          .transaction(async (tx) => {
            if (!(await getProject(tx, orgId, projectId))) throw notFound("Project");
            const config = validConfig(body.type, body.config);
            await usableConnection(tx, orgId, body.type, body.connectionId);
            if (body.environmentMapping) {
              await knownEnvironments(tx, orgId, projectId, body.environmentMapping);
            }
            const target = await createSyncTarget(tx, {
              ...body,
              config,
              organizationId: orgId,
              projectId,
            });
            await audit(
              tx,
              audited("sync_target.create", target, {
                type: target.type,
                connectionId: target.connectionId,
                unmanagedPolicy: target.unmanagedPolicy,
                autoSync: target.autoSync,
                autoRemediate: target.autoRemediate,
              }),
            );
            return target;
          })
          .catch(onWrite);
        set.status = 201;
        return targetDto(target);
      },
      {
        params,
        body: create,
        parse: "json",
        response: { 201: targetSchema, ...writeErrors },
        audit: "sync_target.create",
        guard: "sync.target.create",
      },
    )
    .patch(
      "/:targetId",
      async ({ params: { orgId, projectId, targetId }, body, audit }) => {
        const target = await db
          .transaction(async (tx) => {
            const held = await getSyncTarget(tx, orgId, projectId, targetId);
            if (!held) throw notFound("Sync target");
            const type = held.type as TargetType;
            // Only what is given is checked: an old mapping to a since-deleted environment must not
            // block an unrelated change.
            const config = body.config === undefined ? undefined : validConfig(type, body.config);
            if (body.connectionId !== undefined) {
              await usableConnection(tx, orgId, type, body.connectionId);
            }
            if (body.environmentMapping) {
              await knownEnvironments(tx, orgId, projectId, body.environmentMapping);
            }
            const target = await updateSyncTarget(tx, orgId, projectId, targetId, {
              ...body,
              config,
            });
            if (!target) throw notFound("Sync target");
            await audit(
              tx,
              audited("sync_target.update", target, {
                fields: Object.keys(body),
                ...(body.connectionId && { connectionId: body.connectionId }),
                ...(body.unmanagedPolicy && { unmanagedPolicy: body.unmanagedPolicy }),
                ...(body.autoSync !== undefined && { autoSync: body.autoSync }),
                ...(body.autoRemediate !== undefined && { autoRemediate: body.autoRemediate }),
              }),
            );
            return target;
          })
          .catch(onWrite);
        return targetDto(target);
      },
      {
        params: itemParams,
        body: patch,
        parse: "json",
        response: { 200: targetSchema, ...writeErrors },
        audit: "sync_target.update",
        guard: "sync.target.update",
      },
    )
    .delete(
      "/:targetId",
      async ({ params: { orgId, projectId, targetId }, audit, set }) => {
        await db.transaction(async (tx) => {
          const target = await getSyncTarget(tx, orgId, projectId, targetId);
          if (!target || !(await deleteSyncTarget(tx, orgId, projectId, targetId))) {
            throw notFound("Sync target");
          }
          await audit(tx, audited("sync_target.delete", target, { type: target.type }));
        });
        set.status = 204;
      },
      {
        params: itemParams,
        response: deleteResponses,
        audit: "sync_target.delete",
        guard: "sync.target.delete",
      },
    );
