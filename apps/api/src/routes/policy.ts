import { DomainError } from "@orch/core";
import {
  createPolicySet,
  deletePolicySet,
  getOrganization,
  getPolicySet,
  listPolicySets,
  MAX_POLICY_SETS,
  type PolicySetRow,
} from "@orch/db";
import { type PolicySet, policySetProblems } from "@orch/iac";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import {
  deleteResponses,
  iso,
  mapDbError,
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

const setSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  name: z.string(),
  source: z.string(),
  ref: z.string(),
  path: z.string(),
  tag: z.string(),
  ...stamps,
});
const dto = (s: PolicySetRow): z.infer<typeof setSchema> => ({
  id: s.id,
  organizationId: s.organizationId,
  name: s.name,
  source: s.source,
  ref: s.ref,
  path: s.path,
  tag: s.tag,
  createdAt: iso(s.createdAt),
  updatedAt: iso(s.updatedAt),
});

// What the generated job does with a set is decided by the generator's own check of it (one place),
// so a set that is stored is a set that can be used: the refusal says what is wrong, not what it was.
const create = z
  .strictObject({
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, "not a usable name"),
    /** The GitLab project that holds the policies: `group/project`. */
    source: z.string().trim().max(2000),
    /** A branch, tag or commit of it; a commit or protected tag cannot move under the plans it judged. */
    ref: z.string().trim().max(100),
    /** The directory of the policies in it; `.` for the root. */
    path: z.string().trim().max(200).default("."),
    /** The stack tag the set is attached to. */
    tag: z.string().trim().max(32),
  })
  .superRefine((s: PolicySet, ctx) => {
    for (const message of policySetProblems(s)) ctx.addIssue({ code: "custom", message });
  });

const orgParams = z.object({ orgId: z.uuid() });
const setParams = orgParams.extend({ setId: z.uuid() });

const audited = (action: string, s: PolicySetRow) => ({
  action,
  resourceType: "policy_set",
  resourceId: s.id,
  organizationId: s.organizationId,
  // the set's address is public to the organization's admins; there is nothing in it to keep out of the trail
  metadata: { name: s.name, source: s.source, ref: s.ref, path: s.path, tag: s.tag },
});

/**
 * An organization's policy sets (POL-3): which repository of Rego policies judges the plans of the
 * stacks with a tag. They live with the organization and not in a stack's repository, so a merge
 * request cannot change what a set says. Which stacks carry the tag is still the repository's
 * (`stack.yml`): an author can drop the tag for the plan of their own branch (see docs/iac.md).
 * Anyone in the organization reads them; org admins make and remove them.
 */
export const policySetRoutes = ({ db, principal }: RouteDeps) =>
  new Elysia({ prefix: "/organizations/:orgId/policy-sets" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId }, query }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (s: PolicySetRow) => [s.id],
          fetch: (after, limit) => listPolicySets(db, orgId, { after: after?.[0], limit }),
          dto,
        });
      },
      {
        params: orgParams,
        query: pageQuery,
        response: { 200: pageOf(setSchema), ...readErrors },
        guard: "policy.set.read",
      },
    )
    .post(
      "",
      async ({ params: { orgId }, body, audit, set }) => {
        if (!(await getOrganization(db, orgId))) throw notFound("Organization");
        const made = await db
          .transaction(async (tx) => {
            const made = await createPolicySet(tx, { ...body, organizationId: orgId });
            if (!made) {
              throw new DomainError(
                "too_many_policy_sets",
                409,
                `An organization has at most ${MAX_POLICY_SETS} policy sets`,
              );
            }
            await audit(tx, audited("policy.set.create", made));
            return made;
          })
          .catch(
            mapDbError({
              policy_sets_org_name_key: taken("name_taken", "The name"),
              policy_sets_organization_id_organizations_id_fk: notFound("Organization"),
            }),
          );
        set.status = 201;
        return dto(made);
      },
      {
        params: orgParams,
        body: create,
        parse: "json",
        response: { 201: setSchema, ...writeErrors },
        audit: "policy.set.create",
        guard: "policy.set.create",
      },
    )
    .delete(
      "/:setId",
      async ({ params: { orgId, setId }, audit, set }) => {
        await db.transaction(async (tx) => {
          const found = await getPolicySet(tx, orgId, setId);
          if (!found || !(await deletePolicySet(tx, orgId, setId))) {
            throw notFound("Policy set");
          }
          await audit(tx, audited("policy.set.delete", found));
        });
        set.status = 204;
      },
      {
        params: setParams,
        response: deleteResponses,
        audit: "policy.set.delete",
        guard: "policy.set.delete",
      },
    );
