import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { type AuditContext, AuditError, audit, checkMetadata, type Tx } from "./audit";
import { pgCode } from "./pg-error";
import { createOrganization, deleteOrganization } from "./repo";
import { auditEvents, organizations } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const CTX: AuditContext = {
  actor: { kind: "dev", id: "dev" },
  requestId: "req-1",
  ip: "203.0.113.7",
};
const EVENT = { action: "project.create", resourceType: "project", resourceId: "p-1" };
const write = (e: Partial<Parameters<typeof audit>[2]> = {}, ctx = CTX) =>
  t.db.transaction((tx) => audit(tx, ctx, { ...EVENT, ...e }));
const rows = (resourceId: string) =>
  t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, resourceId));
const uniq = () => crypto.randomUUID().slice(0, 8);
const msg = async (p: Promise<unknown>) => String(await p.catch((e) => e));

describe("audit()", () => {
  test("stores the event with its context and a time-ordered id", async () => {
    const orgId = Bun.randomUUIDv7();
    const id = `p-${uniq()}`;
    await write({
      resourceId: id,
      organizationId: orgId,
      projectId: Bun.randomUUIDv7(),
      metadata: { keys: ["DB_URL"], count: 1 },
    });
    const [row] = await rows(id);
    expect(row).toMatchObject({
      actorKind: "dev",
      actorId: "dev",
      action: "project.create",
      resourceType: "project",
      organizationId: orgId,
      metadata: { keys: ["DB_URL"], count: 1 },
      requestId: "req-1",
      ip: "203.0.113.7",
    });
    expect(row?.id[14]).toBe("7");
    expect(row?.at).toBeInstanceOf(Date);
  });

  test("optional parts default to null and empty metadata", async () => {
    const id = `p-${uniq()}`;
    await write({ resourceId: id }, { actor: { kind: "user", id: "u-1" } });
    expect((await rows(id))[0]).toMatchObject({
      organizationId: null,
      projectId: null,
      requestId: null,
      ip: null,
      metadata: {},
    });
  });

  test("commits with the change it records, and rolls back with it", async () => {
    const slug = `org-${uniq()}`;
    const failed = t.db.transaction(async (tx) => {
      const org = await createOrganization(tx, { slug, name: "O" });
      await audit(tx, CTX, { ...EVENT, resourceId: `rb-${slug}`, organizationId: org.id });
      throw new Error("mutation failed");
    });
    expect(await msg(failed)).toContain("mutation failed");
    expect(await t.db.select().from(organizations).where(eq(organizations.slug, slug))).toEqual([]);
    expect(await rows(`rb-${slug}`)).toEqual([]);

    await t.db.transaction(async (tx) => {
      const org = await createOrganization(tx, { slug: `ok-${slug}`, name: "O" });
      await audit(tx, CTX, { ...EVENT, resourceId: `ok-${slug}`, organizationId: org.id });
    });
    expect(await rows(`ok-${slug}`)).toHaveLength(1);
  });

  test("refuses to run outside a transaction", async () => {
    const id = `p-${uniq()}`;
    const err = await audit(t.db as unknown as Tx, CTX, { ...EVENT, resourceId: id }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AuditError);
    expect(await rows(id)).toEqual([]);
  });

  test("rejects malformed actions, types and actors, writing nothing", async () => {
    const id = `p-${uniq()}`;
    for (const bad of [
      { action: "create" },
      { action: "Project.Create" },
      { action: "project.create; drop" },
      { resourceType: "Project" },
      { resourceType: "" },
    ]) {
      expect(await write({ ...bad, resourceId: id }).catch((e) => e)).toBeInstanceOf(AuditError);
    }
    const noActor = { actor: { kind: "", id: "x" } };
    expect(await write({ resourceId: id }, noActor).catch((e) => e)).toBeInstanceOf(AuditError);
    expect(await rows(id)).toEqual([]);
  });
});

describe("append-only", () => {
  test("UPDATE, DELETE and TRUNCATE are rejected and change nothing", async () => {
    const id = `p-${uniq()}`;
    await write({ resourceId: id, metadata: { n: 1 } });
    const attempts = [
      t.db.update(auditEvents).set({ action: "x.y" }).where(eq(auditEvents.resourceId, id)),
      t.db.delete(auditEvents).where(eq(auditEvents.resourceId, id)),
      t.db.execute(sql`TRUNCATE audit_events`),
      t.db.execute(sql`UPDATE audit_events SET metadata = '{}' WHERE resource_id = ${id}`),
    ];
    for (const attempt of attempts) {
      const err = await attempt.then(
        () => undefined,
        (e) => e,
      );
      expect(pgCode(err)).toBe("55000");
    }
    expect((await rows(id))[0]).toMatchObject({ action: "project.create", metadata: { n: 1 } });
  });

  test("events outlive the organization they name", async () => {
    const org = await createOrganization(t.db, { slug: `gone-${uniq()}`, name: "G" });
    const id = `p-${uniq()}`;
    await write({ resourceId: id, organizationId: org.id });
    expect(await deleteOrganization(t.db, org.id)).toBe(true);
    expect(await rows(id)).toHaveLength(1);
  });
});

describe("metadata guard", () => {
  test("rejects keys that would hold a secret, at any depth", () => {
    for (const key of [
      "value",
      "Value",
      "values",
      "newValue",
      "old_value",
      "secret",
      "client-secret",
      "secretValue",
      "token",
      "access_token",
      "password",
      "apiKey",
      "api_key",
      "private-key",
      "Authorization",
      "ciphertext",
      "valueChanged",
    ]) {
      expect(() => checkMetadata({ [key]: "x" })).toThrow(AuditError);
      expect(() => checkMetadata({ change: { [key]: 1 } })).toThrow(AuditError);
      expect(() => checkMetadata({ list: [{ [key]: 1 }] })).toThrow(AuditError);
    }
  });

  test("accepts ids, key names, counts and flags", () => {
    const ok = {
      key: "DB_URL",
      keys: ["A", "B"],
      variable_key: "TOKEN_NAME",
      count: 3,
      secret_count: 1,
      tokenId: "t-1",
      value_length: 12,
      scope: "production",
      changed: ["description"],
      protected: true,
      from: null,
      renamed: { from: "A", to: "B" },
    };
    expect(checkMetadata(ok)).toBe(ok);
  });

  test("rejects what is not small, plain JSON", () => {
    const bad: unknown[] = [
      { s: "x".repeat(257) },
      { a: Array.from({ length: 101 }, (_, i) => i) },
      { a: { b: { c: { d: 1 } } } },
      { when: new Date() },
      { n: 10n },
      { f: () => 1 },
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { c: new (class X {})() },
      { big: Array.from({ length: 100 }, (_, i) => `${"y".repeat(60)}${i}`) },
    ];
    for (const m of bad)
      expect(() => checkMetadata(m as Record<string, unknown>)).toThrow(AuditError);
  });

  test("undefined members are dropped, as JSON does", () => {
    expect(() => checkMetadata({ a: undefined, b: 1 })).not.toThrow();
  });

  test("a refused write names the key, never the value, and stores nothing", async () => {
    const CANARY = "SECRET-CANARY-7731";
    const id = `p-${uniq()}`;
    const text = await msg(write({ resourceId: id, metadata: { value: CANARY } }));
    expect(text).toContain('"value"');
    expect(text).not.toContain(CANARY);
    expect(await rows(id)).toEqual([]);
  });
});
