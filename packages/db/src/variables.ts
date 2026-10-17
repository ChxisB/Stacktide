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
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
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

/** A live variable of the owner: with an `id`, that one (at any environment of the project). */
const live = (o: Owner, id?: string) =>
  and(
    eq(variables.organizationId, o.organizationId),
    o.projectId === undefined ? isNull(variables.projectId) : eq(variables.projectId, o.projectId),
    isNull(variables.deletedAt),
    id === undefined ? undefined : eq(variables.id, id),
  );

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
  if (!winner) throw new Error("variable key vanished");
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
  owner: Owner,
  id: string,
  patch: { value?: string; description?: string; actor: Actor; reason?: string },
): Promise<Variable | undefined> {
  if (patch.value === undefined && patch.description === undefined) {
    return getVariable(db, keys, owner, id);
  }
  return db.transaction(async (tx) => {
    // The update takes the row lock: concurrent writers get a version each, in turn.
    const [row] = await tx
      .update(variables)
      .set({
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.value !== undefined && { currentVersion: sql`${variables.currentVersion} + 1` }),
      })
      .where(live(owner, id))
      .returning({ version: variables.currentVersion });
    if (!row) return undefined;
    if (patch.value !== undefined) {
      const dek = await existingKey(tx, keys, owner);
      await tx.insert(variableVersions).values({
        variableId: id,
        version: row.version,
        valueEnc: encrypt(dek, patch.value, valueAad(owner, id, row.version)),
        actorKind: patch.actor.kind,
        actorId: patch.actor.id,
        reason: patch.reason ?? null,
      });
    }
    return getVariable(tx, keys, owner, id);
  });
}

/** Marks a variable deleted: it is gone from every read and its key is free, its history stays. True if it was live. */
export async function deleteVariable(db: Executor, owner: Owner, id: string) {
  const rows = await db
    .update(variables)
    .set({ deletedAt: sql`now()` })
    .where(live(owner, id))
    .returning({ id: variables.id });
  return rows.length > 0;
}

export async function getVariable(
  db: Executor,
  keys: KeyProvider,
  owner: Owner,
  id: string,
): Promise<Variable | undefined> {
  const rows = await db
    .select(sealedColumns)
    .from(variables)
    .innerJoin(variableVersions, currentVersion)
    .where(live(owner, id));
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
    .where(
      and(
        live(scope),
        scope.environmentId === undefined
          ? isNull(variables.environmentId)
          : eq(variables.environmentId, scope.environmentId),
        page.after ? gt(variables.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(variables.id))
    .limit(page.limit);
  return readVariables(db, keys, rows);
}

/** A live variable's versions, newest first; `after` is the last version of the previous page. */
export function listVersions(
  db: Executor,
  owner: Owner,
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
    .where(and(live(owner, id), page.after ? lt(variableVersions.version, page.after) : undefined))
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
  owner: Owner,
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
    .where(live(owner, id));
  const [row] = rows;
  if (!row) return undefined;
  const [value] = await unseal(db, keys, rows, () => true);
  if (value === null || value === undefined) throw new Error("no value");
  return { variable: info(row), version: row.version, value };
}

export type ChainLevel = "organization" | "project" | "environment";

export interface ChainEntry {
  id: string;
  level: ChainLevel;
  key: string;
  kind: VariableKind;
  value: string;
}

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
