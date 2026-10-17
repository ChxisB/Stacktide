import {
  type BulkOp,
  bulkKeys,
  can,
  DomainError,
  type ImportEntry,
  KEY_PATTERN,
  type Logger,
  resolveVariables,
  VARIABLE_KINDS,
  VARIABLE_LEVELS,
  type VariableLevel,
} from "@orch/core";
import { CryptoError, type KeyProvider } from "@orch/crypto";
import {
  type Bulked,
  bulkLevel,
  bulkPlan,
  createVariable,
  deleteVariable,
  describeVariable,
  getEnvironment,
  getOrganization,
  getProject,
  getVariable,
  type Imported,
  importLevel,
  importPlan,
  listVariables,
  listVersions,
  openChain,
  restoreLevel,
  restorePlan,
  revealVariable,
  type Scope,
  searchVariables,
  setVariable,
  snapshotLevel,
  type Variable,
  type VariableInfo,
  type VariableVersion,
} from "@orch/db";
import { createGitlab, GitlabError } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { noKeys, openGitlabConnection, WHY } from "../connections";
import { guardPlugin, unauthenticated } from "../guard";
import type { Principal } from "../principal";
import { fromFile, fromGitlab } from "../variable-import";
import {
  iso,
  mapDbError,
  notFound,
  paged,
  pageOf,
  pageQuery,
  problemSchema,
  type RouteDeps,
  readErrors,
  stamps,
  taken,
  writeErrors,
} from "./shared";

/** Far under what a row or a request should carry; GitLab's own limit for a variable is 10,000. */
const MAX_VALUE = 65_536;

const variableSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  projectId: z.uuid().nullable(),
  environmentId: z.uuid().nullable(),
  level: z.enum(VARIABLE_LEVELS),
  key: z.string(),
  kind: z.enum(VARIABLE_KINDS),
  description: z.string(),
  version: z.number().int(),
  /** Plain variables only: a secret or file value is read through `/value`, which is audited. */
  value: z.string().nullable(),
  ...stamps,
});
const dto = (level: VariableLevel, v: Variable): z.infer<typeof variableSchema> => ({
  id: v.id,
  organizationId: v.organizationId,
  projectId: v.projectId,
  environmentId: v.environmentId,
  level,
  key: v.key,
  kind: v.kind,
  description: v.description,
  version: v.currentVersion,
  value: v.kind === "plain" ? v.value : null,
  createdAt: iso(v.createdAt),
  updatedAt: iso(v.updatedAt),
});

