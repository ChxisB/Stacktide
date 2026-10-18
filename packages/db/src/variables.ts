import {
  type BulkChange,
  type BulkOp,
  type ImportChange,
  type ImportEntry,
  planBulk,
  planImport,
  planRestore,
  type RestoreChange,
  type RestoreEntry,
  type VariableInput,
  type VariableLevel,
} from "@orch/core";
import {
  aad,
  type Dek,
  decrypt,
  encrypt,
  generateDek,
  type KeyProvider,
  unwrapDek,
  wrapDek,
} from "@orch/crypto";
import { and, asc, desc, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { AuditContext } from "./audit";
import { queueAutoSync } from "./auto-sync";
import type { Executor, Page } from "./repo";
import { type VariableKind, variableKeys, variables, variableVersions } from "./schema";

/**
 * Where a variable lives, which is also who owns its data key: an organization (`projectId`
 * left out) or one of its projects. Every function below repeats these ids in its queries, so an
 * id from a URL finds nothing under the wrong organization or project.
 */
export interface Owner {
  organizationId: string;
  projectId?: string;
}

/** One level: the organization's, a project's (no `environmentId`) or one environment's. */
export interface Scope extends Owner {
  environmentId?: string;
}

type Actor = AuditContext["actor"];

/** Everything callers get to see of a variable's row: no ciphertext, no data key. */
const visible = {
  id: variables.id,
  organizationId: variables.organizationId,
  projectId: variables.projectId,
  environmentId: variables.environmentId,
  key: variables.key,
  kind: variables.kind,
  description: variables.description,
  currentVersion: variables.currentVersion,
  createdAt: variables.createdAt,
  updatedAt: variables.updatedAt,
};
export type VariableInfo = Omit<typeof variables.$inferSelect, "deletedAt">;

/**
 * A variable and its value, which is there for `plain` variables only: a `secret` or `file` value
 * comes out of `revealVariable` (one variable) or `openChain` (to resolve an environment) and
 * nowhere else.
 */
export type Variable = VariableInfo & { value: string | null };

export interface VariableVersion {
  version: number;
  actorKind: string;
  actorId: string;
  reason: string | null;
  createdAt: Date;
}

// What a ciphertext and a data key are bound to: moved to another variable, version, project or
// organization, they do not open.
const valueAad = (o: Owner, id: string, version: number) =>
  aad("variable", o.organizationId, o.projectId ?? "", id, String(version));
const keyContext = (o: Owner) =>
  o.projectId ? `variables:project:${o.projectId}` : `variables:org:${o.organizationId}`;

export { keyContext as variableKeyContext }; // `rewrap.ts` needs the same context to move a key

const ownerIs = (o: Owner) =>
  and(
    eq(variableKeys.organizationId, o.organizationId),
    o.projectId === undefined
      ? isNull(variableKeys.projectId)
      : eq(variableKeys.projectId, o.projectId),
  );

/**
 * A variable of exactly this level (the organization's, a project's without an environment, or one
 * environment's), deleted or not: with an `id`, that one. An id from another level finds nothing.
 */
const levelOf = (s: Scope, id?: string) =>
  and(
    eq(variables.organizationId, s.organizationId),
    s.projectId === undefined ? isNull(variables.projectId) : eq(variables.projectId, s.projectId),
    s.environmentId === undefined
      ? isNull(variables.environmentId)
      : eq(variables.environmentId, s.environmentId),
    id === undefined ? undefined : eq(variables.id, id),
  );
const live = (s: Scope, id?: string) => and(levelOf(s, id), isNull(variables.deletedAt));

/** The current version of each variable selected. */
const currentVersion = and(
  eq(variableVersions.variableId, variables.id),
  eq(variableVersions.version, variables.currentVersion),
);

async function findKey(db: Executor, keys: KeyProvider, o: Owner): Promise<Dek | undefined> {
  const [row] = await db
    .select({ dekKeyId: variableKeys.dekKeyId, dekWrapped: variableKeys.dekWrapped })
    .from(variableKeys)
    .where(ownerIs(o));
  return row && unwrapDek(keys, { keyId: row.dekKeyId, wrapped: row.dekWrapped }, keyContext(o));
}

/** The key of an owner that has variables. Missing is damage, not a reason to make another. */
async function existingKey(db: Executor, keys: KeyProvider, o: Owner): Promise<Dek> {
  const dek = await findKey(db, keys, o);
  if (!dek) throw new Error("variable key missing");
  return dek;
}

/**
 * The owner's data key, made on first use (by `createVariable` only: a lost key must not be quietly replaced). Two writers racing both make one; the loser's insert
 * does nothing and it uses the winner's.
 */
async function sealingKey(db: Executor, keys: KeyProvider, o: Owner): Promise<Dek> {
  const found = await findKey(db, keys, o);
  if (found) return found;
  const dek = generateDek();
  const wrap = await wrapDek(keys, dek, keyContext(o));
  const made = await db
    .insert(variableKeys)
    .values({
      organizationId: o.organizationId,
      projectId: o.projectId ?? null,
      dekKeyId: wrap.keyId,
      dekWrapped: wrap.wrapped,
    })
    .onConflictDoNothing()
    .returning({ id: variableKeys.id });
  if (made.length > 0) return dek;
  const winner = await findKey(db, keys, o);
  if (!winner) throw new Error("variable key vanished, or the project is in another organization");
  return winner;
}

/** Where a change request's sealed edits belong: moved to another request, environment, project or organization, they do not open. */
export interface PendingAt {
  organizationId: string;
  projectId: string;
  environmentId: string;
  id: string;
}
const pendingAad = (p: PendingAt) =>
  aad("change_request", p.organizationId, p.projectId, p.environmentId, p.id);

/** The edits of a change request, sealed with the project's data key (made on first use, as for a first variable). */
export async function sealPending(
  db: Executor,
  keys: KeyProvider,
  at: PendingAt,
  ops: readonly BulkOp[],
): Promise<Uint8Array> {
  const dek = await sealingKey(db, keys, at);
  return encrypt(dek, JSON.stringify(ops), pendingAad(at));
}

/** The edits `sealPending` sealed. Sealed by this code and bound to `at`, so what opens is what was validated then. */
export async function openPending(
  db: Executor,
  keys: KeyProvider,
  at: PendingAt,
  blob: Uint8Array,
): Promise<BulkOp[]> {
  const dek = await existingKey(db, keys, at);
  return JSON.parse(decrypt(dek, blob, pendingAad(at))) as BulkOp[];
}

interface Sealed extends VariableInfo {
  version: number;
  valueEnc: Uint8Array;
}

/** The values of `rows` that `want` picks, in order, null for the others. Each key is unwrapped once. */
async function unseal(
  db: Executor,
  keys: KeyProvider,
  rows: Sealed[],
  want: (row: Sealed) => boolean,
): Promise<(string | null)[]> {
  const deks = new Map<string, Promise<Dek>>();
  const dekOf = (o: Owner) => {
    const id = o.projectId ?? `org:${o.organizationId}`;
    const known = deks.get(id);
    if (known) return known;
    const opened = existingKey(db, keys, o);
    deks.set(id, opened);
    return opened;
  };
  return Promise.all(
    rows.map(async (row) => {
      if (!want(row)) return null;
      const owner = { organizationId: row.organizationId, projectId: row.projectId ?? undefined };
      return decrypt(await dekOf(owner), row.valueEnc, valueAad(owner, row.id, row.version));
    }),
  );
}

const sealedColumns = {
  ...visible,
  version: variableVersions.version,
  valueEnc: variableVersions.valueEnc,
};
const info = ({ version: _v, valueEnc: _e, ...row }: Sealed): VariableInfo => row;

async function readVariables(db: Executor, keys: KeyProvider, rows: Sealed[]): Promise<Variable[]> {
  const values = await unseal(db, keys, rows, (r) => r.kind === "plain");
  return rows.map((row, i) => ({ ...info(row), value: values[i] ?? null }));
}

/**
 * Stores a variable at `input`'s level with its first version. The value is sealed with the
 * owner's data key (made here if need be); the plaintext is written nowhere. A key already used
 * by a live variable at that level is a unique violation (23505), an invalid key or kind a check
 * violation (23514), a project or environment that is not there a foreign key violation (23503).
 * That last one holds only while the project has no data key: a project that has one, named with
 * another organization, fails with a plain `Error`, so a caller checks the parent first.
 */
export async function createVariable(
  db: Executor,
  keys: KeyProvider,
  input: Scope & {
    key: string;
    kind: VariableKind;
    description?: string;
    value: string;
    actor: Actor;
    reason?: string;
  },
): Promise<Variable> {
  const id = Bun.randomUUIDv7(); // the id is part of what the ciphertext is bound to
  return db.transaction(async (tx) => {
    const dek = await sealingKey(tx, keys, input);
    await tx.insert(variables).values({
      id,
      organizationId: input.organizationId,
      projectId: input.projectId ?? null,
      environmentId: input.environmentId ?? null,
      key: input.key,
      kind: input.kind,
      description: input.description ?? "",
    });
    await tx.insert(variableVersions).values({
      variableId: id,
      version: 1,
      valueEnc: encrypt(dek, input.value, valueAad(input, id, 1)),
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      reason: input.reason ?? null,
    });
    const created = await getVariable(tx, keys, input, id);
    if (!created) throw new Error("insert returned no row");
    await queueAutoSync(tx, input);
    return created;
  });
}

/**
 * Changes a live variable: a `value` becomes its next version (the old ones stay), a
 * `description` replaces the description. Undefined when it is not there (or deleted).
 */
export async function setVariable(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  id: string,
  patch: { value?: string; description?: string; actor: Actor; reason?: string },
): Promise<Variable | undefined> {
  if (patch.value === undefined && patch.description === undefined) {
    return getVariable(db, keys, scope, id);
  }
  return db.transaction(async (tx) => {
    // The update takes the row lock: concurrent writers get a version each, in turn.
    const [row] = await tx
      .update(variables)
      .set({
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.value !== undefined && { currentVersion: sql`${variables.currentVersion} + 1` }),
      })
      .where(live(scope, id))
      .returning({ version: variables.currentVersion });
    if (!row) return undefined;
    if (patch.value !== undefined) {
      const dek = await existingKey(tx, keys, scope);
      await tx.insert(variableVersions).values({
        variableId: id,
        version: row.version,
        valueEnc: encrypt(dek, patch.value, valueAad(scope, id, row.version)),
        actorKind: patch.actor.kind,
        actorId: patch.actor.id,
        reason: patch.reason ?? null,
      });
      await queueAutoSync(tx, scope);
    }
    return getVariable(tx, keys, scope, id);
  });
}

