import {
  BLUEPRINT_CLOUDS,
  BLUEPRINT_KINDS,
  BLUEPRINT_PROFILES,
  type Blueprint,
  BlueprintSchema,
  DomainError,
  type Logger,
  RESOURCE_STATES,
  type ResourceState,
} from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  type AuditEvent,
  type Db,
  getPipelineConfig,
  getProject,
  getResource,
  listResources,
  type ResourceRow,
  resourceStates,
  type Tx,
  upsertResource,
} from "@orch/db";
import { blueprintCatalog } from "@orch/iac";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { guardPlugin } from "../guard";
import { checkResource, proposeResource } from "../resource-propose";
import { forgeOf } from "./pipeline";
import {
  iso,
  mapDbError,
  notFound,
  paged,
  pageOf,
  pageQuery,
  type RouteDeps,
  readErrors,
  stamps,
  writeErrors,
} from "./shared";

const catalogSchema = z.object({
  profiles: z.array(z.enum(BLUEPRINT_PROFILES)),
  kinds: z.array(
    z.object({
      kind: z.enum(BLUEPRINT_KINDS),
      /** The kinds a resource of this kind may name in `uses`. */
      uses: z.array(z.enum(BLUEPRINT_KINDS)),
      clouds: z.array(
        z.object({
          cloud: z.enum(BLUEPRINT_CLOUDS),
          version: z.string(),
          idleCost: z.string(),
        }),
      ),
    }),
  ),
  /** JSON Schema of the closed inputs: one variant for each kind. */
  inputs: z.record(z.string(), z.unknown()),
});

/** What can be asked for: the same for everyone, and none of a module's Terraform. */
export const blueprintRoutes = () =>
  new Elysia({ prefix: "/blueprints" }).use(guardPlugin).get("", () => blueprintCatalog(), {
    response: { 200: catalogSchema, ...readErrors },
    signedIn: "the catalog is the same for everyone: nothing in it belongs to an organization",
  });

const resourceSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid(),
  environment: z.string(),
  kind: z.enum(BLUEPRINT_KINDS),
  cloud: z.enum(BLUEPRINT_CLOUDS),
  name: z.string(),
  /** The stack the resource is, in the project's repository: its state key and the runs that decide `state`. */
  stack: z.string(),
  /** The directory of the stack in the repository. */
  path: z.string(),
  /** The merge or pull request that proposed it; null until one was opened. */
  proposalUrl: z.string().nullable(),
  /** The closed inputs the resource was rendered from. */
  inputs: z.record(z.string(), z.unknown()),
  /** Where the resource is served (a service), from the outputs of its stack's state; null until a plan has seen it applied. */
  url: z.string().nullable(),
  /** Where its cloud's console shows it; null until a plan has seen it applied. */
  consoleUrl: z.string().nullable(),
  state: z.enum(RESOURCE_STATES),
  ...stamps,
});

type Listed = ResourceRow & { state: ResourceState };
const dto = (r: Listed): z.infer<typeof resourceSchema> => ({
  id: r.id,
  organizationId: r.organizationId,
  projectId: r.projectId,
  environment: r.environment,
  kind: r.kind,
  cloud: r.cloud,
  name: r.name,
  stack: r.stack,
  path: r.path,
  proposalUrl: r.proposalUrl,
  inputs: r.inputs,
  url: r.url,
  consoleUrl: r.consoleUrl,
  state: r.state,
  createdAt: iso(r.createdAt),
  updatedAt: iso(r.updatedAt),
});

/** What a proposal answers: the resource as it is now, and what was done to the repository. */
const proposalSchema = resourceSchema.extend({
  /** `opened` a request, `updated` the open one, `unchanged` (nothing to do), `in_place` (the default branch already has these files). */
  outcome: z.enum(["opened", "updated", "unchanged", "in_place"]),
  /** A commit was made on the branch this time. */
  committed: z.boolean(),
  /** Every file of the proposal, the vendored module included; never their text. */
  files: z.array(z.string()),
});
const sealed = { 502: z.any(), 503: z.any() } as const;

const params = z.object({ orgId: z.uuid(), projectId: z.uuid() });
const itemParams = params.extend({ id: z.uuid() });
/** The blueprint is checked by `BlueprintSchema` in the handler, which names each key; here only that it is an object. */
const blueprintBody = z.record(z.string(), z.unknown());

