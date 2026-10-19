import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StateResource } from "@orch/core";
import { CryptoError, envKeyProvider } from "@orch/crypto";
import { sql } from "drizzle-orm";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import {
  deleteState,
  listStateResources,
  listStateVersions,
  MAX_STATE_BYTES,
  putState,
  readState,
  STATE_RETENTION,
  stateKeyContext,
} from "./state";
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
const CANARY = "tf-state-SECRET-CANARY-7731";
const state = (serial: number, extra = "") =>
  JSON.stringify({ version: 4, serial, lineage: "L1", outputs: { token: CANARY + extra } });

let n = 0;
/** A project with nothing in it, and the reference to one stack of it. */
async function world() {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: "p" });
  return {
    org,
    project,
    ref: { organizationId: org.id, projectId: project.id, stackName: "network" },
  };
}
const write = (
  ref: Awaited<ReturnType<typeof world>>["ref"],
  serial: number,
  over: Partial<{
    lineage: string;
    content: string;
    createdBy: string;
    resources: StateResource[];
    onlyIfEmpty: boolean;
  }> = {},
) =>
  putState(t.db, keys, ref, {
    serial,
    lineage: over.lineage ?? "L1",
    content: over.content ?? state(serial),
    createdBy: over.createdBy ?? "ci:job-1",
    resources: over.resources ?? [],
    ...(over.onlyIfEmpty && { onlyIfEmpty: true }),
  });
const rows = async (projectId: string) =>
  (await t.db.execute(
    sql`SELECT * FROM state_versions WHERE project_id = ${projectId} ORDER BY stack_name, serial`,
  )) as Record<string, unknown>[];

describe("state versions", () => {
  test("a write is stored and reads back as the same text; what lists shows no content", async () => {
    const w = await world();
    const done = await write(w.ref, 1, { createdBy: "ci:job-9" });
    expect(done).toMatchObject({
      ok: true,
      unchanged: false,
      version: { serial: 1, lineage: "L1", createdBy: "ci:job-9", stackName: "network" },
    });
    const read = await readState(t.db, keys, w.ref);
    expect(read?.content).toBe(state(1));
    expect(read?.version.sizeBytes).toBe(Buffer.byteLength(state(1)));
    const listed = await listStateVersions(t.db, w.ref);
    expect(listed).toHaveLength(1);
    for (const shown of [done.ok && done.version, read?.version, ...listed]) {
      expect(Object.keys(shown || {})).not.toContain("stateEnc");
      expect(Object.keys(shown || {})).not.toContain("dekWrapped");
      expect(JSON.stringify(shown)).not.toContain(CANARY);
    }
  });

  test("nothing is stored yet: no state, no versions", async () => {
    const w = await world();
    expect(await readState(t.db, keys, w.ref)).toBeUndefined();
    expect(await listStateVersions(t.db, w.ref)).toEqual([]);
  });

  test("the state is sealed in the table and opens only with the master key", async () => {
    const w = await world();
    await write(w.ref, 1);
    const [row] = await rows(w.project.id);
    expect(Buffer.from(row?.state_enc as Uint8Array).includes(Buffer.from(CANARY))).toBe(false);
    expect(JSON.stringify(row)).not.toContain(CANARY);
    expect(await readState(t.db, keys, w.ref)).toBeDefined();
    await expect(readState(t.db, envKeyProvider(`k9:${key(9)}`), w.ref)).rejects.toBeInstanceOf(
      CryptoError,
    );
  });

  test("a version moved to another stack, serial or project does not open there", async () => {
    const w = await world();
    const other = { ...w.ref, stackName: "dns" };
    await write(w.ref, 1);
    await write(other, 1, { content: state(1, "-dns") });
    // the blob alone, taken from the other stack's row
    await t.db.execute(sql`
      UPDATE state_versions SET state_enc = (
        SELECT state_enc FROM state_versions WHERE project_id = ${w.project.id} AND stack_name = 'dns')
      WHERE project_id = ${w.project.id} AND stack_name = 'network'`);
    await expect(readState(t.db, keys, w.ref)).rejects.toBeInstanceOf(CryptoError);
    expect((await readState(t.db, keys, other))?.content).toBe(state(1, "-dns"));

    // the row itself renamed: it is what it was sealed for, not what its columns now say
    const v = await world();
    await write(v.ref, 1);
    await t.db.execute(
      sql`UPDATE state_versions SET stack_name = 'other' WHERE project_id = ${v.project.id}`,
    );
    await expect(readState(t.db, keys, { ...v.ref, stackName: "other" })).rejects.toBeInstanceOf(
      CryptoError,
    );
    await t.db.execute(
      sql`UPDATE state_versions SET stack_name = 'network', serial = 7 WHERE project_id = ${v.project.id}`,
    );
    await expect(readState(t.db, keys, v.ref)).rejects.toBeInstanceOf(CryptoError);
  });

  test("the data key is wrapped for the version it belongs to", async () => {
    const w = await world();
    await write(w.ref, 1);
    const [row] = await rows(w.project.id);
    expect(stateKeyContext(String(row?.id))).toBe(`state-version:${row?.id}`);
    expect(row?.dek_key_id).toBe("k2");
  });
});