const versionSchema = z.object({
  version: z.number().int(),
  actorKind: z.string(),
  actorId: z.string(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
const revealedSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  kind: z.enum(VARIABLE_KINDS),
  version: z.number().int(),
  value: z.string(),
});
const resolvedSchema = z.object({
  variables: z.array(
    z.object({
      id: z.uuid(),
      level: z.enum(VARIABLE_LEVELS),
      key: z.string(),
      kind: z.enum(VARIABLE_KINDS),
      /** `kind` is `secret` only because the value reads a secret or a file. */
      tainted: z.boolean(),
      value: z.string().nullable(),
    }),
  ),
  issues: z.array(
    z.object({
      code: z.enum(["missing", "cycle", "unresolved", "duplicate", "too_large"]),
      key: z.string(),
      ref: z.string().optional(),
      path: z.array(z.string()).optional(),
      level: z.enum(VARIABLE_LEVELS).optional(),
    }),
  ),
});

const value = z
  .string()
  .max(MAX_VALUE)
  .refine((s) => s.isWellFormed(), "must be valid Unicode text");
const description = z.string().max(1000);
const reason = z.string().max(500);
const keyName = z
  .string()
  .regex(KEY_PATTERN, "letters, digits and underscores, not starting with a digit, up to 255");
const create = z.strictObject({
  key: keyName,
  kind: z.enum(VARIABLE_KINDS),
  value,
  description: description.optional(),
  reason: reason.optional(),
});
// The key and the kind are what other variables and targets refer to: to change one, make a new variable.
const patch = z
  .strictObject({
    value: value.optional(),
    description: description.optional(),
    reason: reason.optional(),
  })
  .refine(
    (o) => o.value !== undefined || o.description !== undefined,
    "a value or a description is required",
  )
  // A reason belongs to a version, and only a new value makes one.
  .refine((o) => o.reason === undefined || o.value !== undefined, "a reason needs a value");
const revealQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

// A moment to go back to: not in the future, and with a zone. In a query an unencoded "+" is a space.
const at = z.iso
  .datetime({
    offset: true,
    error: "must be an ISO 8601 date-time; write a + offset as %2B in a query",
  })
  .refine((s) => Date.parse(s) <= Date.now(), "must not be in the future");
const atQuery = z.object({ at });
const restoreOne = z.strictObject({ version: z.number().int().min(1), reason: reason.optional() });
const restoreAll = z.strictObject({ at, prune: z.boolean().optional() });

const snapshotSchema = z.object({
  at: z.iso.datetime(),
  variables: z.array(
    z.object({
      id: z.uuid(),
      key: z.string(),
      kind: z.enum(VARIABLE_KINDS),
      description: z.string(),
      /** The version that held at that moment. */
      version: z.number().int(),
      value: z.string().nullable(),
    }),
  ),
});
const changeSchema = z.object({
  change: z.enum(["update", "create", "remove", "conflict"]),
  key: z.string(),
  kind: z.enum(VARIABLE_KINDS),
});
const planSchema = z.object({ at: z.iso.datetime(), changes: z.array(changeSchema) });
const restoredSchema = z.object({
  at: z.iso.datetime(),
  changes: z.array(changeSchema.extend({ applied: z.boolean() })),
});

// A pasted `.env` or JSON text, or the variables of the GitLab project this one was imported from.
// A dry run is the default, and so is `secret`: nothing is made readable on a guess.
const MAX_CONTENT = 1_048_576;
const importOptions = { overwrite: z.boolean().optional(), dryRun: z.boolean().optional() };
const fileImport = {
  content: z.string().min(1).max(MAX_CONTENT),
  kind: z.enum(["plain", "secret"]).optional(),
  ...importOptions,
};
const importBody = z.discriminatedUnion("source", [
  z.strictObject({ source: z.literal("dotenv"), ...fileImport }),
  z.strictObject({ source: z.literal("json"), ...fileImport }),
  z.strictObject({ source: z.literal("gitlab"), connectionId: z.uuid(), ...importOptions }),
]);
const importedSchema = z.object({
  source: z.enum(["dotenv", "json", "gitlab"]),
  dryRun: z.boolean(),
  changes: z.array(
    z.object({
      change: z.enum(["create", "update", "unchanged", "conflict", "kind_mismatch"]),
      key: z.string(),
      kind: z.enum(VARIABLE_KINDS),
      applied: z.boolean(),
      /** GitLab's own flags, noted and not carried over. */
      masked: z.boolean().optional(),
      protected: z.boolean().optional(),
    }),
  ),
  skipped: z.array(
    z.object({
      reason: z.enum([
        "syntax",
        "bad_key",
        "bad_value",
        "unclosed_quote",
        "duplicate",
        "hidden",
        "other_scope",
      ]),
      key: z.string().optional(),
      line: z.number().int().optional(),
    }),
  ),
});

// Many steps at once, all or none, a dry run first by default. A key is named by one step only, so
// the order never matters, and the values of one request are held to what an import may carry.
const MAX_BULK = 1000;
const bulkOp = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("set"),
    key: keyName,
    kind: z.enum(VARIABLE_KINDS).optional(),
    value,
  }),
  z.strictObject({ op: z.literal("rename"), key: keyName, to: keyName }),
  z.strictObject({ op: z.literal("delete"), key: keyName }),
]);
const bulkBody = z.strictObject({
  ops: z
    .array(bulkOp)
    .min(1)
    .max(MAX_BULK)
    .refine((ops) => {
      const named = ops.flatMap(bulkKeys);
      return new Set(named).size === named.length;
    }, "a key may be named by one step only")
    .refine(
      (ops) => ops.reduce((n, o) => n + (o.op === "set" ? o.value.length : 0), 0) <= MAX_CONTENT,
      "the values of one request may total 1 MiB",
    ),
  dryRun: z.boolean().optional(),
});
const bulkedSchema = z.object({
  dryRun: z.boolean(),
  changes: z.array(
    z.object({
      change: z.enum([
        "create",
        "update",
        "unchanged",
        "kind_mismatch",
        "rename",
        "delete",
        "missing",
        "conflict",
      ]),
      key: z.string(),
      /** The new key of a rename. */
      to: z.string().optional(),
      /** The kind the key has or will have; none for a key that is not there. */
      kind: z.enum(VARIABLE_KINDS).nullable(),
      applied: z.boolean(),
    }),
  ),
});

