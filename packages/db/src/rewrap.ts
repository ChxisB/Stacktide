import { CryptoError, type KeyProvider, rewrapDek, unwrapDek, type WrappedDek } from "@orch/crypto";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { connectionKeyContext } from "./connections";
import { sinkKeyContext } from "./notifications";
import type { Executor } from "./repo";
import { connections, notificationSinks, variableKeys } from "./schema";
import { variableKeyContext } from "./variables";

/**
 * Every secret the platform stores is sealed with a data key (DEK), and a DEK is stored wrapped by a master
 * key in exactly these tables (ADR-0007). Moving to a new master key is moving these wraps; no value is
 * re-encrypted. Pending change-request values and audit-forwarding sinks are sealed with the keys of
 * `variable_keys` and `notification_sinks`, so they are covered.
 */
export const KEY_TABLES = ["variable_keys", "connections", "notification_sinks"] as const;
export type KeyTable = (typeof KEY_TABLES)[number];

/** Master key id -> how many data keys it wraps, per table. */
export type KeyUsage = Record<KeyTable, Record<string, number>>;

export interface RewrapReport {
  /** Data keys moved to the current master key. */
  rewrapped: Record<KeyTable, number>;
  /** Data keys left as they were: the code says why. It carries no key material. */
  failed: { table: KeyTable; id: string; code: string }[];
}

const NIL = "00000000-0000-0000-0000-000000000000";

interface Sealed {
  id: string;
  keyId: string;
  wrapped: Uint8Array;
  context: string;
}

interface Source {
  /** Up to `limit` wraps not on `current`, after `after` in id order. */
  read(current: string, after: string, limit: number): Promise<Sealed[]>;
  /** Replaces the wrap if it is still exactly the one that was read; false when someone else got there first. */
  write(row: Sealed, next: WrappedDek): Promise<boolean>;
}

const sources = (db: Executor): Record<KeyTable, Source> => ({
  variable_keys: {
    async read(current, after, limit) {
      const rows = await db
        .select({
          id: variableKeys.id,
          organizationId: variableKeys.organizationId,
          projectId: variableKeys.projectId,
          keyId: variableKeys.dekKeyId,
          wrapped: variableKeys.dekWrapped,
        })
        .from(variableKeys)
        .where(and(ne(variableKeys.dekKeyId, current), gt(variableKeys.id, after)))
        .orderBy(asc(variableKeys.id))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        keyId: r.keyId,
        wrapped: r.wrapped,
        context: variableKeyContext(
          r.projectId
            ? { organizationId: r.organizationId, projectId: r.projectId }
            : { organizationId: r.organizationId },
        ),
      }));
    },
    async write(row, next) {
      const done = await db
        .update(variableKeys)
        .set({ dekKeyId: next.keyId, dekWrapped: next.wrapped })
        .where(
          and(
            eq(variableKeys.id, row.id),
            eq(variableKeys.dekKeyId, row.keyId),
            eq(variableKeys.dekWrapped, row.wrapped),
          ),
        )
        .returning({ id: variableKeys.id });
      return done.length > 0;
    },
  },
  connections: {
    async read(current, after, limit) {
      const rows = await db
        .select({
          id: connections.id,
          keyId: connections.dekKeyId,
          wrapped: connections.dekWrapped,
        })
        .from(connections)
        .where(and(ne(connections.dekKeyId, current), gt(connections.id, after)))
        .orderBy(asc(connections.id))
        .limit(limit);
      return rows.map((r) => ({ ...r, context: connectionKeyContext(r.id) }));
    },
    async write(row, next) {
      const done = await db
        .update(connections)
        .set({ dekKeyId: next.keyId, dekWrapped: next.wrapped })
        .where(
          and(
            eq(connections.id, row.id),
            eq(connections.dekKeyId, row.keyId),
            eq(connections.dekWrapped, row.wrapped),
          ),
        )
        .returning({ id: connections.id });
      return done.length > 0;
    },
  },
  notification_sinks: {
    async read(current, after, limit) {
      const rows = await db
        .select({
          id: notificationSinks.id,
          keyId: notificationSinks.dekKeyId,
          wrapped: notificationSinks.dekWrapped,
        })
        .from(notificationSinks)
        .where(and(ne(notificationSinks.dekKeyId, current), gt(notificationSinks.id, after)))
        .orderBy(asc(notificationSinks.id))
        .limit(limit);
      return rows.map((r) => ({ ...r, context: sinkKeyContext(r.id) }));
    },
    async write(row, next) {
      const done = await db
        .update(notificationSinks)
        .set({ dekKeyId: next.keyId, dekWrapped: next.wrapped })
        .where(
          and(
            eq(notificationSinks.id, row.id),
            eq(notificationSinks.dekKeyId, row.keyId),
            eq(notificationSinks.dekWrapped, row.wrapped),
          ),
        )
        .returning({ id: notificationSinks.id });
      return done.length > 0;
    },
  },
});

/**
 * Moves every data key that is not wrapped by the provider's current master key to it. Safe to repeat and
 * to run next to a running platform: a row is changed only if it still holds the wrap that was read, so two
 * runs cannot undo each other, and the new wrap is opened before it is written. A row that cannot be moved
 * (its old master key is not in the provider, or the wrap does not open) is reported and left as it was; the
 * rest still move. Anything else going wrong (the database, a key provider that cannot be reached) is not a
 * fact about a row: it stops the run, and the rows moved so far stay moved.
 */
export async function rewrapAll(
  db: Executor,
  keys: KeyProvider,
  batch = 100,
): Promise<RewrapReport> {
  const report: RewrapReport = {
    rewrapped: { variable_keys: 0, connections: 0, notification_sinks: 0 },
    failed: [],
  };
  const all = sources(db);
  for (const table of KEY_TABLES) {
    const source = all[table];
    let after = NIL; // every id is a UUID
    for (;;) {
      const rows = await source.read(keys.currentKeyId, after, batch);
      for (const row of rows) {
        try {
          const next = await rewrapDek(
            keys,
            { keyId: row.keyId, wrapped: row.wrapped },
            row.context,
          );
          await unwrapDek(keys, next, row.context);
          if (await source.write(row, next)) report.rewrapped[table]++;
        } catch (e) {
          if (!(e instanceof CryptoError)) throw e;
          report.failed.push({ table, id: row.id, code: e.code });
        }
        after = row.id;
      }
      if (rows.length < batch) break;
    }
  }
  return report;
}

/** Which master key wraps how many data keys. The old key can go when nothing is left on it. */
export async function keyUsage(db: Executor): Promise<KeyUsage> {
  const usage: KeyUsage = { variable_keys: {}, connections: {}, notification_sinks: {} };
  for (const table of KEY_TABLES) {
    const rows = await db.execute(
      sql`SELECT dek_key_id, count(*)::int AS n FROM ${sql.identifier(table)} GROUP BY dek_key_id`,
    );
    for (const r of rows) usage[table][String(r.dek_key_id)] = Number(r.n);
  }
  return usage;
}

/** How many data keys are not on `current` yet. */
export const stillOnOldKeys = (usage: KeyUsage, current: string) =>
  KEY_TABLES.reduce(
    (total, table) =>
      total + Object.entries(usage[table]).reduce((n, [id, c]) => n + (id === current ? 0 : c), 0),
    0,
  );