/** Marks a variable deleted: it is gone from every read and its key is free, its history stays. True if it was live. */
export function deleteVariable(db: Executor, scope: Scope, id: string) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(variables)
      .set({ deletedAt: sql`now()` })
      .where(live(scope, id))
      .returning({ id: variables.id });
    if (rows.length === 0) return false;
    await queueAutoSync(tx, scope);
    return true;
  });
}

/** A live variable of exactly this level, without opening its value: to check it is there and say what it is. */
export async function describeVariable(
  db: Executor,
  scope: Scope,
  id: string,
): Promise<VariableInfo | undefined> {
  const [row] = await db.select(visible).from(variables).where(live(scope, id));
  return row;
}

export async function getVariable(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  id: string,
): Promise<Variable | undefined> {
  const rows = await db
    .select(sealedColumns)
    .from(variables)
    .innerJoin(variableVersions, currentVersion)
    .where(live(scope, id));
  return (await readVariables(db, keys, rows))[0];
}

/** The variables of exactly one level, ordered by id (a v7 uuid: creation order). */
export async function listVariables(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  page: Page<string>,
): Promise<Variable[]> {
  const rows = await db
    .select(sealedColumns)
    .from(variables)
    .innerJoin(variableVersions, currentVersion)
    .where(and(live(scope), page.after ? gt(variables.id, page.after) : undefined))
    .orderBy(asc(variables.id))
    .limit(page.limit);
  return readVariables(db, keys, rows);
}