// A POST so that what is searched for stays out of URLs, access logs and history.
const searchBody = z
  .strictObject({
    key: z.string().min(1).max(255).optional(),
    value: z.string().min(1).max(1000).optional(),
    kind: z.enum(VARIABLE_KINDS).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .refine(
    (o) => o.key !== undefined || o.value !== undefined || o.kind !== undefined,
    "a key, a value or a kind is required",
  )
  .refine(
    (o) => o.value === undefined || o.kind === undefined || o.kind === "plain",
    "a value is searched for in plain variables only",
  );
const searchedSchema = z.object({
  items: z.array(variableSchema),
  /** There were more matches than this, or the search stopped before it had looked at everything. */
  truncated: z.boolean(),
});

// One schema for all three levels: the path says which ids exist.
const params = z.object({
  orgId: z.uuid(),
  projectId: z.uuid().optional(),
  envId: z.uuid().optional(),
});
const itemParams = params.extend({ varId: z.uuid() });
type Params = z.infer<typeof params>;

const sealed = { 500: problemSchema, 503: problemSchema } as const;
const reads = { ...readErrors, ...sealed } as const;
const writes = { ...writeErrors, ...sealed } as const;

interface Level {
  level: VariableLevel;
  prefix: string;
  /** The guard actions: the organization's variables are held to a stricter set. */
  actions: {
    read: string;
    create: string;
    update: string;
    delete: string;
    reveal: string;
    restore: string;
    import: string;
    bulk: string;
  };
  /** Throws the 404 for a parent that is not there. */
  parent: (db: RouteDeps["db"], p: Params) => Promise<unknown>;
}
const projectActions = {
  read: "variable.read",
  create: "variable.create",
  update: "variable.update",
  delete: "variable.delete",
  reveal: "secret.reveal",
  restore: "variable.restore",
  import: "variable.import",
  bulk: "variable.bulk",
};
const organizationLevel: Level = {
  level: "organization",
  prefix: "/organizations/:orgId/variables",
  actions: {
    read: "variable.org.read",
    create: "variable.org.create",
    update: "variable.org.update",
    delete: "variable.org.delete",
    reveal: "secret.reveal.org",
    restore: "variable.org.restore",
    import: "variable.org.import",
    bulk: "variable.org.bulk",
  },
  parent: async (db, p) =>
    (await getOrganization(db, p.orgId)) ?? Promise.reject(notFound("Organization")),
};
const projectLevel: Level = {
  level: "project",
  prefix: "/organizations/:orgId/projects/:projectId/variables",
  actions: projectActions,
  parent: async (db, p) =>
    (p.projectId && (await getProject(db, p.orgId, p.projectId))) ||
    Promise.reject(notFound("Project")),
};
const environmentLevel: Level = {
  level: "environment",
  prefix: "/organizations/:orgId/projects/:projectId/environments/:envId/variables",
  actions: projectActions,
  parent: async (db, p) =>
    (p.projectId && p.envId && (await getEnvironment(db, p.orgId, p.projectId, p.envId))) ||
    Promise.reject(notFound("Environment")),
};

const scopeOf = (p: Params): Scope => ({
  organizationId: p.orgId,
  projectId: p.projectId,
  environmentId: p.envId,
});
const actorOf = (principal: Principal | undefined) => {
  if (!principal) throw unauthenticated();
  return { kind: principal.kind, id: principal.id };
};

/** Where and what, by name: never a value (the audit trail screens keys, this keeps to ids and names). */
const audited = (
  action: string,
  level: VariableLevel,
  v: VariableInfo,
  extra: Record<string, unknown> = {},
) => ({
  action,
  resourceType: "variable",
  resourceId: v.id,
  organizationId: v.organizationId,
  ...(v.projectId && { projectId: v.projectId }),
  metadata: {
    level,
    ...(v.environmentId && { environmentId: v.environmentId }),
    key: v.key,
    kind: v.kind,
    ...extra,
  },
});

const KNOWN_ERRORS = {
  variables_org_key: taken("key_taken", "The key"),
  variables_project_key: taken("key_taken", "The key"),
  variables_environment_key: taken("key_taken", "The key"),
  // The composite keys: no such project in this organization, no such environment in this project.
  variable_keys_project_org_fk: notFound("Project"),
  variables_project_org_fk: notFound("Project"),
  variables_environment_project_fk: notFound("Environment"),
  variables_organization_id_organizations_id_fk: notFound("Organization"),
  variable_keys_organization_id_organizations_id_fk: notFound("Organization"),
};

/**
 * For `.catch()`: a stored value that does not open (the master key is gone or the row was
 * altered) is an operator's problem, logged by code only; a violated constraint we know is its
 * API error.
 */
const fail = (logger: Logger, requestId: unknown) => (e: unknown) => {
  if (!(e instanceof CryptoError)) return mapDbError(KNOWN_ERRORS)(e);
  logger.error("variable value cannot be opened", { request_id: requestId, code: e.code });
  throw new DomainError(
    "secret_unreadable",
    500,
    "The stored value cannot be opened: check ORCH_MASTER_KEYS",
  );
};

export const failing = (logger: Logger) => (set: { headers: Record<string, unknown> }) =>
  fail(logger, set.headers["x-request-id"]);

/**
 * Variables at three levels: the organization's, a project's and an environment's. A `plain` value
 * is shown; a `secret` or `file` value never is, except by `GET .../:varId/value`, which needs the
 * reveal permission and is audited. Without master keys every route that opens a value answers
 * 503; deleting and the history do not need keys.
 */
const levelRoutes = (
  { db, principal, keys, logger }: RouteDeps & { keys?: KeyProvider; logger: Logger },
  spec: Level,
) => {
  const sealing = () => {
    if (!keys) throw noKeys();
    return keys;
  };
  const failingWith = failing(logger);
  /** The variables of the GitLab project this one was imported from, read through an organization connection. */
  const fromGitlabProject = async (
    p: Params,
    connectionId: string,
    requestId: unknown,
    accept: (entry: ImportEntry) => boolean,
  ) => {
    if (spec.level === "organization") {
      throw new DomainError(
        "unsupported_source",
        422,
        "GitLab variables are imported into a project or an environment",
      );
    }
    const project = p.projectId && (await getProject(db, p.orgId, p.projectId));
    if (!project) throw notFound("Project");
    if (!project.gitlabProjectId) {
      throw new DomainError("not_linked", 422, "This project was not imported from GitLab");
    }
    // GitLab scopes a variable to an environment by its name: here that is the slug.
    const env = p.envId && p.projectId && (await getEnvironment(db, p.orgId, p.projectId, p.envId));
    const { baseUrl, token } = await openGitlabConnection(
      { db, keys, logger },
      p.orgId,
      connectionId,
      requestId,
    );
    const api = createGitlab({
      baseUrl,
      auth: { type: "private-token", token },
      timeoutMs: 15_000,
      maxRetries: 1,
      maxRetryDelayMs: 2_000,
    });
    try {
      return await fromGitlab(api, project.gitlabProjectId, env ? env.slug : "*", accept);
    } catch (e) {
      throw e instanceof GitlabError ? new DomainError("gitlab_failed", 502, WHY[e.kind]) : e;
    }
  };
  const { level, actions } = spec;
  return new Elysia({ prefix: spec.prefix })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: p, query, set }) => {
        const k = sealing();
        await spec.parent(db, p);
        const scope = scopeOf(p);
        return paged<Variable, [string], z.infer<typeof variableSchema>>(query, {
          key: z.tuple([z.uuid()]),
          keyOf: (v): [string] => [v.id],
          fetch: (after, limit) =>
            listVariables(db, k, scope, { after: after?.[0], limit }).catch(failingWith(set)),
          dto: (v) => dto(level, v),
        });
      },
      {
        params,
        query: pageQuery,
        response: { 200: pageOf(variableSchema), ...reads },
        guard: actions.read,
      },
    )
    .get(
      "/:varId",
      async ({ params: p, set }) => {
        const v = await getVariable(db, sealing(), scopeOf(p), p.varId).catch(failingWith(set));
        if (!v) throw notFound("Variable");
        return dto(level, v);
      },
      {
        params: itemParams,
        response: { 200: variableSchema, ...reads },
        guard: actions.read,
      },
    )
    .post(
      "",
      async ({ params: p, body, audit, set, principal: caller }) => {
        const k = sealing();
        const actor = actorOf(caller);
        // The foreign keys below say the same, but only while the project has no data key yet.
        await spec.parent(db, p);
        const created = await db
          .transaction(async (tx) => {
            const v = await createVariable(tx, k, { ...scopeOf(p), ...body, actor });
            await audit(tx, audited("variable.create", level, v));
            return v;
          })
          .catch(failingWith(set));
        set.status = 201;
        return dto(level, created);
      },
      {
        params,
        body: create,
        parse: "json",
        response: { 201: variableSchema, ...writes },
        audit: "variable.create",
        guard: actions.create,
      },
    )
    .patch(
      "/:varId",
      async ({ params: p, body, audit, set, principal: caller }) => {
        const k = sealing();
        const actor = actorOf(caller);
        const changed = await db
          .transaction(async (tx) => {
            const v = await setVariable(tx, k, scopeOf(p), p.varId, { ...body, actor });
            if (!v) throw notFound("Variable");
            const fields = (["description", "value"] as const).filter((f) => body[f] !== undefined);
            await audit(
              tx,
              audited("variable.update", level, v, { fields, version: v.currentVersion }),
            );
            return v;
          })
          .catch(failingWith(set));
        return dto(level, changed);
      },
      {
        params: itemParams,
        body: patch,
        parse: "json",
        response: { 200: variableSchema, ...writes },
        audit: "variable.update",
        guard: actions.update,
      },
    )
    .delete(
      "/:varId",
      async ({ params: p, audit, set }) => {
        await db.transaction(async (tx) => {
          const v = await describeVariable(tx, scopeOf(p), p.varId);
          if (!v || !(await deleteVariable(tx, scopeOf(p), p.varId))) throw notFound("Variable");
          await audit(tx, audited("variable.delete", level, v));
        });
        set.status = 204;
      },
      {
        params: itemParams,
        response: { 204: z.undefined(), ...writes },
        audit: "variable.delete",
        guard: actions.delete,
      },
    )
    .get(
      "/:varId/versions",
      async ({ params: p, query }) => {
        const scope = scopeOf(p);
        if (!(await describeVariable(db, scope, p.varId))) throw notFound("Variable");
        return paged<VariableVersion, [number], z.infer<typeof versionSchema>>(query, {
          key: z.tuple([z.number().int().min(1)]),
          keyOf: (v): [number] => [v.version],
          fetch: (after, limit) => listVersions(db, scope, p.varId, { after: after?.[0], limit }),
          dto: (v) => ({ ...v, createdAt: iso(v.createdAt) }),
        });
      },
      {
        params: itemParams,
        query: pageQuery,
        response: { 200: pageOf(versionSchema), ...readErrors },
        guard: actions.read,
      },
    )
    .get(
      "/:varId/value",
      async ({ params: p, query, audit, set }) => {
        const k = sealing();
        // The audit row is written in the same transaction as the read: no row, no value.
        const revealed = await db
          .transaction(async (tx) => {
            const r = await revealVariable(tx, k, scopeOf(p), p.varId, query.version);
            if (!r) throw notFound("Variable");
            await audit(tx, audited("variable.reveal", level, r.variable, { version: r.version }));
            return r;
          })
          .catch(failingWith(set));
        set.headers["cache-control"] = "no-store";
        const { id, key, kind } = revealed.variable;
        return { id, key, kind, version: revealed.version, value: revealed.value };
      },
      {
        params: itemParams,
        query: revealQuery,
        response: { 200: revealedSchema, ...reads },
        audit: "variable.reveal",
        guard: actions.reveal,
      },
    )
    .post(
      "/:varId/restore",
      async ({ params: p, body, audit, set, principal: caller }) => {
        const k = sealing();
        const actor = actorOf(caller);
        const restored = await db
          .transaction(async (tx) => {
            const old = await revealVariable(tx, k, scopeOf(p), p.varId, body.version);
            if (!old) throw notFound("Variable");
            // A new version with the old value: the history only grows.
            const reason = body.reason ?? `restored from version ${body.version}`;
            const v = await setVariable(tx, k, scopeOf(p), p.varId, {
              value: old.value,
              actor,
              reason,
            });
            if (!v) throw notFound("Variable");
            await audit(
              tx,
              audited("variable.update", level, v, {
                fields: ["value"],
                version: v.currentVersion,
                restoredVersion: body.version,
              }),
            );
            return v;
          })
          .catch(failingWith(set));
        return dto(level, restored);
      },
      {
        params: itemParams,
        body: restoreOne,
        parse: "json",
        response: { 200: variableSchema, ...writes },
        audit: "variable.update",
        guard: actions.restore,
      },
    )
    .get(
      "/snapshot",
      async ({ params: p, query, set }) => {
        const k = sealing();
        await spec.parent(db, p);
        const moment = new Date(query.at);
        const held = await snapshotLevel(db, k, scopeOf(p), moment).catch(failingWith(set));
        return {
          at: moment.toISOString(),
          variables: held.map(({ id, key, kind, description, version, value }) => ({
            id,
            key,
            kind,
            description,
            version,
            value,
          })),
        };
      },
      {
        params,
        query: atQuery,
        response: { 200: snapshotSchema, ...reads },
        guard: actions.read,
      },
    )
    .get(
      "/restore-plan",
      async ({ params: p, query, set }) => {
        const k = sealing();
        await spec.parent(db, p);
        const moment = new Date(query.at);
        const changes = await restorePlan(db, k, scopeOf(p), moment).catch(failingWith(set));
        return { at: moment.toISOString(), changes };
      },
      {
        params,
        query: atQuery,
        response: { 200: planSchema, ...reads },
        guard: actions.restore,
      },
    )
    .post(
      "/restore",
      async ({ params: p, body, audit, set, principal: caller }) => {
        const k = sealing();
        const actor = actorOf(caller);
        await spec.parent(db, p);
        const moment = new Date(body.at);
        const prune = body.prune === true;
        const done = await db
          .transaction(async (tx) => {
            const changes = await restoreLevel(tx, k, scopeOf(p), moment, { actor, prune });
            for (const c of changes) {
              if (!c.applied || !c.variable || c.change === "conflict") continue;
              const extra = { restoredTo: moment.toISOString() };
              await audit(
                tx,
                c.change === "remove"
                  ? audited("variable.delete", level, c.variable, extra)
                  : audited(
                      c.change === "create" ? "variable.create" : "variable.update",
                      level,
                      c.variable,
                      { ...extra, version: c.variable.currentVersion },
                    ),
              );
            }
            // One row for the restore itself, so a restore that changes nothing is on record too.
            await audit(tx, {
              action: "variable.restore_level",
              resourceType: "variable",
              organizationId: p.orgId,
              ...(p.projectId && { projectId: p.projectId }),
              metadata: {
                level,
                ...(p.envId && { environmentId: p.envId }),
                restoredTo: moment.toISOString(),
                prune,
                plannedCount: changes.length,
                appliedCount: changes.filter((c) => c.applied).length,
              },
            });
            return changes;
          })
          .catch(failingWith(set));
        return {
          at: moment.toISOString(),
          changes: done.map(({ change, key, kind, applied }) => ({ change, key, kind, applied })),
        };
      },
      {
        params,
        body: restoreAll,
        parse: "json",
        response: { 200: restoredSchema, ...writes },
        audit: ["variable.create", "variable.update", "variable.delete", "variable.restore_level"],
        guard: actions.restore,
      },
    )
    .post(
      "/import",
      async ({ params: p, body, audit, set, principal: caller }) => {
        // The connection's token is the organization's, and a connection is not bound to a project
        // (a numeric project id can mean another project on another GitLab): its use needs the
        // right to read connections, which a project maintainer does not have.
        if (
          body.source === "gitlab" &&
          caller &&
          "subject" in caller &&
          !can(caller.subject, "connection.read", { organizationId: p.orgId })
        ) {
          throw new DomainError("forbidden", 403, "Not allowed: connection.read");
        }
        const k = sealing();
        const actor = actorOf(caller);
        await spec.parent(db, p);
        const dryRun = body.dryRun !== false;
        const overwrite = body.overwrite === true;
        const { source } = body;
        const accept = (e: ImportEntry) =>
          value.safeParse(e.value).success && description.safeParse(e.description ?? "").success;
        const found =
          body.source === "gitlab"
            ? await fromGitlabProject(p, body.connectionId, set.headers["x-request-id"], accept)
            : fromFile(body.source, body.content, body.kind ?? "secret", accept);
        const done = await db
          .transaction(async (tx) => {
            const changes = dryRun
              ? (await importPlan(tx, k, scopeOf(p), found.entries, overwrite)).map(
                  (c): Imported => ({
                    change: c.change,
                    key: c.key,
                    kind: c.kind,
                    applied: false,
                  }),
                )
              : await importLevel(tx, k, scopeOf(p), found.entries, { actor, overwrite, source });
            for (const c of changes) {
              if (!c.variable) continue;
              await audit(
                tx,
                audited(
                  c.change === "create" ? "variable.create" : "variable.update",
                  level,
                  c.variable,
                  { source, version: c.variable.currentVersion },
                ),
              );
            }
            const count = (change: string) => changes.filter((c) => c.change === change).length;
            // One row per import, a dry run too: it opens every secret of the level to compare.
            await audit(tx, {
              action: "variable.import",
              resourceType: "variable",
              organizationId: p.orgId,
              ...(p.projectId && { projectId: p.projectId }),
              metadata: {
                level,
                ...(p.envId && { environmentId: p.envId }),
                source,
                ...(body.source === "gitlab" && { connectionId: body.connectionId }),
                dryRun,
                overwrite,
                plannedCount: changes.length,
                createdCount: changes.filter((c) => c.change === "create" && c.applied).length,
                updatedCount: changes.filter((c) => c.change === "update" && c.applied).length,
                conflictCount: count("conflict") + count("kind_mismatch"),
                skippedCount: found.skipped.length,
              },
            });
            return changes;
          })
          .catch(failingWith(set));
        return {
          source,
          dryRun,
          changes: done.map(({ change, key, kind, applied }) => ({
            change,
            key,
            kind,
            applied,
            ...found.flags.get(key),
          })),
          skipped: found.skipped,
        };
      },
      {
        params,
        body: importBody,
        parse: "json",
        response: { 200: importedSchema, ...writes, 502: problemSchema },
        audit: ["variable.create", "variable.update", "variable.import"],
        guard: actions.import,
      },
    )
    .post(
      "/bulk",
      async ({ params: p, body, audit, set, principal: caller }) => {
        const k = sealing();
        const actor = actorOf(caller);
        await spec.parent(db, p);
        const dryRun = body.dryRun !== false;
        const ops: BulkOp[] = body.ops;
        const done = await db
          .transaction(async (tx) => {
            const changes = dryRun
              ? (await bulkPlan(tx, k, scopeOf(p), ops)).map(
                  (c): Bulked => ({
                    change: c.change,
                    key: c.key,
                    kind: c.kind,
                    applied: false,
                    ...(c.to !== undefined && { to: c.to }),
                  }),
                )
              : await bulkLevel(tx, k, scopeOf(p), ops, { actor });
            for (const c of changes) {
              const v = c.variable;
              if (!v) continue;
              const extra = { source: "bulk" };
              if (c.change === "delete") {
                await audit(tx, audited("variable.delete", level, v, extra));
              } else if (c.change === "rename") {
                await audit(
                  tx,
                  audited("variable.update", level, v, {
                    ...extra,
                    fields: ["key"],
                    previousKey: c.key,
                  }),
                );
              } else {
                await audit(
                  tx,
                  audited(c.change === "create" ? "variable.create" : "variable.update", level, v, {
                    ...extra,
                    ...(c.change === "update" && { fields: ["value"] }),
                    version: v.currentVersion,
                  }),
                );
              }
            }
            const count = (change: string) => changes.filter((c) => c.change === change).length;
            // One row per request, a dry run too: it opens every secret of the level to compare.
            await audit(tx, {
              action: "variable.bulk",
              resourceType: "variable",
              organizationId: p.orgId,
              ...(p.projectId && { projectId: p.projectId }),
              metadata: {
                level,
                ...(p.envId && { environmentId: p.envId }),
                dryRun,
                plannedCount: changes.length,
                createdCount: changes.filter((c) => c.change === "create" && c.applied).length,
                updatedCount: changes.filter((c) => c.change === "update" && c.applied).length,
                renamedCount: changes.filter((c) => c.change === "rename" && c.applied).length,
                deletedCount: changes.filter((c) => c.change === "delete" && c.applied).length,
                conflictCount: count("conflict") + count("kind_mismatch"),
                missingCount: count("missing"),
              },
            });
            return changes;
          })
          .catch(failingWith(set));
        return {
          dryRun,
          changes: done.map(({ change, key, to, kind, applied }) => ({
            change,
            key,
            ...(to !== undefined && { to }),
            kind,
            applied,
          })),
        };
      },
      {
        params,
        body: bulkBody,
        parse: "json",
        response: { 200: bulkedSchema, ...writes },
        audit: ["variable.create", "variable.update", "variable.delete", "variable.bulk"],
        guard: actions.bulk,
      },
    );
};