describe("serial and lineage", () => {
  test("a higher serial is a new version; a lower one is refused and nothing is written", async () => {
    const w = await world();
    await write(w.ref, 5);
    expect(await write(w.ref, 6)).toMatchObject({ ok: true, unchanged: false });
    expect(await write(w.ref, 4)).toMatchObject({
      ok: false,
      reason: "serial_too_low",
      latest: { serial: 6, lineage: "L1" },
    });
    expect((await listStateVersions(t.db, w.ref)).map((v) => v.serial)).toEqual([6, 5]);
    expect((await readState(t.db, keys, w.ref))?.content).toBe(state(6));
  });

  test("another lineage is refused whatever its serial, and nothing is written", async () => {
    const w = await world();
    await write(w.ref, 5);
    expect(await write(w.ref, 9, { lineage: "L2" })).toMatchObject({
      ok: false,
      reason: "lineage_changed",
      latest: { serial: 5, lineage: "L1" },
    });
    expect(await rows(w.project.id)).toHaveLength(1);
  });

  test("the same serial with the same content is a retry: accepted, and no new version", async () => {
    const w = await world();
    const first = await write(w.ref, 5);
    const again = await write(w.ref, 5, { createdBy: "ci:job-2" });
    expect(again).toMatchObject({ ok: true, unchanged: true });
    expect(again.ok && first.ok && again.version.id).toBe(first.ok ? first.version.id : "");
    expect(await rows(w.project.id)).toHaveLength(1);
  });

  test("the same serial with other content is refused, and the version stays as it was", async () => {
    const w = await world();
    await write(w.ref, 5);
    expect(await write(w.ref, 5, { content: state(5, "-changed") })).toMatchObject({
      ok: false,
      reason: "serial_conflict",
    });
    expect((await readState(t.db, keys, w.ref))?.content).toBe(state(5));
  });

  test("the first write may be serial 0 and no lower; a lineage and a serial must make sense", async () => {
    const w = await world();
    for (const bad of [
      { serial: -1 },
      { serial: 1.5 },
      { serial: 2 ** 31 },
      { serial: 1, lineage: "" },
      { serial: 1, lineage: "x".repeat(257) },
    ]) {
      expect(await write(w.ref, bad.serial, { lineage: bad.lineage })).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    }
    expect(await rows(w.project.id)).toHaveLength(0);
    expect(await write(w.ref, 0)).toMatchObject({ ok: true });
  });

  test("two writes of one serial at once: one wins, the other is told, nobody gets a database error", async () => {
    const w = await world();
    const [a, b] = await Promise.all([
      write(w.ref, 1, { content: state(1, "-a") }),
      write(w.ref, 1, { content: state(1, "-b") }),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ reason: "serial_conflict" });
    expect(await rows(w.project.id)).toHaveLength(1);
  });

  test("two writes of different serials at once both land, in order", async () => {
    const w = await world();
    const done = await Promise.all([1, 2, 3, 4].map((s) => write(w.ref, s)));
    // each is either stored or, if a later serial got there first, refused as too low: never an error
    for (const r of done) expect(r.ok || r.reason === "serial_too_low").toBe(true);
    const serials = (await listStateVersions(t.db, w.ref)).map((v) => v.serial);
    expect(serials).toEqual([...serials].sort((x, y) => y - x));
    expect(serials[0]).toBe(4);
  });
});

