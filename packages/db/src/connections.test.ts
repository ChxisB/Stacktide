import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { aad, CryptoError, encrypt, envKeyProvider, generateDek, wrapDek } from "@orch/crypto";
import { eq, sql } from "drizzle-orm";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  openConnection,
} from "./connections";
import { pgConstraint } from "./pg-error";
import { createOrganization, deleteOrganization } from "./repo";
import { connections } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const keys = envKeyProvider(`k2:${key(2)},k1:${key(1)}`);
const TOKEN = "glpat-SECRET-TOKEN-0123456789";

let n = 0;
const org = () => createOrganization(t.db, { slug: `o${++n}`, name: "O" });
const make = async (organizationId: string, over: { name?: string; token?: string } = {}) =>
  createConnection(t.db, keys, {
    organizationId,
    type: "gitlab",
    name: over.name ?? `c${++n}`,
    config: { baseUrl: "https://gitlab.example.com" },
    token: over.token ?? TOKEN,
  });
const raw = async (id: string) =>
  (await t.db.execute(sql`SELECT * FROM connections WHERE id = ${id}`))[0] as Record<
    string,
    unknown
  >;

describe("connections at rest", () => {
  test("the token is encrypted: a raw read of the row holds no plaintext", async () => {
    const c = await make((await org()).id);
    const row = await raw(c.id);
    const bytes = (v: unknown) => Buffer.from(v as Uint8Array).toString("latin1");
    for (const value of Object.values(row)) {
      expect(JSON.stringify(value) + bytes(value)).not.toContain(TOKEN);
    }
    expect(Buffer.from(row.secret_enc as Uint8Array).length).toBeGreaterThan(TOKEN.length);
    expect(row.dek_key_id).toBe("k2"); // wrapped by the master key that wraps new keys
  });

  test("the token comes back through openConnection, and only there", async () => {
    const o = await org();
    const c = await make(o.id);
    const opened = await openConnection(t.db, keys, o.id, c.id);
    expect(opened?.token).toBe(TOKEN);
    expect(opened?.connection).toEqual(c);
    // No view of a connection holds a secret column.
    const shown = [c, opened?.connection, await getConnection(t.db, o.id, c.id)];
    for (const view of shown) {
      expect(Object.keys(view ?? {}).sort()).toEqual(
        ["config", "createdAt", "id", "name", "organizationId", "type", "updatedAt"].sort(),
      );
    }
    const listed = await listConnections(t.db, o.id, { limit: 10 });
    expect(Object.keys(listed[0] ?? {})).not.toContain("secretEnc");
    expect(JSON.stringify([shown, listed])).not.toContain(TOKEN);
  });

  test("each connection has its own data key, and a nonce per seal", async () => {
    const o = await org();
    const [a, b] = [await make(o.id), await make(o.id)];
    const [ra, rb] = [await raw(a.id), await raw(b.id)];
    expect(
      Buffer.from(ra.dek_wrapped as Uint8Array).equals(Buffer.from(rb.dek_wrapped as Uint8Array)),
    ).toBe(false);
    expect(
      Buffer.from(ra.secret_enc as Uint8Array).equals(Buffer.from(rb.secret_enc as Uint8Array)),
    ).toBe(false);
  });

  test("a secret moved to another connection, or organization, does not open", async () => {
    const [o1, o2] = [await org(), await org()];
    const [a, b] = [await make(o1.id, { token: "token-of-a-0123456" }), await make(o1.id)];
    const stolen = await raw(a.id);
    // Same organization, other row: the sealed token and its key both belong to `a`.
    await t.db.execute(
      sql`UPDATE connections SET secret_enc = ${stolen.secret_enc as Uint8Array} WHERE id = ${b.id}`,
    );
    await expect(openConnection(t.db, keys, o1.id, b.id)).rejects.toMatchObject({
      code: "decrypt_failed",
    });
    // Another organization: the row moved over with its key still names the first one.
    const c = await make(o1.id);
    await t.db.execute(sql`UPDATE connections SET organization_id = ${o2.id} WHERE id = ${c.id}`);
    await expect(openConnection(t.db, keys, o2.id, c.id)).rejects.toBeInstanceOf(CryptoError);
  });

  test("the secret and its data key are each bound to their own row", async () => {
    const o = await org();
    const [a, b] = [await make(o.id), await make(o.id)];
    const secret = "bound-token-0123456789";
    // Rebuild b's key and secret by hand, with one binding at a time pointing at a.
    const seal = async (keyFor: string, secretFor: string) => {
      const dek = generateDek();
      const wrap = await wrapDek(keys, dek, `connection:${keyFor}`);
      await t.db
        .update(connections)
        .set({
          secretEnc: encrypt(dek, secret, aad("connection", o.id, secretFor)),
          dekKeyId: wrap.keyId,
          dekWrapped: wrap.wrapped,
        })
        .where(eq(connections.id, b.id));
    };
    await seal(b.id, b.id); // sanity: built right, it opens
    expect((await openConnection(t.db, keys, o.id, b.id))?.token).toBe(secret);
    await seal(b.id, a.id); // a secret sealed for another row
    await expect(openConnection(t.db, keys, o.id, b.id)).rejects.toBeInstanceOf(CryptoError);
    await seal(a.id, b.id); // a data key wrapped for another row
    await expect(openConnection(t.db, keys, o.id, b.id)).rejects.toBeInstanceOf(CryptoError);
  });

  test("a tampered ciphertext, a wrong master key and a dropped master key fail without the token", async () => {
    const o = await org();
    const c = await make(o.id);
    const wrong = envKeyProvider(`k2:${key(9)},k1:${key(1)}`);
    const dropped = envKeyProvider(`k3:${key(3)}`);
    for (const [provider, code] of [
      [wrong, "decrypt_failed"],
      [dropped, "unknown_key"],
    ] as const) {
      const e = await openConnection(t.db, provider, o.id, c.id).catch((x) => x);
      expect(e).toMatchObject({ code });
      expect(String(e.message)).not.toContain(TOKEN);
    }
    await t.db.execute(
      sql`UPDATE connections SET secret_enc = set_byte(secret_enc, 20, get_byte(secret_enc, 20) # 1) WHERE id = ${c.id}`,
    );
    await expect(openConnection(t.db, keys, o.id, c.id)).rejects.toMatchObject({
      code: "decrypt_failed",
    });
  });

  test("a key that is no longer the newest still opens what it wrapped", async () => {
    const o = await org();
    const old = envKeyProvider(`k1:${key(1)}`);
    const c = await createConnection(t.db, old, {
      organizationId: o.id,
      type: "gitlab",
      name: "old",
      token: TOKEN,
    });
    expect((await raw(c.id)).dek_key_id).toBe("k1");
    expect((await openConnection(t.db, keys, o.id, c.id))?.token).toBe(TOKEN);
  });
});

