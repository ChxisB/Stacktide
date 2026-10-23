import { DomainError, type Logger, parseStateResources, type StateResource } from "@orch/core";
import type { KeyProvider } from "@orch/crypto";
import {
  type AuditEvent,
  blockedBy,
  deleteState,
  forceUnlock,
  getProject,
  listStacks,
  listStateResources,
  listStateVersions,
  lockState,
  MAX_STATE_BYTES,
  type PutStateResult,
  putState,
  readState,
  type StateLock,
  type StateRef,
  type Tx,
  unlockState,
} from "@orch/db";
import { GitlabError } from "@orch/gitlab";
import { Elysia } from "elysia";
import { z } from "zod";
import { auditPlugin } from "../audit";
import { WHY } from "../connections";
import { guardPlugin } from "../guard";
import { jobKey, type Principal, personOf } from "../principal";
import { gitlabFor } from "./pipeline";
import {
  notFound,
  paged,
  pageOf,
  pageQuery,
  problemSchema,
  type RouteDeps,
  readCapped,
  readErrors,
  writeErrors,
} from "./shared";

const params = z.object({
  orgId: z.uuid(),
  projectId: z.uuid(),
  // the same shape the table's check constraint holds a stack name to
  stack: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
});
const written = z.object({ serial: z.number().int(), unchanged: z.boolean() });
const deleted = z.object({ versions: z.number().int() });
const resourceSchema = z.object({
  address: z.string(),
  mode: z.enum(["managed", "data"]),
  type: z.string(),
  name: z.string(),
  provider: z.string(),
  module: z.string().nullable(),
  indexKey: z.string().nullable(),
});
/** Text of at most `max` characters with no NUL, which Postgres cannot keep in a text or jsonb column. */
const plain = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !s.includes("\0"));
// every filter is an exact value, never a pattern; `module=` (empty) is the root module
const resourceQuery = pageQuery.extend({
  type: plain(1024).optional(),
  provider: plain(1024).optional(),
  module: plain(1024).optional(),
});
const versionSchema = z.object({
  serial: z.number().int(),
  lineage: z.string(),
  sizeBytes: z.number().int(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
});
const imported = z.object({
  serial: z.number().int(),
  lineage: z.string(),
  sizeBytes: z.number().int(),
  resources: z.number().int(),
});
const importBody = z.strictObject({ connectionId: z.uuid() });
const sealed = { 503: problemSchema } as const;
const released = z.object({ released: z.boolean() });
const lockTaken = z.object({ locked: z.literal(true) });
const lockId = plain(256).min(1);
/** Terraform's lock info: what it sends to lock and to unlock, and reads back from a 423. Anything else is dropped. */
const lockInfo = z.object({
  ID: lockId,
  Operation: plain(256).optional(),
  Info: plain(1024).optional(),
  Who: plain(256).optional(),
  Version: plain(64).optional(),
  Created: z.iso.datetime({ offset: true }).optional(),
  Path: plain(512).optional(),
});
const MAX_LOCK_BYTES = 8 * 1024;
/** A refused lock, release or write: the problem document plus the holder's lock info, as Terraform reads it. */
const locked = problemSchema.extend(lockInfo.shape);
const lockErrors = { ...writeErrors, 413: problemSchema, 423: locked, ...sealed } as const;
type Audit = (tx: Tx, event: AuditEvent) => Promise<void>;

const invalid = () =>
  new DomainError("invalid_state", 422, "The body is not Terraform state (version 4)");
const heldBy = (held: StateLock) =>
  new DomainError("state_locked", 423, "The state is locked", held.info);
const REFUSALS = {
  serial_too_low: "The serial is lower than the stored state's",
  lineage_changed: "The lineage is not the stored state's",
  serial_conflict: "The stored state has this serial with other content",
  not_empty: "The stack already has state: an import only fills an empty stack",
} as const;

/** A document that names its serial and lineage, and the index of what it holds; `bad` is the refusal for one that is not state. */
const readDoc = (text: string, bad: () => DomainError) => {
  let doc: { version?: unknown; serial?: unknown; lineage?: unknown };
  try {
    doc = JSON.parse(text);
  } catch {
    throw bad();
  }
  const { version, serial, lineage } = doc ?? {};
  if (version !== 4 || typeof serial !== "number" || typeof lineage !== "string") throw bad();
  if (lineage.includes("\0")) throw bad();
  // what the index holds is worked out before anything is written: a state it cannot index is not stored
  const indexed = parseStateResources(doc);
  if (!indexed.ok) throw bad();
  return { serial, lineage, resources: indexed.resources };
};
/** A refused write as the problem it answers with. */
const refusal = (put: Extract<PutStateResult, { ok: false }>, bad: () => DomainError) => {
  if (put.reason === "invalid") return bad();
  if (put.reason === "too_large") {
    return new DomainError("payload_too_large", 413, "The state is too large");
  }
  const at = put.latest ? ` (stored: serial ${put.latest.serial})` : "";
  return new DomainError(put.reason, 409, `${REFUSALS[put.reason]}${at}`);
};

/**
 * Terraform state kept by the platform (STATE-3, ADR-0017), spoken the way Terraform's `http` backend speaks it:
 * `GET` returns the newest version's bytes (404 when there is none), `POST` stores the next version, `DELETE`
 * removes every version. The caller is a CI job (its token carries `state.read`, and `state.write` only on a
 * protected ref) and never a person: a state holds secrets in clear, so its content goes to the job that needs it
 * and to nobody who holds a role. A stack has one lock (STATE-4): a job takes it with `LOCK` or `POST .../lock`,
 * ends it with `UNLOCK` or `DELETE .../lock` (the backend's own verbs, and the pair a proxy that dislikes custom
 * verbs can carry), and while it is held only its holder writes, naming the lock in `?ID=`. It ends with the job's
 * token. An organization admin ends any lock with `POST .../force-unlock`.
 *
 * The project is the token's own: a path naming another project or organization finds nothing. State is kept by
 * stack name, and reading or writing it needs the stack to be in the project's scan; deleting does not, so the
 * state of a stack taken out of the repository can still be cleared (it holds the project's RESTRICT foreign key).
 */
export const stateRoutes = ({
  db,
  principal,
  keys,
  logger,
}: RouteDeps & { keys?: KeyProvider | undefined; logger: Logger }) => {
  // A guard names the action; this is the other half: no person, whatever role or scope they hold, reads state.
  const job = (caller: Principal | undefined) => {
    if (caller?.kind !== "ci") {
      throw new DomainError("forbidden", 403, "Not allowed: state is for CI jobs");
    }
    return caller;
  };
  const scoped = async (p: z.infer<typeof params>, mustExist: boolean): Promise<StateRef> => {
    if (!(await getProject(db, p.orgId, p.projectId))) throw notFound("Project");
    if (
      mustExist &&
      !(await listStacks(db, p.orgId, p.projectId)).some((s) => s.name === p.stack)
    ) {
      throw new DomainError("unknown_stack", 403, "The project has no stack of this name");
    }
    return { organizationId: p.orgId, projectId: p.projectId, stackName: p.stack };
  };
  const target = async (p: z.infer<typeof params>, mustExist: boolean) => {
    if (!keys) {
      throw new DomainError("state_unavailable", 503, "State storage needs the master keys");
    }
    return { keys, ref: await scoped(p, mustExist) };
  };
  // The job a state write or lock is the work of: the lock's owner, and `created_by` of a version.
  const ownerOf = (who: Extract<Principal, { subject: unknown }>, projectId: string) => {
    const job = jobKey(who.job);
    return job ? `ci:${projectId}:${job}` : `ci:${who.id}`;
  };
  const lockInfoOf = async (request: Request) => {
    const text = await readCapped(request, MAX_LOCK_BYTES);
    if (text === undefined)
      throw new DomainError("payload_too_large", 413, "The lock info is too large");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const parsed = lockInfo.safeParse(body);
    if (!parsed.success) {
      throw new DomainError("invalid_lock", 422, "The body is not Terraform's lock info");
    }
    return parsed.data;
  };
  // LOCK and UNLOCK are Terraform's own verbs; POST and DELETE on `.../lock` are the same two things.
  const take = async (
    p: z.infer<typeof params>,
    request: Request,
    caller: Principal | undefined,
    audit: Audit,
  ) => {
    const who = job(caller);
    const expiresAt = who.job?.expiresAt;
    if (!expiresAt)
      throw new DomainError("forbidden", 403, "Not allowed: a lock ends with the job's token");
    const ref = await scoped(p, true);
    const info = await lockInfoOf(request);
    const got = await db.transaction(async (tx) => {
      const r = await lockState(tx, ref, {
        lockId: info.ID,
        owner: ownerOf(who, p.projectId),
        expiresAt,
        info,
      });
      if (r.ok) {
        await audit(tx, {
          ...meta(p),
          action: "state.lock",
          metadata: { stack: p.stack, lockId: info.ID, operation: info.Operation ?? "" },
        });
      }
      return r;
    });
    if (!got.ok) throw heldBy(got.held);
    return { locked: true as const };
  };
  const release = async (
    p: z.infer<typeof params>,
    request: Request,
    caller: Principal | undefined,
    audit: Audit,
  ) => {
    const who = job(caller);
    const ref = await scoped(p, false); // a stack taken out of the repository can still be released
    const info = await lockInfoOf(request);
    const done = await db.transaction(async (tx) => {
      const r = await unlockState(tx, ref, { lockId: info.ID, owner: ownerOf(who, p.projectId) });
      if (r.ok) {
        await audit(tx, {
          ...meta(p),
          action: "state.unlock",
          metadata: { stack: p.stack, lockId: info.ID, released: r.released },
        });
      }
      return r;
    });
    if (!done.ok) throw heldBy(done.held);
    return { released: done.released };
  };
  const meta = (p: z.infer<typeof params>) => ({
    resourceType: "state",
    resourceId: p.stack,
    organizationId: p.orgId,
    projectId: p.projectId,
  });

  return new Elysia({ prefix: "/organizations/:orgId/projects/:projectId/state/:stack" })
    .use(auditPlugin(principal))
    .use(guardPlugin)
    .get(
      "",
      async ({ params: p, principal: caller, audit, set }) => {
        job(caller);
        const { keys: sealing, ref } = await target(p, true);
        const found = await readState(db, sealing, ref);
        if (!found) throw notFound("State");
        await db.transaction((tx) =>
          audit(tx, {
            ...meta(p),
            action: "state.read",
            metadata: { stack: p.stack, serial: found.version.serial },
          }),
        );
        set.headers["content-type"] = "application/json";
        // no-store comes from the edge headers, on every answer
        return found.content; // the bytes as written: Terraform checks what it reads
      },
      {
        params,
        response: { 200: z.string(), ...readErrors, ...sealed },
        audit: "state.read",
        guard: "state.read",
      },
    )
    .get(
      "/resources",
      async ({ params: p, query }) => {
        // a person reads the names of what the state holds, never the state: the index has identity only
        const ref = await scoped(p, false);
        return paged<StateResource, [string], StateResource>(query, {
          key: z.tuple([z.string()]),
          keyOf: (r) => [r.address],
          fetch: (after, limit) =>
            listStateResources(db, ref, {
              ...(query.type !== undefined && { type: query.type }),
              ...(query.provider !== undefined && { provider: query.provider }),
              ...(query.module !== undefined && {
                module: query.module === "" ? null : query.module,
              }),
              after: after?.[0],
              limit,
            }),
          dto: (r) => r,
        });
      },
      {
        params,
        query: resourceQuery,
        response: { 200: pageOf(resourceSchema), ...readErrors },
        guard: "state.list",
      },
    )
    .get(
      "/versions",
      async ({ params: p }) => {
        // who wrote which version and when: the newest STATE_RETENTION of them, so no paging, and no content
        const versions = await listStateVersions(db, await scoped(p, false));
        return versions.map((v) => ({
          serial: v.serial,
          lineage: v.lineage,
          sizeBytes: v.sizeBytes,
          createdBy: v.createdBy,
          createdAt: v.createdAt.toISOString(),
        }));
      },
      {
        params,
        response: { 200: z.array(versionSchema), ...readErrors },
        guard: "state.list",
      },
    )
    .post(
      "",
      async ({ params: p, query, request, principal: caller, audit }) => {
        const who = job(caller);
        const { keys: sealing, ref } = await target(p, true);
        const text = await readCapped(request, MAX_STATE_BYTES);
        if (text === undefined) {
          throw new DomainError("payload_too_large", 413, "The state is too large");
        }
        const { serial, lineage, resources } = readDoc(text, invalid);
        const by = ownerOf(who, p.projectId);
        const put = await db.transaction(async (tx) => {
          // a lock holds off every writer but its holder, who names it; with no ID nobody's lock is met
          const held = await blockedBy(tx, ref, { owner: by, lockId: query.ID ?? "" });
          if (held) throw heldBy(held);
          const r = await putState(tx, sealing, ref, {
            serial,
            lineage,
            content: text,
            createdBy: by,
            resources,
          });
          if (!r.ok) return r;
          await audit(tx, {
            ...meta(p),
            action: "state.write",
            metadata: {
              stack: p.stack,
              serial: r.version.serial,
              sizeBytes: r.version.sizeBytes,
              unchanged: r.unchanged,
            },
          });
          return r;
        });
        if (!put.ok) throw refusal(put, invalid);
        return { serial: put.version.serial, unchanged: put.unchanged };
      },
      {
        params,
        query: z.object({ ID: z.string().max(256).optional() }),
        // The body stays unread until the caller is known to be a job of this project; the route reads it, capped.
        parse: "none",
        response: { 200: written, ...lockErrors },
        audit: "state.write",
        guard: "state.write",
      },
    )
    .delete(
      "",
      async ({ params: p, principal: caller, audit }) => {
        const who = job(caller);
        const { ref } = await target(p, false);
        const versions = await db.transaction(async (tx) => {
          // Terraform's delete names no lock, so the holder is let through on being the holder
          const held = await blockedBy(tx, ref, { owner: ownerOf(who, p.projectId) });
          if (held) throw heldBy(held);
          const n = await deleteState(tx, ref);
          await audit(tx, {
            ...meta(p),
            action: "state.delete",
            metadata: { stack: p.stack, versions: n },
          });
          return n;
        });
        return { versions }; // Terraform wants a 200
      },
      {
        params,
        response: { 200: deleted, ...lockErrors },
        audit: "state.delete",
        guard: "state.write",
      },
    )
    .route(
      "LOCK",
      "",
      ({ params: p, request, principal: caller, audit }) => take(p, request, caller, audit),
      {
        params,
        parse: "none",
        response: { 200: lockTaken, ...lockErrors },
        audit: "state.lock",
        guard: "state.write",
        // left out of the document: OpenAPI has no such verb, and POST/DELETE ".../lock" is the same thing
        detail: { hide: true },
      },
    )
    .route(
      "UNLOCK",
      "",
      ({ params: p, request, principal: caller, audit }) => release(p, request, caller, audit),
      {
        params,
        parse: "none",
        response: { 200: released, ...lockErrors },
        audit: "state.unlock",
        guard: "state.write",
        // left out of the document: OpenAPI has no such verb, and POST/DELETE ".../lock" is the same thing
        detail: { hide: true },
      },
    )
    .post(
      "/lock",
      ({ params: p, request, principal: caller, audit }) => take(p, request, caller, audit),
      {
        params,
        parse: "none",
        response: { 200: lockTaken, ...lockErrors },
        audit: "state.lock",
        guard: "state.write",
      },
    )
    .delete(
      "/lock",
      ({ params: p, request, principal: caller, audit }) => release(p, request, caller, audit),
      {
        params,
        parse: "none",
        response: { 200: released, ...lockErrors },
        audit: "state.unlock",
        guard: "state.write",
      },
    )
    .post(
      "/import",
      async ({ params: p, body, principal: caller, audit, set }) => {
        if (!caller) throw new Error("the guard lets no anonymous caller through");
        const { keys: sealing, ref } = await target(p, true);
        const project = await getProject(db, p.orgId, p.projectId);
        if (project?.gitlabProjectId == null) {
          throw new DomainError(
            "project_unlinked",
            422,
            "The project is not linked to a GitLab project",
          );
        }
        // an import only fills an empty stack: asked here so GitLab is not read for nothing, and once more, in the
        // transaction that writes, so two imports at once keep one
        if ((await listStateVersions(db, ref)).length > 0) {
          throw new DomainError("not_empty", 409, REFUSALS.not_empty);
        }
        const gitlab = await gitlabFor(
          { db, keys: sealing, logger },
          p.orgId,
          body.connectionId,
          set.headers["x-request-id"],
        );
        const read = await gitlab.terraformState
          .get(project.gitlabProjectId, p.stack, MAX_STATE_BYTES)
          .catch((e: unknown) => {
            if (!(e instanceof GitlabError)) throw e;
            // GitLab's own text can name the URL or the path: fixed words only
            throw new DomainError(
              "gitlab_failed",
              502,
              e.kind === "forbidden"
                ? "GitLab refused the token: reading a project's Terraform state needs the Maintainer role in the project."
                : WHY[e.kind],
            );
          });
        if (read.status === "missing") {
          throw new DomainError(
            "state_not_found",
            404,
            "GitLab holds no state of this name for the project",
          );
        }
        if (read.status === "too_large") {
          throw new DomainError("payload_too_large", 413, "The state is too large");
        }
        const bad = () =>
          new DomainError(
            "invalid_state",
            422,
            "What GitLab holds is not Terraform state (version 4)",
          );
        const doc = readDoc(read.text, bad);
        const by = `import:${personOf(caller).ref}`;
        const put = await db.transaction(async (tx) => {
          // a lock is a job at work on this stack: it holds an import off, whoever asks (the importer is nobody's job)
          const held = await blockedBy(tx, ref, { owner: by, lockId: "" });
          if (held) throw heldBy(held);
          const r = await putState(tx, sealing, ref, {
            ...doc,
            content: read.text,
            createdBy: by,
            onlyIfEmpty: true,
          });
          if (!r.ok) return r;
          await audit(tx, {
            ...meta(p),
            action: "state.import",
            metadata: {
              stack: p.stack,
              serial: r.version.serial,
              sizeBytes: r.version.sizeBytes,
              resources: doc.resources.length,
            },
          });
          return r;
        });
        if (!put.ok) throw refusal(put, bad);
        set.status = 201;
        return {
          serial: put.version.serial,
          lineage: put.version.lineage,
          sizeBytes: put.version.sizeBytes,
          resources: doc.resources.length,
        };
      },
      {
        params,
        body: importBody,
        response: { 201: imported, 502: problemSchema, ...lockErrors },
        audit: "state.import",
        guard: "state.import",
      },
    )
    .post(
      "/force-unlock",
      async ({ params: p, audit }) => {
        const ref = await scoped(p, false);
        const gone = await db.transaction(async (tx) => {
          const held = await forceUnlock(tx, ref);
          await audit(tx, {
            ...meta(p),
            action: "state.force_unlock",
            metadata: { stack: p.stack, lockId: held?.lockId ?? null, owner: held?.owner ?? null },
          });
          return held;
        });
        return { released: gone !== undefined };
      },
      {
        params,
        response: { 200: released, ...writeErrors },
        audit: "state.force_unlock",
        guard: "state.force_unlock",
      },
    );
};