/** A live variable's versions, newest first; `after` is the last version of the previous page. */
export function listVersions(
  db: Executor,
  scope: Scope,
  id: string,
  page: Page<number>,
): Promise<VariableVersion[]> {
  return db
    .select({
      version: variableVersions.version,
      actorKind: variableVersions.actorKind,
      actorId: variableVersions.actorId,
      reason: variableVersions.reason,
      createdAt: variableVersions.createdAt,
    })
    .from(variableVersions)
    .innerJoin(variables, eq(variables.id, variableVersions.variableId))
    .where(and(live(scope, id), page.after ? lt(variableVersions.version, page.after) : undefined))
    .orderBy(desc(variableVersions.version))
    .limit(page.limit);
}

/**
 * The value of a live variable, current or of an `version`: the one way to a `secret` or `file`
 * value for a person asking for it. The plaintext must go nowhere but the response: not a log, an
 * error or an audit row. Throws a `CryptoError` when the master key is gone or the row was
 * tampered with.
 */
export async function revealVariable(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  id: string,
  version?: number,
): Promise<{ variable: VariableInfo; version: number; value: string } | undefined> {
  const rows = await db
    .select(sealedColumns)
    .from(variables)
    .innerJoin(
      variableVersions,
      and(
        eq(variableVersions.variableId, variables.id),
        eq(variableVersions.version, version ?? variables.currentVersion),
      ),
    )
    .where(live(scope, id));
  const [row] = rows;
  if (!row) return undefined;
  const [value] = await unseal(db, keys, rows, () => true);
  if (value === null || value === undefined) throw new Error("no value");
  return { variable: info(row), version: row.version, value };
}