export const variableRoutes = (deps: RouteDeps & { keys?: KeyProvider; logger: Logger }) =>
  new Elysia()
    .use(levelRoutes(deps, organizationLevel))
    .use(levelRoutes(deps, projectLevel))
    .use(levelRoutes(deps, environmentLevel))
    .use(resolvedRoute(deps))
    .use(searchRoute(deps));

/** What an environment sees: the three levels laid over each other, references filled in. */
const resolvedRoute = (deps: RouteDeps & { keys?: KeyProvider; logger: Logger }) =>
  new Elysia()
    .use(auditPlugin(deps.principal))
    .use(guardPlugin)
    .get(
      "/organizations/:orgId/projects/:projectId/environments/:envId/resolved-variables",
      async ({ params: { orgId, projectId, envId }, set }) => {
        if (!deps.keys) throw noKeys();
        if (!(await getEnvironment(deps.db, orgId, projectId, envId))) {
          throw notFound("Environment");
        }
        const chain = await openChain(deps.db, deps.keys, {
          organizationId: orgId,
          projectId,
          environmentId: envId,
        }).catch(failing(deps.logger)(set));
        const { variables, issues } = resolveVariables(chain);
        return {
          variables: variables.map((v) => ({
            id: v.id,
            level: v.level,
            key: v.key,
            kind: v.kind,
            tainted: v.tainted,
            // A secret, a file, and a plain value that reads one: none of them leaves here.
            value: v.kind === "plain" ? v.value : null,
          })),
          issues,
        };
      },
      {
        params: z.object({ orgId: z.uuid(), projectId: z.uuid(), envId: z.uuid() }),
        response: { 200: resolvedSchema, ...reads },
        guard: "variable.read",
      },
    );

