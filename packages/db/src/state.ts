import type { StateResource } from "@orch/core";
import {
  aad,
  decrypt,
  encrypt,
  generateDek,
  type KeyProvider,
  unwrapDek,
  wrapDek,
} from "@orch/crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Executor } from "./repo";
import { stateResources, stateVersions } from "./schema";
import { takeTurn } from "./state-locks"; // writers of one stack take turns, so a serial is checked against the version it will sit next to

/** The largest state the repository stores, whatever the API's body cap says. */
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
/** Index rows inserted at a time. */
const INDEX_BATCH = 1000;
/** How many versions of a stack are kept: the newest, by serial. */
export const STATE_RETENTION = 20;

type Row = typeof stateVersions.$inferSelect;
/** What callers get to see of a version: no state, no data key, no ciphertext. */
export type StateVersion = Omit<Row, "stateEnc" | "dekKeyId" | "dekWrapped">;
/** One stack's state: state is kept by project and stack name, not by a `stacks` row (see the schema). */
export interface StateRef {
  organizationId: string;
  projectId: string;
  stackName: string;
}

const visible = {
  id: stateVersions.id,
  organizationId: stateVersions.organizationId,
  projectId: stateVersions.projectId,
  stackName: stateVersions.stackName,
  serial: stateVersions.serial,
  lineage: stateVersions.lineage,
  sizeBytes: stateVersions.sizeBytes,
  createdBy: stateVersions.createdBy,
  createdAt: stateVersions.createdAt,
};
const sealed = {
  ...visible,
  stateEnc: stateVersions.stateEnc,
  dekKeyId: stateVersions.dekKeyId,
  dekWrapped: stateVersions.dekWrapped,
};

// What the state and its data key are bound to: a ciphertext (or a wrapped key) moved to another row, stack or
// serial does not open.
const stateAad = (v: Pick<Row, "organizationId" | "projectId" | "stackName" | "serial" | "id">) =>
  aad("state_version", v.organizationId, v.projectId, v.stackName, String(v.serial), v.id);
const keyContext = (id: string) => `state-version:${id}`;

export { keyContext as stateKeyContext }; // `rewrap.ts` needs the same context to move a key

const inStack = (ref: StateRef) =>
  and(
    eq(stateVersions.organizationId, ref.organizationId),
    eq(stateVersions.projectId, ref.projectId),
    eq(stateVersions.stackName, ref.stackName),
  );

async function open(keys: KeyProvider, row: Row): Promise<string> {
  const dek = await unwrapDek(
    keys,
    { keyId: row.dekKeyId, wrapped: row.dekWrapped },
    keyContext(row.id),
  );
  return decrypt(dek, row.stateEnc, stateAad(row));
}

export type PutStateResult =
  | { ok: true; version: StateVersion; unchanged: boolean }
  | {
      ok: false;
      reason:
        | "invalid"
        | "too_large"
        | "serial_too_low"
        | "lineage_changed"
        | "serial_conflict"
        | "not_empty";
      /** The newest version's serial and lineage, for refusals that compare against it. */
      latest?: { serial: number; lineage: string };
    };

/**
 * Stores `content` as the next version of the stack. Refused, with nothing written: a serial lower than the
 * newest version's, a lineage that is not the newest version's, the newest version's serial with other content,
 * and more than `MAX_STATE_BYTES`. The newest version's serial with the same content is a retry: accepted,
 * nothing new written. The newest `STATE_RETENTION` versions are kept; older ones go in the same transaction.
 * The first write of a stack may carry any serial and lineage. With `onlyIfEmpty` (an import) it is *only* ever a
 * first write: a stack that has any version refuses it with `not_empty`, a retry of the same version included, and
 * of two such writes at once exactly one is stored. `content` is stored as it is: that it is Terraform
 * state is the caller's to check, and so is that `resources` is what it holds. The stack's resource index is
 * replaced with `resources` in the same transaction as the version, so the two cannot disagree: an index that
 * cannot be written (the same address twice) fails the write, and no version stays.
 */