/** The live variables of the organization, the project and (if named) the environment: what resolves for the environment. */
const inChain = (scope: Required<Pick<Scope, "projectId">> & Scope) =>
  and(
    eq(variables.organizationId, scope.organizationId),
    isNull(variables.deletedAt),
    or(
      isNull(variables.projectId),
      and(
        eq(variables.projectId, scope.projectId),
        scope.environmentId === undefined
          ? isNull(variables.environmentId)
          : or(isNull(variables.environmentId), eq(variables.environmentId, scope.environmentId)),
      ),
    ),
  );

/**
 * The names (sorted, once each) of the variables that apply to an environment, or to a project
 * without `environmentId`. Opens nothing, so it needs no master key and cannot leak a value: it
 * answers "is it set there?" and no more.
 */
export async function chainKeys(
  db: Executor,
  scope: Required<Pick<Scope, "projectId">> & Scope,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ key: variables.key })
    .from(variables)
    .where(inChain(scope))
    .orderBy(asc(variables.key));
  return rows.map((r) => r.key);
}

/** What `resolveVariables` in `@orch/core` takes: the types are one, so they cannot drift apart. */
export type ChainLevel = VariableLevel;
/** The version is there to tell, later, that a variable has changed since: it is not part of the resolution. */
export type ChainEntry = VariableInput & { version: number };

/**
 * Every live variable that applies to an environment (or, without `environmentId`, to a project):
 * the organization's, the project's and the environment's, all values opened, in no particular
 * precedence (the resolver in `@orch/core` applies that). The input to resolution and to nothing
 * else: the caller must treat `secret` and `file` values as such. Fails whole on a value that
 * does not open.
 */
export async function openChain(
  db: Executor,
  keys: KeyProvider,
  scope: Required<Pick<Scope, "projectId">> & Scope,
): Promise<ChainEntry[]> {
  const rows = await db
    .select(sealedColumns)
    .from(variables)
    .innerJoin(variableVersions, currentVersion)
    .where(inChain(scope))
    .orderBy(asc(variables.id));
  const values = await unseal(db, keys, rows, () => true);
  return rows.map((row, i) => ({
    id: row.id,
    level:
      row.projectId === null
        ? "organization"
        : row.environmentId === null
          ? "project"
          : "environment",
    key: row.key,
    kind: row.kind,
    value: values[i] ?? "",
    version: row.version,
  }));
}

// A timestamp has microseconds and a Date milliseconds (so does what the API shows): "at 12:00:00.123"
// has to include all of that millisecond, or a version could not be asked for by its own time.
const through = (at: Date) => new Date(at.getTime() + 1);

