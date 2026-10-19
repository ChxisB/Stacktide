import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MAX_POOLS } from "@orch/core";
import { pgConstraint } from "./pg-error";
import { createOrganization } from "./repo";
import { workerPools } from "./schema";
import { createTestDb, type TestDb } from "./testing";
import {
  allPools,
  createPool,
  defaultPool,
  deletePool,
  getPool,
  getPoolByName,
  listPools,
  updatePool,
} from "./worker-pools";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

// the functions are called in a transaction, as the routes call them: the swap of the default is several statements
const create = (input: Parameters<typeof createPool>[1]) =>
  t.db.transaction((tx) => createPool(tx, input));
const update = (o: string, id: string, patch: Parameters<typeof updatePool>[3]) =>
  t.db.transaction((tx) => updatePool(tx, o, id, patch));
const remove = (o: string, id: string) => t.db.transaction((tx) => deletePool(tx, o, id));

let n = 0;
const org = async () => (await createOrganization(t.db, { slug: `p${++n}`, name: "P" })).id;
const pool = (organizationId: string, name: string, over: object = {}) => ({
  organizationId,
  name,
  tags: ["prod-runners"],
  ...over,
});
const made = async (organizationId: string, name: string, over: object = {}) => {
  const r = await create(pool(organizationId, name, over));
  if (!r) throw new Error("no pool made");
  return r;
};
const refusedBy = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (e) {
    return pgConstraint(e);
  }
  return "accepted";
};

