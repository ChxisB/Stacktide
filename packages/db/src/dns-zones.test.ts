import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  claimedZones,
  createDnsZone,
  type DnsZoneInput,
  deleteDnsZone,
  listDnsZones,
} from "./dns-zones";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

let n = 0;
async function world() {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
  return { org, project };
}
const claim = (
  w: Awaited<ReturnType<typeof world>>,
  over: Partial<DnsZoneInput> = {},
): DnsZoneInput => ({
  organizationId: w.org.id,
  projectId: w.project.id,
  zone: "example.com",
  stack: "dns",
  ...over,
});
const refusedBy = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return pgConstraint(e) ?? e;
  }
  return undefined;
};
const page = { limit: 100 };

describe("claiming a zone", () => {
  test("stores the zone with its project and stack, and lists it", async () => {
    const w = await world();
    const row = await createDnsZone(t.db, claim(w));
    expect(row).toMatchObject({
      organizationId: w.org.id,
      projectId: w.project.id,
      zone: "example.com",
      stack: "dns",
    });
    expect(await listDnsZones(t.db, w.org.id, page)).toEqual([row]);
  });

  test("a zone is claimed once per organization, and another organization may claim the same name", async () => {
    const w = await world();
    await createDnsZone(t.db, claim(w));
    expect(await refusedBy(createDnsZone(t.db, claim(w, { stack: "other" })))).toBe(
      "dns_zones_org_zone_key",
    );
    const other = await world();
    await createDnsZone(t.db, claim(other));
    expect(await listDnsZones(t.db, other.org.id, page)).toHaveLength(1);
  });

  test("the project must be one of the organization's", async () => {
    const w = await world();
    const stranger = await world();
    expect(await refusedBy(createDnsZone(t.db, claim(w, { projectId: stranger.project.id })))).toBe(
      "dns_zones_project_org_fk",
    );
  });

  test("the database refuses a name that is not a zone, and a stack name that is not one", async () => {
    const w = await world();
    for (const zone of [
      "Example.com",
      "*.example.com",
      "com",
      "example.com.",
      `${"a".repeat(250)}.com`,
    ])
      expect(await refusedBy(createDnsZone(t.db, claim(w, { zone }))), zone).toBe(
        "dns_zones_check",
      );
    expect(await refusedBy(createDnsZone(t.db, claim(w, { stack: "Not A Name" })))).toBe(
      "dns_zones_check",
    );
  });
});

describe("listing", () => {
  test("pages in creation order, and only the organization's own", async () => {
    const w = await world();
    const a = await createDnsZone(t.db, claim(w, { zone: "a.example" }));
    const b = await createDnsZone(t.db, claim(w, { zone: "b.example" }));
    const c = await createDnsZone(t.db, claim(w, { zone: "c.example" }));
    await createDnsZone(t.db, claim(await world(), { zone: "z.example" }));
    expect(await listDnsZones(t.db, w.org.id, { limit: 2 })).toEqual([a, b]);
    expect(await listDnsZones(t.db, w.org.id, { after: b.id, limit: 2 })).toEqual([c]);
  });
});

describe("releasing a zone", () => {
  test("returns the claim that was deleted, and is not found in another organization", async () => {
    const w = await world();
    const row = await createDnsZone(t.db, claim(w));
    const other = await world();
    expect(await deleteDnsZone(t.db, other.org.id, row.id)).toBeUndefined();
    expect(await listDnsZones(t.db, w.org.id, page)).toHaveLength(1);
    expect(await deleteDnsZone(t.db, w.org.id, row.id)).toEqual(row);
    expect(await deleteDnsZone(t.db, w.org.id, row.id)).toBeUndefined();
    expect(await listDnsZones(t.db, w.org.id, page)).toEqual([]);
  });
});

describe("which of some zones a stack has claimed", () => {
  test("only the zones it holds: not another stack's, another project's or another organization's", async () => {
    const w = await world();
    const other = await createProject(t.db, { organizationId: w.org.id, name: "other" });
    await createDnsZone(t.db, claim(w, { zone: "mine.example" }));
    await createDnsZone(t.db, claim(w, { zone: "sibling.example", stack: "other-stack" }));
    await createDnsZone(t.db, claim(w, { zone: "theirs.example", projectId: other.id }));
    const stranger = await world();
    await createDnsZone(t.db, claim(stranger, { zone: "elsewhere.example" }));
    const at = { organizationId: w.org.id, projectId: w.project.id, stack: "dns" };
    const asked = [
      "mine.example",
      "sibling.example",
      "theirs.example",
      "elsewhere.example",
      "none.example",
    ];
    expect(await claimedZones(t.db, at, asked)).toEqual(new Set(["mine.example"]));
    expect(await claimedZones(t.db, at, [])).toEqual(new Set());
  });
});

describe("what takes a claim with it", () => {
  test("a project's claims go with the project, the others stay", async () => {
    const w = await world();
    const second = await createProject(t.db, { organizationId: w.org.id, name: "second" });
    await createDnsZone(t.db, claim(w, { zone: "gone.example" }));
    const kept = await createDnsZone(
      t.db,
      claim(w, { zone: "kept.example", projectId: second.id }),
    );
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(await listDnsZones(t.db, w.org.id, page)).toEqual([kept]);
  });
});