/**
 * The variables of one level that existed at `at` (not yet deleted), each with its latest version
 * made by then; without `at`, the live ones with their current version. The description is the
 * current one: only values are versioned. The inner join drops nothing it should keep: a variable
 * and its first version are written in one transaction, so they share a `created_at`.
 */
function rowsAt(db: Executor, scope: Scope, at?: Date): Promise<Sealed[]> {
  const upto = at && through(at);
  return db
    .select(sealedColumns)
    .from(variables)
    .innerJoin(
      variableVersions,
      and(
        eq(variableVersions.variableId, variables.id),
        eq(
          variableVersions.version,
          upto
            ? sql`(select max(v.version) from variable_versions v where v.variable_id = ${variables.id} and v.created_at < ${upto.toISOString()}::timestamptz)`
            : variables.currentVersion,
        ),
      ),
    )
    .where(
      upto
        ? and(
            levelOf(scope),
            lt(variables.createdAt, upto),
            or(isNull(variables.deletedAt), gte(variables.deletedAt, upto)),
          )
        : live(scope),
    )
    .orderBy(asc(variables.id));
}

/**
 * One level as it was at `at`: `plain` values come back, `secret` and `file` values do not (a
 * secret of the past is revealed no more than a current one). `version` is the one that held then.
 */
export async function snapshotLevel(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  at: Date,
): Promise<(Variable & { version: number })[]> {
  const rows = await rowsAt(db, scope, at);
  const values = await unseal(db, keys, rows, (r) => r.kind === "plain");
  return rows.map((row, i) => ({ ...info(row), version: row.version, value: values[i] ?? null }));
}

type Held = RestoreEntry & { description: string };

/** Every value of the level opened, now or `at`: to compare, and to restore from. */
async function holdings(db: Executor, keys: KeyProvider, scope: Scope, at?: Date) {
  const rows = await rowsAt(db, scope, at);
  const values = await unseal(db, keys, rows, () => true);
  return rows.map(
    (r, i): Held => ({
      id: r.id,
      key: r.key,
      kind: r.kind,
      description: r.description,
      value: values[i] ?? "",
    }),
  );
}

const planAt = async (db: Executor, keys: KeyProvider, scope: Scope, at: Date) =>
  planRestore(await holdings(db, keys, scope, at), await holdings(db, keys, scope));

/** A step of a restore: never a value. */
export interface PlannedChange {
  change: RestoreChange["change"];
  key: string;
  kind: VariableKind;
}

/** What `restoreLevel` would do for the same `at`. Changes nothing. */
export async function restorePlan(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  at: Date,
): Promise<PlannedChange[]> {
  return (await planAt(db, keys, scope, at)).map(({ change, key, kind }) => ({
    change,
    key,
    kind,
  }));
}

export interface AppliedChange extends PlannedChange {
  /** False for a `conflict`, for a `remove` without `prune`, and for a variable deleted meanwhile. */
  applied: boolean;
  /** What the change made or removed, for the audit trail. */
  variable?: VariableInfo;
}

const bare = ({ value: _value, ...variable }: Variable): VariableInfo => variable;

/**
 * Makes the level hold what it held at `at`, in one transaction: a changed value is put back as a
 * new version, a deleted variable is made again (a new id), and a variable added since is deleted
 * only with `prune`. A key whose kind changed is left alone. Idempotent: once done, the same call
 * changes nothing. History is never rewritten. Keys and values only: a description is not put back
 * (a variable made again gets the one it had when it was deleted). Nothing is locked, so an edit that
 * lands while this runs is overwritten and a variable made meanwhile is left alone.
 */