describe("a first write only (an import)", () => {
  test("is stored at any serial and lineage when the stack has no state; any version after that refuses it", async () => {
    const w = await world();
    expect(await write(w.ref, 41, { lineage: "from-gitlab", onlyIfEmpty: true })).toMatchObject({
      ok: true,
      unchanged: false,
      version: { serial: 41, lineage: "from-gitlab" },
    });
    // the same serial and content is not a retry here: it is a second write, and the stack is no longer empty
    expect(await write(w.ref, 41, { lineage: "from-gitlab", onlyIfEmpty: true })).toEqual({
      ok: false,
      reason: "not_empty",
    });
    expect(await write(w.ref, 99, { lineage: "other", onlyIfEmpty: true })).toEqual({
      ok: false,
      reason: "not_empty",
    });
    expect((await listStateVersions(t.db, w.ref)).map((v) => v.serial)).toEqual([41]);
    // an ordinary write still goes on from it
    expect(await write(w.ref, 42, { lineage: "from-gitlab" })).toMatchObject({ ok: true });
  });

  test("a refused one leaves the version and the index it found", async () => {
    const w = await world();
    const one = [res("aws_vpc", "main")];
    await write(w.ref, 1, { resources: one });
    expect(
      await write(w.ref, 2, { onlyIfEmpty: true, resources: [res("aws_vpc", "other")] }),
    ).toMatchObject({ ok: false, reason: "not_empty" });
    expect((await listStateResources(t.db, w.ref, { limit: 10 })).map((r) => r.address)).toEqual([
      "aws_vpc.main",
    ]);
    expect((await readState(t.db, keys, w.ref))?.version.serial).toBe(1);
  });

  test("of two that race, exactly one is stored", async () => {
    const w = await world();
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => write(w.ref, n, { lineage: `l${n}`, onlyIfEmpty: true })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "not_empty")).toHaveLength(3);
    expect(await listStateVersions(t.db, w.ref)).toHaveLength(1);
  });

  test("a stack whose state was deleted is empty again", async () => {
    const w = await world();
    await write(w.ref, 1);
    await deleteState(t.db, w.ref);
    expect(await write(w.ref, 7, { lineage: "again", onlyIfEmpty: true })).toMatchObject({
      ok: true,
    });
  });
});