describe("creating a pool", () => {
  test("is enabled and not the default unless said, keeps its tags and image in order", async () => {
    const o = await org();
    const p = await made(o, "prod", { tags: ["b", "a"], image: "registry.example.com/iac:1.2" });
    expect(p).toMatchObject({
      organizationId: o,
      name: "prod",
      tags: ["b", "a"],
      image: "registry.example.com/iac:1.2",
      enabled: true,
      isDefault: false,
    });
    expect((await made(o, "plain")).image).toBeNull();
    expect(await getPool(t.db, o, p.id)).toEqual(p);
    expect(await getPoolByName(t.db, o, "prod")).toEqual(p);
  });

  test("a name is one per organization, and another organization may use it", async () => {
    const [a, b] = [await org(), await org()];
    await made(a, "shared-name");
    expect(await refusedBy(create(pool(a, "shared-name")))).toBe("worker_pools_org_name_key");
    expect((await made(b, "shared-name")).organizationId).toBe(b);
  });

  test("the table refuses a name, tag list or image that could do harm in a pipeline", async () => {
    const o = await org();
    const bad = async (over: object, name = `bad${++n}`) =>
      refusedBy(t.db.insert(workerPools).values(pool(o, name, over)));
    expect(await bad({}, "Upper")).toBe("worker_pools_check");
    expect(await bad({}, "two--dashes")).toBe("worker_pools_check");
    expect(await bad({ tags: [] })).toBe("worker_pools_check");
    expect(await bad({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).toBe(
      "worker_pools_check",
    );
    for (const tag of [
      "",
      "-lead",
      "has space",
      "a,b",
      "$VAR",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a CI variable reference is the point
      "a${B}",
      "x".repeat(65),
      "new\nline",
    ]) {
      expect([tag, await bad({ tags: [tag] })]).toEqual([tag, "worker_pools_check"]);
    }
    for (const image of [
      "",
      "$IMAGE",
      "a b",
      "user:pass@registry.example.com/img",
      "img@sha256:abc",
      "-x",
      "a\nb",
    ]) {
      expect([image, await bad({ image })]).toEqual([image, "worker_pools_check"]);
    }
    const digest = `img@sha256:${"a".repeat(64)}`;
    expect(await bad({ image: digest })).toBe("accepted");
    expect(await bad({ image: "registry.example.com:5000/team/iac:v1" })).toBe("accepted");
  });

  test("two defaults in one organization are refused, one in each is fine, and a disabled pool is never the default", async () => {
    const [a, b] = [await org(), await org()];
    await made(a, "one", { isDefault: true });
    expect(
      await refusedBy(t.db.insert(workerPools).values(pool(a, "two", { isDefault: true }))),
    ).toBe("worker_pools_one_default_key");
    expect((await made(b, "one", { isDefault: true })).isDefault).toBe(true);
    expect(
      await refusedBy(
        t.db.insert(workerPools).values(pool(a, "off", { isDefault: true, enabled: false })),
      ),
    ).toBe("worker_pools_default_enabled_check");
  });

  test(`an organization has at most ${MAX_POOLS}`, async () => {
    const o = await org();
    for (let i = 0; i < MAX_POOLS; i++) await made(o, `p${i}`);
    expect(await create(pool(o, "one-too-many"))).toBeUndefined();
    // a refused one leaves nothing behind
    expect(await getPoolByName(t.db, o, "one-too-many")).toBeUndefined();
  });
});

describe("changing a pool", () => {
  test("changes only what is given, null clears the image, and says what it was", async () => {
    const o = await org();
    const p = await made(o, "change", { image: "iac:1" });
    const r = await update(o, p.id, { tags: ["x", "y"] });
    expect(r?.row).toMatchObject({ tags: ["x", "y"], image: "iac:1", enabled: true });
    expect(r?.previous).toMatchObject({ tags: ["prod-runners"], image: "iac:1" });
    expect((await update(o, p.id, { image: null }))?.row.image).toBeNull();
    expect((await update(o, p.id, { enabled: false }))?.row.enabled).toBe(false);
    expect((await update(o, p.id, {}))?.row).toMatchObject({ tags: ["x", "y"], enabled: false });
  });

  test("another organization's pool, or none, is not found and nothing changes", async () => {
    const [a, b] = [await org(), await org()];
    const p = await made(a, "mine");
    expect(await update(b, p.id, { enabled: false })).toBeUndefined();
    expect(
      await update(a, "0190b2a0-0000-7000-8000-000000000000", { enabled: false }),
    ).toBeUndefined();
    expect((await getPool(t.db, a, p.id))?.enabled).toBe(true);
  });

  test("making a pool the default takes it from the old one in the same step: there is never none or two", async () => {
    const o = await org();
    const first = await made(o, "first", { isDefault: true });
    const second = await made(o, "second");
    const r = await update(o, second.id, { isDefault: true });
    expect(r?.row.isDefault).toBe(true);
    expect(r?.demoted?.id).toBe(first.id);
    expect((await allPools(t.db, o)).filter((p) => p.isDefault).map((p) => p.name)).toEqual([
      "second",
    ]);
    expect((await defaultPool(t.db, o))?.name).toBe("second");
    // saying it again changes nothing and demotes nobody
    const again = await update(o, second.id, { isDefault: true });
    expect(again?.demoted).toBeUndefined();
    // and it can be cleared: stacks with no pool then have none
    expect((await update(o, second.id, { isDefault: false }))?.row.isDefault).toBe(false);
    expect(await defaultPool(t.db, o)).toBeUndefined();
  });

  test("a disabled pool cannot be made the default, and the default cannot be disabled", async () => {
    const o = await org();
    const off = await made(o, "off", { enabled: false });
    expect(await refusedBy(update(o, off.id, { isDefault: true }))).toBe(
      "worker_pools_default_enabled_check",
    );
    // the refusal rolled the demotion back with it: no default was lost
    const on = await made(o, "on", { isDefault: true });
    expect(await refusedBy(update(o, off.id, { isDefault: true }))).toBe(
      "worker_pools_default_enabled_check",
    );
    expect((await defaultPool(t.db, o))?.id).toBe(on.id);
    expect(await refusedBy(update(o, on.id, { enabled: false }))).toBe(
      "worker_pools_default_enabled_check",
    );
  });

  test("the updated time moves", async () => {
    const o = await org();
    const p = await made(o, "clock");
    await Bun.sleep(5);
    const r = await update(o, p.id, { enabled: false });
    expect(r?.row.updatedAt.getTime()).toBeGreaterThan(p.updatedAt.getTime());
  });
});

describe("removing a pool", () => {
  test("removes it and returns it; the default must be cleared first; another organization's is not found", async () => {
    const [a, b] = [await org(), await org()];
    const plain = await made(a, "plain");
    const def = await made(a, "def", { isDefault: true });
    expect(await remove(b, plain.id)).toBeUndefined();
    expect(await remove(a, def.id)).toEqual({ result: "default" });
    expect(await getPool(t.db, a, def.id)).toBeDefined();
    expect(await remove(a, plain.id)).toEqual({ result: "deleted", row: plain });
    expect(await remove(a, plain.id)).toBeUndefined();
    await update(a, def.id, { isDefault: false });
    expect((await remove(a, def.id))?.result).toBe("deleted");
  });
});

describe("listing", () => {
  test("is the organization's own, in creation order, in pages", async () => {
    const [a, b] = [await org(), await org()];
    for (const name of ["a1", "a2", "a3"]) await made(a, name);
    await made(b, "b1");
    const first = await listPools(t.db, a, { limit: 2 });
    const rest = await listPools(t.db, a, { limit: 2, after: first[1]?.id ?? "" });
    expect([...first, ...rest].map((p) => p.name)).toEqual(["a1", "a2", "a3"]);
    expect((await allPools(t.db, b)).map((p) => p.name)).toEqual(["b1"]);
  });
});