describe("connection rules", () => {
  test("names are unique per organization, not across them", async () => {
    const [o1, o2] = [await org(), await org()];
    await make(o1.id, { name: "main" });
    const e = await make(o1.id, { name: "main" }).catch((x) => x);
    expect(pgConstraint(e)).toBe("connections_org_name_key");
    await make(o2.id, { name: "main" });
  });

  test("the type is a short lower-case word", async () => {
    const o = await org();
    for (const type of ["", "GitLab", "git lab", "1git", "a".repeat(33)]) {
      const e = await createConnection(t.db, keys, {
        organizationId: o.id,
        type,
        name: `t${++n}`,
        token: TOKEN,
      }).catch((x) => x);
      expect(pgConstraint(e)).toBe("connections_type_check");
    }
  });

  test("lookups are scoped to the organization", async () => {
    const [o1, o2] = [await org(), await org()];
    const c = await make(o1.id);
    expect(await getConnection(t.db, o2.id, c.id)).toBeUndefined();
    expect(await openConnection(t.db, keys, o2.id, c.id)).toBeUndefined();
    expect(await deleteConnection(t.db, o2.id, c.id)).toBe(false);
    expect(await listConnections(t.db, o2.id, { limit: 10 })).toEqual([]);
    expect(await getConnection(t.db, o1.id, c.id)).toBeDefined();
  });

  test("lists in creation order and pages by id", async () => {
    const o = await org();
    const made = [await make(o.id), await make(o.id), await make(o.id)];
    const first = await listConnections(t.db, o.id, { limit: 2 });
    const rest = await listConnections(t.db, o.id, { after: first[1]?.id, limit: 2 });
    expect([...first, ...rest].map((c) => c.id)).toEqual(made.map((c) => c.id));
  });

  test("delete removes the row, once", async () => {
    const o = await org();
    const c = await make(o.id);
    expect(await deleteConnection(t.db, o.id, c.id)).toBe(true);
    expect(await deleteConnection(t.db, o.id, c.id)).toBe(false);
    expect(await t.db.select().from(connections).where(eq(connections.id, c.id))).toEqual([]);
  });

  test("an organization with connections cannot be deleted until they are", async () => {
    const o = await org();
    const c = await make(o.id);
    const e = await deleteOrganization(t.db, o.id).catch((x) => x);
    expect(pgConstraint(e)).toBe("connections_organization_id_organizations_id_fk");
    await deleteConnection(t.db, o.id, c.id);
    expect(await deleteOrganization(t.db, o.id)).toBe(true);
  });

  test("updated_at moves on update (the trigger)", async () => {
    const c = await make((await org()).id);
    await Bun.sleep(5);
    await t.db.update(connections).set({ name: "renamed" }).where(eq(connections.id, c.id));
    const after = await getConnection(t.db, c.organizationId, c.id);
    expect(after?.updatedAt.getTime()).toBeGreaterThan(c.updatedAt.getTime());
  });
});
