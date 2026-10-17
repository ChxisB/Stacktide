import {
  aad,
  decrypt,
  encrypt,
  generateDek,
  type KeyProvider,
  unwrapDek,
  wrapDek,
} from "@orch/crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Executor, Page } from "./repo";
import { connections } from "./schema";

/**
 * Everything callers get to see of a connection: no secret, no data key, no ciphertext. A column
 * added to the table must be listed here (the `Connection` type fails to compile until it is).
 */
const visible = {
  id: connections.id,
  organizationId: connections.organizationId,
  type: connections.type,
  name: connections.name,
  config: connections.config,
  createdAt: connections.createdAt,
  updatedAt: connections.updatedAt,
};
export type Connection = Omit<
  typeof connections.$inferSelect,
  "secretEnc" | "dekKeyId" | "dekWrapped" | "webhookSecretHash"
>;

// What the secret and the data key are bound to: a ciphertext (or a wrapped key) moved to
// another row, or to another organization's row, does not open.
const secretAad = (organizationId: string, id: string) => aad("connection", organizationId, id);
const keyContext = (id: string) => `connection:${id}`;

const inOrg = (organizationId: string, id: string) =>
  and(eq(connections.id, id), eq(connections.organizationId, organizationId));

/**
 * Stores a connection. `token` is sealed with a data key made for this connection, and that key is
 * wrapped by the provider's current master key: the plaintext is never written anywhere.
 */
export async function createConnection(
  db: Executor,
  keys: KeyProvider,
  input: {
    organizationId: string;
    type: string;
    name: string;
    config?: Record<string, unknown>;
    token: string;
  },
): Promise<Connection> {
  const id = Bun.randomUUIDv7(); // the ids are part of what the ciphertext is bound to
  const dek = generateDek();
  const wrap = await wrapDek(keys, dek, keyContext(id));
  const [row] = await db
    .insert(connections)
    .values({
      id,
      organizationId: input.organizationId,
      type: input.type,
      name: input.name,
      config: input.config ?? {},
      secretEnc: encrypt(dek, input.token, secretAad(input.organizationId, id)),
      dekKeyId: wrap.keyId,
      dekWrapped: wrap.wrapped,
    })
    .returning(visible);
  if (!row) throw new Error("insert returned no row");
  return row;
}

export async function getConnection(db: Executor, organizationId: string, id: string) {
  return (await db.select(visible).from(connections).where(inOrg(organizationId, id)))[0];
}

/** Ordered by id (a v7 uuid: creation order to the millisecond, not a strict guarantee). */
export function listConnections(db: Executor, organizationId: string, page: Page<string>) {
  return db
    .select(visible)
    .from(connections)
    .where(
      and(
        eq(connections.organizationId, organizationId),
        page.after ? gt(connections.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(connections.id))
    .limit(page.limit);
}

/** True when a row was deleted. */
export async function deleteConnection(db: Executor, organizationId: string, id: string) {
  const rows = await db
    .delete(connections)
    .where(inOrg(organizationId, id))
    .returning({ id: connections.id });
  return rows.length > 0;
}

/**
 * The one way to get a connection's secret back, for the code that uses it to talk to the outside
 * system. The plaintext must go nowhere else: not a log, an error, an audit row or a response.
 * Throws a `CryptoError` when the master key is gone or the row was tampered with.
 */
export async function openConnection(
  db: Executor,
  keys: KeyProvider,
  organizationId: string,
  id: string,
): Promise<{ connection: Connection; token: string } | undefined> {
  const [row] = await db
    .select({
      ...visible,
      secretEnc: connections.secretEnc,
      dekKeyId: connections.dekKeyId,
      dekWrapped: connections.dekWrapped,
    })
    .from(connections)
    .where(inOrg(organizationId, id));
  if (!row) return undefined;
  const dek = await unwrapDek(
    keys,
    { keyId: row.dekKeyId, wrapped: row.dekWrapped },
    keyContext(row.id),
  );
  const { secretEnc, dekKeyId: _k, dekWrapped: _w, ...connection } = row;
  return { connection, token: decrypt(dek, secretEnc, secretAad(row.organizationId, row.id)) };
}