export function restoreLevel(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  at: Date,
  opts: { actor: Actor; prune: boolean },
): Promise<AppliedChange[]> {
  const { actor } = opts;
  const reason = `restored to ${at.toISOString()}`;
  return db.transaction(async (tx) => {
    const done: AppliedChange[] = [];
    for (const c of await planAt(tx, keys, scope, at)) {
      const step = { change: c.change, key: c.key, kind: c.kind };
      if (c.change === "update") {
        const v = await setVariable(tx, keys, scope, c.current.id, {
          value: c.wanted.value,
          actor,
          reason,
        });
        done.push({ ...step, applied: v !== undefined, ...(v && { variable: bare(v) }) });
      } else if (c.change === "create") {
        const { value, description } = c.wanted;
        const v = await createVariable(tx, keys, {
          ...scope,
          key: c.key,
          kind: c.kind,
          description,
          value,
          actor,
          reason,
        });
        done.push({ ...step, applied: true, variable: bare(v) });
      } else if (c.change === "remove" && opts.prune) {
        const v = await describeVariable(tx, scope, c.current.id);
        const gone = v !== undefined && (await deleteVariable(tx, scope, c.current.id));
        done.push({ ...step, applied: gone, ...(v && { variable: v }) });
      } else {
        done.push({ ...step, applied: false });
      }
    }
    return done;
  });
}

/** What bringing `incoming` into the level would do: every value of the level is opened to compare. */
export async function importPlan(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  incoming: readonly ImportEntry[],
  overwrite: boolean,
): Promise<ImportChange<Held>[]> {
  return planImport(incoming, await holdings(db, keys, scope), overwrite);
}

export interface Imported {
  change: ImportChange["change"];
  key: string;
  kind: VariableKind;
  applied: boolean;
  /** What the change made or changed, for the audit trail. */
  variable?: VariableInfo;
}

/**
 * Brings `incoming` into the level in one transaction: a new key is made, a key with another value
 * is changed (a new version) only with `overwrite`, anything else is left as it is. Nothing is ever
 * deleted. Idempotent: the same import again changes nothing. `source` is named in each version's
 * reason.
 */
export function importLevel(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  incoming: readonly ImportEntry[],
  opts: { actor: Actor; overwrite: boolean; source: string },
): Promise<Imported[]> {
  const { actor } = opts;
  const reason = `imported from ${opts.source}`;
  return db.transaction(async (tx) => {
    const done: Imported[] = [];
    for (const c of await importPlan(tx, keys, scope, incoming, opts.overwrite)) {
      const step = { change: c.change, key: c.key, kind: c.kind };
      if (c.change === "create") {
        const { value, description } = c.incoming;
        const v = await createVariable(tx, keys, {
          ...scope,
          key: c.key,
          kind: c.kind,
          value,
          ...(description && { description }),
          actor,
          reason,
        });
        done.push({ ...step, applied: true, variable: bare(v) });
      } else if (c.change === "update" && c.current) {
        const v = await setVariable(tx, keys, scope, c.current.id, {
          value: c.incoming.value,
          actor,
          reason,
        });
        done.push({ ...step, applied: v !== undefined, ...(v && { variable: bare(v) }) });
      } else {
        done.push({ ...step, applied: false });
      }
    }
    return done;
  });
}

/** Gives a live variable another key; its versions stay. Undefined when it is not there. A key held by another live variable at the level is a unique violation (23505). */
async function renameVariable(
  db: Executor,
  scope: Scope,
  id: string,
  to: string,
): Promise<VariableInfo | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(variables)
      .set({ key: to })
      .where(live(scope, id))
      .returning(visible);
    if (row) await queueAutoSync(tx, scope);
    return row;
  });
}

/** What `bulkLevel` would do: every value of the level is opened to compare. */
export async function bulkPlan(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  ops: readonly BulkOp[],
): Promise<BulkChange<Held>[]> {
  return planBulk(ops, await holdings(db, keys, scope));
}

export interface Bulked {
  change: BulkChange["change"];
  key: string;
  to?: string;
  kind: VariableKind | null;
  applied: boolean;
  /** What the change made, changed, renamed or removed, for the audit trail. A rename shows the new key. */
  variable?: VariableInfo;
}

/**
 * Does `ops` to the level in one transaction: a `set` makes the key or gives it a new version if
 * the value differs, a `rename` changes the key, a `delete` marks it deleted. Anything else
 * (`unchanged`, `missing`, `conflict`, `kind_mismatch`) is left alone. Idempotent: the same call
 * again changes nothing. Keys named by two steps are the caller's to refuse. Nothing is locked, so
 * a concurrent edit may be overwritten by a `set`.
 */