describe("size and retention", () => {
  test("the largest state is stored, and one byte more is refused with nothing written", async () => {
    const w = await world();
    const exact = (pad: number) => `${"x".repeat(pad)}`;
    expect(await write(w.ref, 1, { content: exact(MAX_STATE_BYTES + 1) })).toMatchObject({
      ok: false,
      reason: "too_large",
    });
    expect(await rows(w.project.id)).toHaveLength(0);
    expect(await write(w.ref, 1, { content: exact(MAX_STATE_BYTES) })).toMatchObject({ ok: true });
    expect((await readState(t.db, keys, w.ref))?.version.sizeBytes).toBe(MAX_STATE_BYTES);
  });

  test("the size is bytes, not characters", async () => {
    const w = await world();
    const content = "é".repeat(MAX_STATE_BYTES / 2 + 1); // 2 bytes each: one character over the limit
    expect(await write(w.ref, 1, { content })).toMatchObject({ ok: false, reason: "too_large" });
  });

  test("the newest versions are kept and the older ones are deleted in the write that passes the limit", async () => {
    const w = await world();
    for (let s = 1; s <= STATE_RETENTION; s++) await write(w.ref, s);
    expect(await listStateVersions(t.db, w.ref)).toHaveLength(STATE_RETENTION);
    await write(w.ref, STATE_RETENTION + 1);
    const serials = (await listStateVersions(t.db, w.ref)).map((v) => v.serial);
    expect(serials).toHaveLength(STATE_RETENTION);
    expect(serials[0]).toBe(STATE_RETENTION + 1);
    expect(serials.at(-1)).toBe(2);
    expect(STATE_RETENTION).toBe(20);
  });

  test("a refused write deletes nothing, and a retry does not prune", async () => {
    const w = await world();
    for (let s = 1; s <= STATE_RETENTION; s++) await write(w.ref, s);
    await write(w.ref, 1); // too low
    await write(w.ref, STATE_RETENTION); // a retry
    expect(await listStateVersions(t.db, w.ref)).toHaveLength(STATE_RETENTION);
    expect((await listStateVersions(t.db, w.ref)).at(-1)?.serial).toBe(1);
  });

  test("retention is per stack: one stack's writes never prune another's", async () => {
    const w = await world();
    const other = { ...w.ref, stackName: "dns" };
    await write(other, 1);
    for (let s = 1; s <= STATE_RETENTION + 3; s++) await write(w.ref, s);
    expect(await listStateVersions(t.db, other)).toHaveLength(1);
  });
});

describe("stacks and projects keep their own state", () => {
  test("the same stack name in two projects, and two stacks in one, are four separate lines", async () => {
    const a = await world();
    const b = await world();
    const refs = [a.ref, { ...a.ref, stackName: "dns" }, b.ref, { ...b.ref, stackName: "dns" }];
    for (const [i, ref] of refs.entries()) await write(ref, 1, { content: state(1, `-${i}`) });
    for (const [i, ref] of refs.entries()) {
      expect((await readState(t.db, keys, ref))?.content).toBe(state(1, `-${i}`));
      expect(await listStateVersions(t.db, ref)).toHaveLength(1);
    }
  });

  test("a project in another organization is not reachable with this organization's id", async () => {
    const a = await world();
    const b = await world();
    await write(a.ref, 1);
    const crossed = { ...a.ref, organizationId: b.org.id };
    expect(await readState(t.db, keys, crossed)).toBeUndefined();
    expect(await listStateVersions(t.db, crossed)).toEqual([]);
    // and a write cannot make a row that pairs a project with an organization that does not own it
    const error = await write({ ...crossed, stackName: "dns" }, 1).catch((e: unknown) => e);
    expect(pgConstraint(error)).toBe("state_versions_project_fk");
  });

  test("a stack name has to be a stack name", async () => {
    const w = await world();
    const error = await write({ ...w.ref, stackName: "Not A Name" }, 1).catch((e: unknown) => e);
    expect(pgConstraint(error)).toBe("state_versions_stack_name_check");
  });

  test("deleting a stack's state removes every version of it and nothing else", async () => {
    const w = await world();
    const other = { ...w.ref, stackName: "dns" };
    for (const s of [1, 2, 3]) await write(w.ref, s);
    await write(other, 1);
    expect(await deleteState(t.db, w.ref)).toBe(3);
    expect(await readState(t.db, keys, w.ref)).toBeUndefined();
    expect(await listStateVersions(t.db, other)).toHaveLength(1);
    expect(await deleteState(t.db, w.ref)).toBe(0);
    // the line starts again: a lower serial and another lineage are fine on an empty stack
    expect(await write(w.ref, 1, { lineage: "L9" })).toMatchObject({ ok: true });
  });

  test("a project that has state cannot be deleted; once the state is deleted it can", async () => {
    const w = await world();
    await write(w.ref, 1);
    const error = await deleteProject(t.db, w.org.id, w.project.id).catch((e: unknown) => e);
    expect(pgConstraint(error)).toBe("state_versions_project_fk");
    expect(await rows(w.project.id)).toHaveLength(1);
    await deleteState(t.db, w.ref);
    expect(await deleteProject(t.db, w.org.id, w.project.id)).toBe(true);
  });
});