const PAGE = 200;
/** All of a project's resources, which the renderer needs to check what a new one uses. */
async function allResources(db: Db, orgId: string, projectId: string) {
  const all: ResourceRow[] = [];
  for (let after: string | undefined; ; ) {
    const page = await listResources(db, orgId, projectId, { after, limit: PAGE });
    all.push(...page);
    const last = page.at(-1);
    if (page.length < PAGE || !last) return all;
    after = last.id;
  }
}

/** A stored resource as a blueprint again. The row's own columns win over `inputs`, which a writer other than the route could have left short. */
const blueprintOf = (r: ResourceRow): Blueprint | undefined => {
  const parsed = BlueprintSchema.safeParse({
    ...r.inputs,
    environment: r.environment,
    kind: r.kind,
    cloud: r.cloud,
    name: r.name,
  });
  return parsed.success ? parsed.data : undefined;
};

/**
 * A project's resources: what it asked the blueprint catalog for (ADR-0024). The platform records the ask
 * and the merge or pull request that carries it; the cloud is changed by the project's own runners, so
 * `state` is read from the runs of the resource's stack and is never stored.
 */
export const resourceRoutes = ({
  db,
  principal,
  keys,
  logger,
}: RouteDeps & { keys?: KeyProvider; logger: Logger }) => {
  /** What a request needs to hold before the forge is asked: the project, its other resources, and the checked blueprint. */
  const check = async (
    orgId: string,
    projectId: string,
    input: Record<string, unknown>,
    current: ResourceRow | undefined,
  ) => {
    const project = await getProject(db, orgId, projectId);
    if (!project) throw notFound("Project");
    if (!project.gitlabProjectId) {
      throw new DomainError("not_linked", 422, "This project is not linked to a repository");
    }
    const config = await getPipelineConfig(db, orgId, projectId);
    if (!config) {
      throw new DomainError(
        "no_pipeline",
        422,
        "Set up this project's pipeline first: a resource is proposed into its repository and run by its stack pipeline",
      );
    }
    const stored = await allResources(db, orgId, projectId);
    // a row that no longer parses uses nothing and is used by nothing: it cannot be checked against
    const others = stored.flatMap((r) => blueprintOf(r) ?? []);
    const { blueprint: b, stack, path, files } = checkResource(input, others);
    if (current) {
      const moved = (["environment", "kind", "name"] as const).filter((k) => b[k] !== current[k]);
      if (moved.length > 0) {
        throw new DomainError(
          "invalid_resource",
          422,
          `The resource is not valid: ${moved.join(", ")} cannot be changed; ask for a new resource instead`,
          {
            errors: moved.map((path) => ({
              path,
              message: "cannot be changed; ask for a new resource instead",
            })),
          },
        );
      }
    }
    const same = stored.find(
      (r) => r.environment === b.environment && r.kind === b.kind && r.name === b.name,
    );
    const moves = new DomainError(
      "resource_cloud",
      409,
      `${b.kind} ${b.name} is on ${same?.cloud ?? "another cloud"}: a resource does not move between clouds. Ask for a new name and delete this one`,
    );
    if (same && same.cloud !== b.cloud) throw moves;
    return {
      config,
      others,
      b,
      stack,
      path,
      files,
      same,
      moves,
      gitlabProjectId: project.gitlabProjectId,
    };
  };

  /**
   * Asks for a resource: the files go to the project's repository as a merge or pull request (ADR-0024), and
   * the platform records what it asked for. The forge is written first so no transaction waits on it; a re-run
   * after a failure after that finds the same branch and request, changes nothing there, and records.
   */
  const propose = async (
    orgId: string,
    projectId: string,
    input: Record<string, unknown>,
    current: ResourceRow | undefined,
    audit: (tx: Tx, event: AuditEvent) => Promise<void>,
    requestId: unknown,
  ) => {
    const { config, others, b, stack, path, same, moves, gitlabProjectId } = await check(
      orgId,
      projectId,
      input,
      current,
    );
    const api = await forgeOf({ db, keys, logger }, orgId, config.connectionId, requestId);
    const proposed = await proposeResource(api, gitlabProjectId, {
      blueprint: input,
      others,
      verb: current ? "change" : "add",
    });
    const row = await db
      .transaction(async (tx) => {
        const saved = await upsertResource(tx, {
          organizationId: orgId,
          projectId,
          environment: b.environment,
          kind: b.kind,
          cloud: b.cloud,
          name: b.name,
          inputs: b,
          stack,
          path,
          proposalUrl: proposed.mr?.url ?? same?.proposalUrl ?? null,
        });
        if (!saved) throw moves;
        await audit(tx, {
          action: "resource.propose",
          resourceType: "resource",
          resourceId: saved.id,
          organizationId: orgId,
          projectId,
          // what and where; the files' text stays in the repository
          metadata: {
            kind: b.kind,
            cloud: b.cloud,
            name: b.name,
            environment: b.environment,
            outcome: proposed.outcome,
            committed: proposed.committed,
            files: proposed.files,
          },
        });
        return saved;
      })
      .catch(
        mapDbError({
          resources_project_stack_key: new DomainError(
            "stack_taken",
            409,
            `${stack} is already the stack of another resource`,
          ),
        }),
      );
    const state = (await resourceStates(db, orgId, projectId, [row.stack])).get(row.stack);
    return {
      created: !same,
      body: {
        ...dto({ ...row, state: state ?? "proposed" }),
        outcome: proposed.outcome,
        committed: proposed.committed,
        files: proposed.files,
      },
    };
  };

  return new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/resources" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: { orgId, projectId }, query }) => {
        if (!(await getProject(db, orgId, projectId))) throw notFound("Project");
        return paged(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (r: Listed) => [r.id],
          fetch: async (after, limit) => {
            const rows = await listResources(db, orgId, projectId, { after: after?.[0], limit });
            const states = await resourceStates(
              db,
              orgId,
              projectId,
              rows.map((r) => r.stack),
            );
            return rows.map((r): Listed => ({ ...r, state: states.get(r.stack) ?? "proposed" }));
          },
          dto,
        });
      },
      {
        params,
        query: pageQuery,
        response: { 200: pageOf(resourceSchema), ...readErrors },
        guard: "resource.read",
      },
    )
    .get(
      "/:id",
      async ({ params: { orgId, projectId, id } }) => {
        const row = await getResource(db, orgId, projectId, id);
        if (!row) throw notFound("Resource");
        const state = (await resourceStates(db, orgId, projectId, [row.stack])).get(row.stack);
        return dto({ ...row, state: state ?? "proposed" });
      },
      {
        params: itemParams,
        response: { 200: resourceSchema, ...readErrors },
        guard: "resource.read",
      },
    )
    .post(
      "/preview",
      async ({ params: { orgId, projectId }, body }) => {
        const { b, stack, path, files, same } = await check(orgId, projectId, body, undefined);
        const idleCost = blueprintCatalog()
          .kinds.find((k) => k.kind === b.kind)
          ?.clouds.find((c) => c.cloud === b.cloud)?.idleCost;
        return {
          verb: same ? ("change" as const) : ("add" as const),
          cloud: b.cloud,
          stack,
          path,
          files,
          idleCost: idleCost ?? "not stated",
        };
      },
      {
        params,
        body: blueprintBody,
        parse: "json",
        response: {
          200: z.object({
            verb: z.enum(["add", "change"]),
            cloud: z.enum(BLUEPRINT_CLOUDS),
            stack: z.string(),
            path: z.string(),
            /** Every file the request would hold, the vendored module included; never their text. */
            files: z.array(z.string()),
            idleCost: z.string(),
          }),
          ...writeErrors,
        },
        noAudit:
          "read-only: checks and renders what a request would hold; asks no forge and writes no row",
        guard: "resource.propose",
      },
    )
    .post(
      "",
      async ({ params: { orgId, projectId }, body, audit, set }) => {
        const { created, body: out } = await propose(
          orgId,
          projectId,
          body,
          undefined,
          audit,
          set.headers["x-request-id"],
        );
        set.status = created ? 201 : 200;
        return out;
      },
      {
        params,
        body: blueprintBody,
        parse: "json",
        response: { 200: proposalSchema, 201: proposalSchema, ...writeErrors, ...sealed },
        audit: "resource.propose",
        guard: "resource.propose",
      },
    )
    .patch(
      "/:id",
      async ({ params: { orgId, projectId, id }, body, audit, set }) => {
        const current = await getResource(db, orgId, projectId, id);
        if (!current) throw notFound("Resource");
        const { body: out } = await propose(
          orgId,
          projectId,
          body,
          current,
          audit,
          set.headers["x-request-id"],
        );
        return out;
      },
      {
        params: itemParams,
        body: blueprintBody,
        parse: "json",
        response: { 200: proposalSchema, ...writeErrors, ...sealed },
        audit: "resource.propose",
        guard: "resource.propose",
      },
    );
};