export function bulkLevel(
  db: Executor,
  keys: KeyProvider,
  scope: Scope,
  ops: readonly BulkOp[],
  opts: { actor: Actor; reason?: string },
): Promise<Bulked[]> {
  const { actor, reason = "bulk edit" } = opts;
  return db.transaction(async (tx) => {
    const done: Bulked[] = [];
    for (const c of await bulkPlan(tx, keys, scope, ops)) {
      const step = {
        change: c.change,
        key: c.key,
        kind: c.kind,
        ...(c.to !== undefined && { to: c.to }),
      };
      const { op, current } = c;
      if (c.change === "create" && op.op === "set" && c.kind) {
        const v = await createVariable(tx, keys, {
          ...scope,
          key: c.key,
          kind: c.kind,
          value: op.value,
          actor,
          reason,
        });
        done.push({ ...step, applied: true, variable: bare(v) });
      } else if (c.change === "update" && op.op === "set" && current) {
        const v = await setVariable(tx, keys, scope, current.id, {
          value: op.value,
          actor,
          reason,
        });
        done.push({ ...step, applied: v !== undefined, ...(v && { variable: bare(v) }) });
      } else if (c.change === "rename" && op.op === "rename" && current) {
        const v = await renameVariable(tx, scope, current.id, op.to);
        done.push({ ...step, applied: v !== undefined, ...(v && { variable: v }) });
      } else if (c.change === "delete" && current) {
        const v = await describeVariable(tx, scope, current.id);
        const gone = v !== undefined && (await deleteVariable(tx, scope, current.id));
        done.push({ ...step, applied: gone, ...(v && { variable: v }) });
      } else {
        done.push({ ...step, applied: false });
      }
    }
    return done;
  });
}

export interface VariableSearch {
  organizationId: string;
  /** False: the organization's own variables only, not those of its projects and environments. */
  projects: boolean;
  /** Part of the key, any case. */
  key?: string;
  /** Part of a `plain` value, case-sensitive. Secrets and files are never opened to look. */
  value?: string;
  kind?: VariableKind;
  limit: number;
  /** How many rows a search by value opens before it stops; {@link SEARCH_SCAN} unless a test says otherwise. */
  scan?: number;
}

/** How many `plain` rows a search by value opens before it gives up. */
export const SEARCH_SCAN = 2000;

/**
 * Live variables of an organization (and its projects and environments) whose key contains `key`
 * and, for `plain` ones, whose value contains `value`; ordered by key, then id. A search by value
 * is `plain` only: no secret is opened to look. `more` means there were more than `limit` matches,
 * or, for a value search, that the first {@link SEARCH_SCAN} rows were not enough to say.
 */
export async function searchVariables(
  db: Executor,
  keys: KeyProvider,
  q: VariableSearch,
): Promise<{ items: Variable[]; more: boolean }> {
  const kind = q.value === undefined ? q.kind : "plain";
  if (q.value !== undefined && q.kind !== undefined && q.kind !== "plain") {
    return { items: [], more: false };
  }
  const scan = q.value === undefined ? q.limit : (q.scan ?? SEARCH_SCAN);
  const rows = await db
    .select(sealedColumns)
    .from(variables)
    .innerJoin(variableVersions, currentVersion)
    .where(
      and(
        eq(variables.organizationId, q.organizationId),
        isNull(variables.deletedAt),
        q.projects ? undefined : isNull(variables.projectId),
        kind === undefined ? undefined : eq(variables.kind, kind),
        q.key === undefined
          ? undefined
          : sql`strpos(lower(${variables.key}), ${q.key.toLowerCase()}) > 0`,
      ),
    )
    .orderBy(asc(variables.key), asc(variables.id))
    .limit(scan + 1);
  const found = await readVariables(db, keys, rows.slice(0, scan));
  const hits =
    q.value === undefined ? found : found.filter((v) => v.value?.includes(q.value ?? ""));
  return { items: hits.slice(0, q.limit), more: hits.length > q.limit || rows.length > scan };
}
