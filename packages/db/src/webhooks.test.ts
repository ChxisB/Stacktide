import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq, sql } from "drizzle-orm";
import { createConnection, deleteConnection, getConnection, listConnections } from "./connections";
import { JobError } from "./jobs";
import { createOrganization } from "./repo";
import { jobs, webhookDeliveries } from "./schema";
import { createTestDb, type TestDb } from "./testing";
import { recordDelivery, setWebhookSecretHash, WEBHOOK_QUEUE, webhookTarget } from "./webhooks";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
let n = 0;
const make = async () => {
  const o = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const c = await createConnection(t.db, keys, {
    organizationId: o.id,
    type: "gitlab",
    name: `c${++n}`,
    token: "glpat-SECRET-TOKEN-0123456789",
  });
  return { o, c };
};
const jobsOf = async () => t.db.select().from(jobs).where(eq(jobs.queue, WEBHOOK_QUEUE));
const HASH = "a".repeat(64);

describe("webhook secret", () => {
  test("a new connection takes no webhooks; setting a hash is scoped to the organization", async () => {
    const { o, c } = await make();
    expect(await webhookTarget(t.db, c.id)).toEqual({
      organizationId: o.id,
      type: "gitlab",
      secretHash: null,
    });

    const other = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
    expect(await setWebhookSecretHash(t.db, other.id, c.id, HASH)).toBe(false);
    expect((await webhookTarget(t.db, c.id))?.secretHash).toBeNull();

    expect(await setWebhookSecretHash(t.db, o.id, c.id, HASH)).toBe(true);
    expect((await webhookTarget(t.db, c.id))?.secretHash).toBe(HASH);
    expect(await setWebhookSecretHash(t.db, o.id, c.id, "b".repeat(64))).toBe(true); // rotation
    expect((await webhookTarget(t.db, c.id))?.secretHash).toBe("b".repeat(64));
  });

  test("an unknown connection has no target", async () => {
    expect(await webhookTarget(t.db, Bun.randomUUIDv7())).toBeUndefined();
    expect(await setWebhookSecretHash(t.db, Bun.randomUUIDv7(), Bun.randomUUIDv7(), HASH)).toBe(
      false,
    );
  });

  test("the hash is not part of what connections show", async () => {
    const { o, c } = await make();
    await setWebhookSecretHash(t.db, o.id, c.id, HASH);
    const [got, [listed]] = [
      await getConnection(t.db, o.id, c.id),
      await listConnections(t.db, o.id, { limit: 5 }),
    ];
    for (const row of [got, listed]) {
      expect(JSON.stringify(row)).not.toContain(HASH);
      expect(Object.keys(row ?? {})).not.toContain("webhookSecretHash");
    }
  });
});

describe("recordDelivery", () => {
  const input = (connectionId: string, deliveryId: string | undefined, event = "push") => ({
    connectionId,
    deliveryId,
    event,
    payload: { connectionId, event, deliveryId: deliveryId ?? null, projectId: 7 },
  });

  test("one job per delivery id: a repeat is a duplicate and adds nothing", async () => {
    const { c } = await make();
    expect(await recordDelivery(t.db, input(c.id, "d1"))).toBe("queued");
    expect(await recordDelivery(t.db, input(c.id, "d1"))).toBe("duplicate");
    expect(await recordDelivery(t.db, input(c.id, "d1", "pipeline"))).toBe("duplicate");
    const mine = (await jobsOf()).filter((j) => j.payload.connectionId === c.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.payload).toMatchObject({ event: "push", projectId: 7 });
    const [row] = await t.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, c.id));
    expect(row).toMatchObject({ deliveryId: "d1", event: "push", jobId: mine[0]?.id });
  });

  test("the same id on another connection is another delivery", async () => {
    const [a, b] = [await make(), await make()];
    expect(await recordDelivery(t.db, input(a.c.id, "same"))).toBe("queued");
    expect(await recordDelivery(t.db, input(b.c.id, "same"))).toBe("queued");
    for (const { c } of [a, b]) {
      const [row] = await t.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.connectionId, c.id));
      const mine = (await jobsOf()).filter((j) => j.payload.connectionId === c.id);
      expect(mine).toHaveLength(1);
      expect(row?.jobId).toBe(mine[0]?.id); // each delivery points at its own job
    }
  });

  test("two requests at once still make one job", async () => {
    const { c } = await make();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => recordDelivery(t.db, input(c.id, "race"))),
    );
    expect(results.filter((r) => r === "queued")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(5);
    expect((await jobsOf()).filter((j) => j.payload.connectionId === c.id)).toHaveLength(1);
  });

  test("without a delivery id nothing is deduped", async () => {
    const { c } = await make();
    expect(await recordDelivery(t.db, input(c.id, undefined))).toBe("queued");
    expect(await recordDelivery(t.db, input(c.id, undefined))).toBe("queued");
    expect((await jobsOf()).filter((j) => j.payload.connectionId === c.id)).toHaveLength(2);
    const rows = await t.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, c.id));
    expect(rows).toHaveLength(0);
  });

  test("a payload the queue refuses leaves no delivery row, so the retry works", async () => {
    const { c } = await make();
    const bad = { ...input(c.id, "d2"), payload: { password: "x" } };
    await expect(recordDelivery(t.db, bad)).rejects.toBeInstanceOf(JobError);
    const rows = await t.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, c.id));
    expect(rows).toHaveLength(0);
    expect(await recordDelivery(t.db, input(c.id, "d2"))).toBe("queued");
  });

  test("deleting the connection removes its delivery rows, not the jobs", async () => {
    const { o, c } = await make();
    await recordDelivery(t.db, input(c.id, "d3"));
    expect(await deleteConnection(t.db, o.id, c.id)).toBe(true);
    const [{ count }] = (await t.db.execute(
      sql`SELECT count(*)::int AS count FROM webhook_deliveries WHERE connection_id = ${c.id}`,
    )) as [{ count: number }];
    expect(count).toBe(0);
    expect((await jobsOf()).some((j) => j.payload.connectionId === c.id)).toBe(true);
  });
});
