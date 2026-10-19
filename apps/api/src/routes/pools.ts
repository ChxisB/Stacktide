import { DomainError, MAX_POOL_TAGS, MAX_POOLS, POOL_IMAGE, POOL_NAME, POOL_TAG } from "@orch/core";
import {
  createPool,
  deletePool,
  getOrganization,
  getPool,
  listPools,
  updatePool,
  type WorkerPool,
} from "@orch/db";
import { isImageReference } from "@orch/iac";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import {
  atLeastOne,
  deleteResponses,
  iso,
  mapDbError,
  nonEmpty,
  notFound,
  paged,
  pageOf,
  pageQuery,
  type RouteDeps,
  readErrors,
  stamps,
  taken,
  writeErrors,
} from "./shared";

const poolSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  name: z.string(),
  tags: z.array(z.string()),
  image: z.string().nullable(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  ...stamps,
});
const dto = (p: WorkerPool): z.infer<typeof poolSchema> => ({
  id: p.id,
  organizationId: p.organizationId,
  name: p.name,
  tags: p.tags,
  image: p.image,
  enabled: p.enabled,
  isDefault: p.isDefault,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
});

// The messages name the field and never repeat what was sent.
const tags = z
  .array(z.string().regex(POOL_TAG, "not a usable runner tag"))
  .min(1)
  .max(MAX_POOL_TAGS)
  .refine((all) => new Set(all).size === all.length, "a tag is given twice");
// the table's check is the loose one; this is what the generator writes into a job (a pool it refuses stops every stack on it)
const image = z
  .string()
  .regex(POOL_IMAGE, "not a usable image reference")
  .refine(isImageReference, "not a usable image reference");

const createBody = z.strictObject({
  name: z
    .string()
    .max(63)
    .regex(POOL_NAME, "lower-case letters and digits, separated by single dashes"),
  /** The runner tags every job of a stack on this pool asks for. They route a job; they do not isolate it. */
  tags,
  /** The image the stack's jobs run in; none: the one the generator picks. */
  image: image.nullish(),
  enabled: z.boolean().optional(),
  /** The pool for stacks that name none. At most one; making another one the default takes it. */
  isDefault: z.boolean().optional(),
});
/** The name is the pool's identity in `stack.yml`, so it is not changed. */
const patchBody = z
  .strictObject({
    tags: tags.optional(),
    image: image.nullable().optional(),
    enabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine(nonEmpty, atLeastOne);

const orgParams = z.object({ orgId: z.uuid() });
const poolParams = orgParams.extend({ poolId: z.uuid() });

const figures = (p: WorkerPool) => ({
  name: p.name,
  tags: p.tags,
  image: p.image,
  enabled: p.enabled,
  isDefault: p.isDefault,
});
const audited = (action: string, p: WorkerPool, extra: object = {}) => ({
  action,
  resourceType: "worker_pool",
  resourceId: p.id,
  organizationId: p.organizationId,
  // names, tags and an image reference without credentials (the schema refuses an `@` that is not a digest)
  metadata: { ...figures(p), ...extra },
});

const mustBeEnabled = () =>
  new DomainError(
    "pool_default_must_be_enabled",
    409,
    "The default pool must be enabled, and a disabled pool cannot be the default",
  );
const tooMany = () =>
  new DomainError("too_many_pools", 409, `An organization has at most ${MAX_POOLS} pools`);
const known = {
  worker_pools_org_name_key: taken("pool_name_taken", "A pool name"),
  worker_pools_default_enabled_check: mustBeEnabled(),
  worker_pools_organization_id_organizations_id_fk: notFound("Organization"),
};

/**
 * An organization's worker pools (POOL-1): the runner tags (and image) a stack's generated jobs ask for,
 * so a stack can run on the organization's own runners. They live with the organization, not in a stack's
 * repository, so a merge request can name only a pool the organization made (it can still pick among them: GitLab
 * alone decides which runners a project may use). Anyone in the
 * organization reads them; org admins manage them. Tags are routing, not isolation.
 */
export const poolRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/pools" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId }, query }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (p: WorkerPool) => [p.id],
          fetch: (after, limit) => listPools(db, orgId, { after: after?.[0], limit }),
          dto,
        });
      },
      {
        params: orgParams,
        query: pageQuery,
        response: { 200: pageOf(poolSchema), ...readErrors },
        guard: "pool.read",
      },
    )
    .get(
      "/:poolId",
      async ({ params: { orgId, poolId } }) => {
        const pool = await getPool(db, orgId, poolId);
        if (!pool) throw notFound("Pool");
        return dto(pool);
      },
      {
        params: poolParams,
        response: { 200: poolSchema, ...readErrors },
        guard: "pool.read",
      },
    )
    .post(
      "",
      async ({ params: { orgId }, body, audit, set }) => {
        const pool = await db
          .transaction(async (tx) => {
            const made = await createPool(tx, { organizationId: orgId, ...body });
            if (!made) throw tooMany();
            await audit(tx, audited("pool.create", made));
            return made;
          })
          .catch(mapDbError(known));
        set.status = 201;
        return dto(pool);
      },
      {
        params: orgParams,
        body: createBody,
        parse: "json",
        response: { 201: poolSchema, ...writeErrors },
        audit: "pool.create",
        guard: "pool.create",
      },
    )
    .patch(
      "/:poolId",
      async ({ params: { orgId, poolId }, body, audit }) => {
        const done = await db
          .transaction(async (tx) => {
            const changed = await updatePool(tx, orgId, poolId, body);
            if (!changed) throw notFound("Pool");
            await audit(
              tx,
              audited("pool.update", changed.row, {
                previous: figures(changed.previous),
                ...(changed.demoted
                  ? { demoted: { id: changed.demoted.id, name: changed.demoted.name } }
                  : {}),
              }),
            );
            return changed;
          })
          .catch(mapDbError(known));
        return dto(done.row);
      },
      {
        params: poolParams,
        body: patchBody,
        parse: "json",
        response: { 200: poolSchema, ...writeErrors },
        audit: "pool.update",
        guard: "pool.update",
      },
    )
    .delete(
      "/:poolId",
      async ({ params: { orgId, poolId }, audit, set }) => {
        await db.transaction(async (tx) => {
          const gone = await deletePool(tx, orgId, poolId);
          if (!gone) throw notFound("Pool");
          if (gone.result === "default") {
            throw new DomainError(
              "pool_is_default",
              409,
              "The default pool cannot be removed: make another pool the default, or clear it, first",
            );
          }
          await audit(tx, audited("pool.delete", gone.row));
        });
        set.status = 204;
      },
      {
        params: poolParams,
        response: deleteResponses,
        audit: "pool.delete",
        guard: "pool.delete",
      },
    );