// ---- the resource index (STATE-6)

const res = (type: string, name: string, over: Partial<StateResource> = {}): StateResource => ({
  address: `${over.module ? `${over.module}.` : ""}${type}.${name}`,
  mode: "managed",
  type,
  name,
  provider: "registry.terraform.io/hashicorp/aws",
  module: null,
  indexKey: null,
  ...over,
});
const addressesOf = async (ref: Awaited<ReturnType<typeof world>>["ref"], q = {}) =>
  (await listStateResources(t.db, ref, { limit: 100, ...q })).map((r) => r.address);
const indexRows = async (projectId: string) =>
  (await t.db.execute(
    sql`SELECT * FROM state_resources WHERE project_id = ${projectId} ORDER BY address`,
  )) as Record<string, unknown>[];

describe("the resource index", () => {
  test("a write indexes the state's resources; the next write replaces them, wholesale", async () => {
    const w = await world();
    await write(w.ref, 1, { resources: [res("aws_vpc", "main"), res("aws_s3_bucket", "logs")] });
    expect(await addressesOf(w.ref)).toEqual(["aws_s3_bucket.logs", "aws_vpc.main"]);
    await write(w.ref, 2, { resources: [res("aws_vpc", "main"), res("aws_subnet", "a")] });
    expect(await addressesOf(w.ref)).toEqual(["aws_subnet.a", "aws_vpc.main"]);
    expect(await indexRows(w.project.id)).toHaveLength(2);
  });

  test("a retry changes nothing, and a refused write leaves the index of the newest version", async () => {
    const w = await world();
    const first = { resources: [res("aws_vpc", "main")] };
    await write(w.ref, 3, first);
    expect(await write(w.ref, 3, first)).toMatchObject({ ok: true, unchanged: true });
    await write(w.ref, 2, { resources: [res("aws_subnet", "a")] }); // serial too low
    await write(w.ref, 3, { content: state(3, "-other"), resources: [res("aws_subnet", "b")] }); // conflict
    await write(w.ref, 4, { lineage: "L2", resources: [res("aws_subnet", "c")] }); // another lineage
    expect(await addressesOf(w.ref)).toEqual(["aws_vpc.main"]);
  });

  test("an index that cannot be written takes the version with it: nothing of the write stays", async () => {
    const w = await world();
    await write(w.ref, 1, { resources: [res("aws_vpc", "main")] });
    const twice = [res("aws_subnet", "a"), res("aws_subnet", "a")];
    const error = await write(w.ref, 2, { resources: twice }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((await listStateVersions(t.db, w.ref)).map((v) => v.serial)).toEqual([1]);
    expect(await addressesOf(w.ref)).toEqual(["aws_vpc.main"]);
  });

  test("a large index is written in full", async () => {
    const w = await world();
    const many = Array.from({ length: 2500 }, (_, i) => res("aws_instance", `i${i}`));
    await write(w.ref, 1, { resources: many });
    expect(await indexRows(w.project.id)).toHaveLength(2500);
  });

  test("deleting the state deletes its index, and only that stack's", async () => {
    const w = await world();
    const other = { ...w.ref, stackName: "dns" };
    await write(w.ref, 1, { resources: [res("aws_vpc", "main")] });
    await write(other, 1, { resources: [res("aws_route53_zone", "z")] });
    await deleteState(t.db, w.ref);
    expect(await addressesOf(w.ref)).toEqual([]);
    expect(await addressesOf(other)).toEqual(["aws_route53_zone.z"]);
  });

  test("stacks, projects and organizations see only their own", async () => {
    const a = await world();
    const b = await world();
    const dns = { ...a.ref, stackName: "dns" };
    await write(a.ref, 1, { resources: [res("aws_vpc", "main")] });
    await write(dns, 1, { resources: [res("aws_route53_zone", "z")] });
    await write(b.ref, 1, { resources: [res("aws_s3_bucket", "b")] });
    expect(await addressesOf(a.ref)).toEqual(["aws_vpc.main"]);
    expect(await addressesOf(dns)).toEqual(["aws_route53_zone.z"]);
    expect(await addressesOf(b.ref)).toEqual(["aws_s3_bucket.b"]);
    expect(await addressesOf({ ...a.ref, organizationId: b.org.id })).toEqual([]);
  });

  test("filters by type, provider and module, alone and together", async () => {
    const w = await world();
    await write(w.ref, 1, {
      resources: [
        res("aws_vpc", "main"),
        res("aws_vpc", "peer", { module: "module.net" }),
        res("aws_s3_bucket", "logs", { module: "module.net" }),
        res("google_storage_bucket", "g", { provider: "registry.terraform.io/hashicorp/google" }),
      ],
    });
    expect(await addressesOf(w.ref, { type: "aws_vpc" })).toEqual([
      "aws_vpc.main",
      "module.net.aws_vpc.peer",
    ]);
    expect(
      await addressesOf(w.ref, { provider: "registry.terraform.io/hashicorp/google" }),
    ).toEqual(["google_storage_bucket.g"]);
    expect(await addressesOf(w.ref, { module: "module.net" })).toEqual([
      "module.net.aws_s3_bucket.logs",
      "module.net.aws_vpc.peer",
    ]);
    expect(await addressesOf(w.ref, { type: "aws_vpc", module: "module.net" })).toEqual([
      "module.net.aws_vpc.peer",
    ]);
    expect(await addressesOf(w.ref, { type: "nothing" })).toEqual([]);
    // the root module is a module filter of its own
    expect(await addressesOf(w.ref, { module: null })).toEqual([
      "aws_vpc.main",
      "google_storage_bucket.g",
    ]);
  });

  test("a filter value is a value, never a pattern", async () => {
    const w = await world();
    await write(w.ref, 1, { resources: [res("aws_vpc", "main")] });
    expect(await addressesOf(w.ref, { type: "aws_%" })).toEqual([]);
    expect(await addressesOf(w.ref, { type: "aws_vpc' OR '1'='1" })).toEqual([]);
  });

  test("pages continue after the last address, in address order, and end", async () => {
    const w = await world();
    const names = ["a", "b", "c", "d", "e"];
    await write(w.ref, 1, { resources: names.map((n) => res("aws_vpc", n)).reverse() });
    const first = await listStateResources(t.db, w.ref, { limit: 2 });
    expect(first.map((r) => r.name)).toEqual(["a", "b"]);
    const second = await listStateResources(t.db, w.ref, { limit: 2, after: first[1]?.address });
    expect(second.map((r) => r.name)).toEqual(["c", "d"]);
    const last = await listStateResources(t.db, w.ref, { limit: 2, after: second[1]?.address });
    expect(last.map((r) => r.name)).toEqual(["e"]);
  });

  test("a row holds identity and nothing else: no state content, whatever the state held", async () => {
    const w = await world();
    await write(w.ref, 1, {
      resources: [res("aws_vpc", "main", { indexKey: "k", address: 'aws_vpc.main["k"]' })],
    });
    const columns = Object.keys((await indexRows(w.project.id))[0] ?? {}).sort();
    expect(columns).toEqual([
      "address",
      "created_at",
      "id",
      "index_key",
      "mode",
      "module",
      "name",
      "organization_id",
      "project_id",
      "provider",
      "stack_name",
      "type",
      "version_id",
    ]);
    expect(JSON.stringify(await indexRows(w.project.id))).not.toContain(CANARY);
  });
});
