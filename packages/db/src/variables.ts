import {
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
    }
    return getVariable(tx, keys, scope, id);
  });
}

/** Marks a variable deleted: it is gone from every read and its key is free, its history stays. True if it was live. */
export async function deleteVariable(db: Executor, scope: Scope, id: string) {
  const rows = await db
    .update(variables)
    .set({ deletedAt: sql`now()` })
    .where(live(scope, id))
    .returning({ id: variables.id });
  return rows.length > 0;
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

/** What `resolveVariables` in `@orch/core` takes: the types are one, so they cannot drift apart. */
export type ChainLevel = VariableLevel;
export type ChainEntry = VariableInput;

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
    .where(
      and(
        eq(variables.organizationId, scope.organizationId),
        isNull(variables.deletedAt),
        or(
          isNull(variables.projectId),
          and(
            eq(variables.projectId, scope.projectId),
            scope.environmentId === undefined
              ? isNull(variables.environmentId)
              : or(
                  isNull(variables.environmentId),
                  eq(variables.environmentId, scope.environmentId),
                ),
          ),
        ),
      ),
    )
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