export async function putState(
  db: Executor,
  keys: KeyProvider,
  ref: StateRef,
  input: {
    serial: number;
    lineage: string;
    content: string;
    createdBy: string;
    /** The identity of every resource instance in `content`: the index of this version (`parseStateResources`). */
    resources: readonly StateResource[];
    /** Store it only if the stack has no version: nothing is compared, retried or replaced. */
    onlyIfEmpty?: boolean;
  },
): Promise<PutStateResult> {
  const { serial, lineage, content, createdBy, resources } = input;
  if (
    !Number.isInteger(serial) ||
    serial < 0 ||
    serial > 2 ** 31 - 1 ||
    lineage.length < 1 ||
    lineage.length > 256
  ) {
    return { ok: false, reason: "invalid" };
  }
  const sizeBytes = Buffer.byteLength(content);
  if (sizeBytes > MAX_STATE_BYTES) return { ok: false, reason: "too_large" };

  const id = Bun.randomUUIDv7(); // the id is part of what the ciphertext is bound to
  const dek = generateDek();
  const wrap = await wrapDek(keys, dek, keyContext(id));
  const stateEnc = encrypt(dek, content, stateAad({ ...ref, serial, id }));

  return db.transaction(async (tx) => {
    await takeTurn(tx, ref);
    const [latest] = await tx
      .select(sealed)
      .from(stateVersions)
      .where(inStack(ref))
      .orderBy(desc(stateVersions.serial))
      .limit(1);
    if (latest && input.onlyIfEmpty) return { ok: false, reason: "not_empty" };
    if (latest) {
      const seen = { serial: latest.serial, lineage: latest.lineage };
      if (latest.lineage !== lineage) return { ok: false, reason: "lineage_changed", latest: seen };
      if (serial < latest.serial) return { ok: false, reason: "serial_too_low", latest: seen };
      if (serial === latest.serial) {
        const same = (await open(keys, latest)) === content;
        if (!same) return { ok: false, reason: "serial_conflict", latest: seen };
        const { stateEnc: _, dekKeyId: __, dekWrapped: ___, ...version } = latest;
        return { ok: true, version, unchanged: true };
      }
    }
    const [version] = await tx
      .insert(stateVersions)
      .values({
        id,
        ...ref,
        serial,
        lineage,
        stateEnc,
        dekKeyId: wrap.keyId,
        dekWrapped: wrap.wrapped,
        sizeBytes,
        createdBy,
      })
      .returning(visible);
    if (!version) throw new Error("insert returned no row");
    await tx
      .delete(stateResources)
      .where(
        and(
          eq(stateResources.projectId, ref.projectId),
          eq(stateResources.stackName, ref.stackName),
        ),
      );
    // Postgres takes at most 65535 parameters in a statement: 11 per row, so in batches
    for (let i = 0; i < resources.length; i += INDEX_BATCH) {
      await tx.insert(stateResources).values(
        resources.slice(i, i + INDEX_BATCH).map((r) => ({
          ...r,
          ...ref,
          versionId: version.id,
        })),
      );
    }
    // the oldest version kept is the STATE_RETENTION-th newest; everything below it goes
    const [oldestKept] = await tx
      .select({ serial: stateVersions.serial })
      .from(stateVersions)
      .where(inStack(ref))
      .orderBy(desc(stateVersions.serial))
      .offset(STATE_RETENTION - 1)
      .limit(1);
    if (oldestKept) {
      await tx
        .delete(stateVersions)
        .where(and(inStack(ref), sql`${stateVersions.serial} < ${oldestKept.serial}`));
    }
    return { ok: true, version, unchanged: false };
  });
}

/** The newest version of the stack, opened. The only way the state's content leaves the table. */
export async function readState(
  db: Executor,
  keys: KeyProvider,
  ref: StateRef,
): Promise<{ version: StateVersion; content: string } | undefined> {
  const [row] = await db
    .select(sealed)
    .from(stateVersions)
    .where(inStack(ref))
    .orderBy(desc(stateVersions.serial))
    .limit(1);
  if (!row) return undefined;
  const { stateEnc: _, dekKeyId: __, dekWrapped: ___, ...version } = row;
  return { version, content: await open(keys, row) };
}

/** The stack's versions, newest first, with no content. */
export function listStateVersions(db: Executor, ref: StateRef): Promise<StateVersion[]> {
  return db
    .select(visible)
    .from(stateVersions)
    .where(inStack(ref))
    .orderBy(desc(stateVersions.serial));
}

/** Deletes every version of the stack; how many there were. The next write starts the stack over. */
export async function deleteState(db: Executor, ref: StateRef): Promise<number> {
  return db.transaction(async (tx) => {
    await takeTurn(tx, ref);
    const gone = await tx
      .delete(stateVersions)
      .where(inStack(ref))
      .returning({ id: stateVersions.id });
    return gone.length;
  });
}

/** What `listStateResources` narrows by. `module: null` is the root module; left out, any. */
export interface StateResourceFilter {
  type?: string;
  provider?: string;
  module?: string | null;
  /** Continue after this address (the last of the page before). */
  after?: string | undefined;
  limit: number;
}

/**
 * The resources of the stack's newest version, by address: identity only (STATE-6). Every filter is an exact
 * value, never a pattern.
 */
export async function listStateResources(
  db: Executor,
  ref: StateRef,
  f: StateResourceFilter,
): Promise<StateResource[]> {
  const rows = await db
    .select({
      address: stateResources.address,
      mode: stateResources.mode,
      type: stateResources.type,
      name: stateResources.name,
      provider: stateResources.provider,
      module: stateResources.module,
      indexKey: stateResources.indexKey,
    })
    .from(stateResources)
    .where(
      and(
        eq(stateResources.organizationId, ref.organizationId),
        eq(stateResources.projectId, ref.projectId),
        eq(stateResources.stackName, ref.stackName),
        f.type === undefined ? undefined : eq(stateResources.type, f.type),
        f.provider === undefined ? undefined : eq(stateResources.provider, f.provider),
        f.module === undefined
          ? undefined
          : f.module === null
            ? isNull(stateResources.module)
            : eq(stateResources.module, f.module),
        f.after === undefined ? undefined : gt(stateResources.address, f.after),
      ),
    )
    .orderBy(asc(stateResources.address))
    .limit(f.limit);
  return rows.map((r) => ({ ...r, mode: r.mode === "data" ? "data" : "managed" }));
}