const levelOf = (v: VariableInfo): VariableLevel =>
  v.environmentId ? "environment" : v.projectId ? "project" : "organization";

/**
 * Variables of an organization by part of the key and, for plain ones, of the value: one request
 * over its three levels. The caller needs `variable.org.read`, which carries read access to every
 * project (the project role the organization role brings), so the projects' and environments'
 * variables are in unless a token's scopes leave out `variable.read`.
 */
const searchRoute = (deps: RouteDeps & { keys?: KeyProvider; logger: Logger }) =>
  new Elysia()
    .use(auditPlugin(deps.principal))
    .use(guardPlugin)
    .post(
      "/organizations/:orgId/variable-search",
      async ({ params: { orgId }, body, set, principal: caller }) => {
        if (!deps.keys) throw noKeys();
        if (!(await getOrganization(deps.db, orgId))) throw notFound("Organization");
        const projects =
          !caller ||
          !("subject" in caller) ||
          can(caller.subject, "variable.read", { organizationId: orgId, projectId: orgId });
        const { items, more } = await searchVariables(deps.db, deps.keys, {
          ...body,
          organizationId: orgId,
          projects,
          limit: body.limit ?? 50,
        }).catch(failing(deps.logger)(set));
        return { items: items.map((v) => dto(levelOf(v), v)), truncated: more };
      },
      {
        params: z.object({ orgId: z.uuid() }),
        body: searchBody,
        parse: "json",
        response: { 200: searchedSchema, ...reads, 415: problemSchema },
        noAudit: "read-only: a search changes nothing, and what it looks for stays out of the log",
        guard: "variable.org.read",
      },
    );
