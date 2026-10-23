import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { BulkOp } from "@orch/core";
import { CryptoError, envKeyProvider, type KeyProvider } from "@orch/crypto";
import { sql } from "drizzle-orm";
import {
  connectionKeyContext,
  createConnection,
  openConnection,
  openWebhookSecret,
} from "./connections";
import { createSink, openSink } from "./notifications";
import { createEnvironment, createOrganization, createProject } from "./repo";
import { KEY_TABLES, keyUsage, rewrapAll, stillOnOldKeys } from "./rewrap";
import { createSsoProvider, openSsoSecret, ssoKeyContext } from "./sso";
import { putState, readState, stateKeyContext } from "./state";
import { createTestDb, type TestDb } from "./testing";
import { createVariable, openPending, revealVariable, sealPending } from "./variables";

const b64 = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const only = (id: string, fill: number) => envKeyProvider(`${id}:${b64(fill)}`);
const k1 = only("k1", 1);
const k2 = only("k2", 2);
const k1k2 = envKeyProvider(`k2:${b64(2)},k1:${b64(1)}`); // k2 wraps, k1 still opens

const dbs: TestDb[] = [];
afterAll(() => Promise.all(dbs.map((d) => d.drop())));
const fresh = async () => {
  const t = await createTestDb();
  dbs.push(t);
  return t;
};

const VALUE = "project-value-SECRET-1";
const ORG_VALUE = "org-value-SECRET-2";
const TOKEN = "glpat-TOKEN-SECRET-3";
const HOOK = "whsec-HOOK-SECRET-3";
const SINK = "https://hooks.example.com/SECRET-4";
const PENDING = "pending-value-SECRET-5";
const IDP = "idp-client-SECRET-6";
const STATE = JSON.stringify({
  version: 4,
  serial: 1,
  lineage: "L",
  outputs: { x: "state-SECRET-7" },
});
const OPS: BulkOp[] = [{ op: "set", key: "C", value: PENDING }];
const actor = { kind: "user", id: "u1" };

/** One organization with a secret of every kind the platform seals, all wrapped by `keys`. */
async function seed(t: TestDb, keys: KeyProvider) {
  const organizationId = (
    await createOrganization(t.db, { slug: `o${crypto.randomUUID().slice(0, 8)}`, name: "O" })
  ).id;
  const projectId = (await createProject(t.db, { organizationId, name: "p" })).id;
  const environmentId = (
    await createEnvironment(t.db, { organizationId, projectId, name: "dev", slug: "dev" })
  ).id;
  const project = { organizationId, projectId };
  const variable = await createVariable(t.db, keys, {
    ...project,
    key: "A",
    kind: "secret",
    value: VALUE,
    actor,
  });
  const orgVariable = await createVariable(t.db, keys, {
    organizationId,
    key: "B",
    kind: "secret",
    value: ORG_VALUE,
    actor,
  });
  const connection = await createConnection(t.db, keys, {
    organizationId,
    type: "gitlab",
    name: "c",
    token: TOKEN,
    webhookSecret: HOOK,
  });
  const sink = await createSink(t.db, keys, {
    organizationId,
    kind: "webhook",
    name: "s",
    host: "hooks.example.com",
    secret: SINK,
  });
  const idp = await createSsoProvider(t.db, keys, {
    organizationId,
    issuer: "https://idp.example.com",
    clientId: "orch",
    clientSecret: IDP,
    emailDomains: ["example.com"],
    roleMap: [],
  });
  const at = { organizationId, projectId, environmentId, id: crypto.randomUUID() };
  const pending = await sealPending(t.db, keys, at, OPS);
  const stack = { organizationId, projectId, stackName: "net" };
  await putState(t.db, keys, stack, {
    serial: 1,
    lineage: "L",
    content: STATE,
    createdBy: "ci:test",
    resources: [],
  });
  return {
    organizationId,
    project,
    variable,
    orgVariable,
    connection,
    sink,
    idp,
    at,
    pending,
    stack,
  };
}
type World = Awaited<ReturnType<typeof seed>>;

/** Everything `seed` sealed, opened with `keys`. */
async function readAll(t: TestDb, keys: KeyProvider, w: World) {
  return {
    project: (await revealVariable(t.db, keys, w.project, w.variable.id))?.value,
    org: (await revealVariable(t.db, keys, { organizationId: w.organizationId }, w.orgVariable.id))
      ?.value,
    connection: (await openConnection(t.db, keys, w.organizationId, w.connection.id))?.token,
    hook: await openWebhookSecret(t.db, keys, w.organizationId, w.connection.id),
    sink: (await openSink(t.db, keys, w.organizationId, w.sink.id))?.secret,
    idp: await openSsoSecret(t.db, keys, w.idp.id),
    pending: await openPending(t.db, keys, w.at, w.pending),
    state: (await readState(t.db, keys, w.stack))?.content,
  };
}
/** Makes every update of `table` fail, as a database going wrong would. */
async function failUpdates(t: TestDb, table: string) {
  await t.db.execute(sql`
    CREATE OR REPLACE FUNCTION no_updates() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'updates are off'; END $$`);
  await t.db.execute(
    sql.raw(
      `CREATE TRIGGER no_updates BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION no_updates()`,
    ),
  );
}
const EXPECTED = {
  project: VALUE,
  org: ORG_VALUE,
  connection: TOKEN,
  hook: HOOK,
  sink: SINK,
  idp: IDP,
  pending: OPS,
  state: STATE,
};
const wraps = async (t: TestDb) =>
  (
    await t.db.execute(sql`
      SELECT 'v' AS t, id, dek_key_id, dek_wrapped FROM variable_keys
      UNION ALL SELECT 'c', id, dek_key_id, dek_wrapped FROM connections
      UNION ALL SELECT 's', id, dek_key_id, dek_wrapped FROM notification_sinks
      UNION ALL SELECT 'o', id, dek_key_id, dek_wrapped FROM sso_providers
      UNION ALL SELECT 'x', id, dek_key_id, dek_wrapped FROM state_versions
      ORDER BY 1, 2`)
  ).map((r: Record<string, unknown>) => [
    r.t,
    r.id,
    r.dek_key_id,
    Buffer.from(r.dek_wrapped as Uint8Array).toString("hex"),
  ]);

describe("moving data keys to a new master key", () => {
  test("every sealed secret is readable with the new key alone, and with the old key alone no more", async () => {
    const t = await fresh();
    const w = await seed(t, k1);
    expect(await readAll(t, k1, w)).toEqual(EXPECTED);

    const report = await rewrapAll(t.db, k1k2);
    expect(report).toEqual({
      rewrapped: {
        variable_keys: 2,
        connections: 1,
        notification_sinks: 1,
        sso_providers: 1,
        state_versions: 1,
      },
      failed: [],
    });
    expect(await readAll(t, k2, w)).toEqual(EXPECTED);
    // the values themselves were never touched
    await expect(readAll(t, k1, w)).rejects.toBeInstanceOf(CryptoError);
    expect(await keyUsage(t.db)).toEqual({
      variable_keys: { k2: 2 },
      connections: { k2: 1 },
      notification_sinks: { k2: 1 },
      sso_providers: { k2: 1 },
      state_versions: { k2: 1 },
    });
  });

  test("a second run changes nothing, and a wrap already on the current key is left byte for byte", async () => {
    const t = await fresh();
    await seed(t, k1);
    await rewrapAll(t.db, k1k2);
    const before = await wraps(t);
    const again = await rewrapAll(t.db, k1k2);
    expect(again.rewrapped).toEqual({
      variable_keys: 0,
      connections: 0,
      notification_sinks: 0,
      sso_providers: 0,
      state_versions: 0,
    });
    expect(again.failed).toEqual([]);
    expect(await wraps(t)).toEqual(before);
  });

  test("rows are taken in pages: every row moves whatever the page size", async () => {
    const t = await fresh();
    const worlds: World[] = [];
    for (let i = 0; i < 4; i++) worlds.push(await seed(t, k1));
    const report = await rewrapAll(t.db, k1k2, 3); // 8 variable keys, 4 connections, 4 sinks, 4 providers, 4 states
    expect(report.rewrapped).toEqual({
      variable_keys: 8,
      connections: 4,
      notification_sinks: 4,
      sso_providers: 4,
      state_versions: 4,
    });
    for (const w of worlds) expect(await readAll(t, k2, w)).toEqual(EXPECTED);
    // an exact multiple of the page size ends too
    const u = await fresh();
    await seed(u, k1);
    await seed(u, k1);
    expect((await rewrapAll(u.db, k1k2, 2)).rewrapped).toEqual({
      variable_keys: 4,
      connections: 2,
      notification_sinks: 2,
      sso_providers: 2,
      state_versions: 2,
    });
  });

  test("rows that stay behind do not hold the pages back: each is reported once", async () => {
    const t = await fresh();
    for (let i = 0; i < 3; i++) await seed(t, only("k0", 9));
    const report = await rewrapAll(t.db, k1k2, 2); // 6 variable keys, 3 connections, 3 sinks, 3 providers, 3 states, all failing
    expect(report.rewrapped).toEqual({
      variable_keys: 0,
      connections: 0,
      notification_sinks: 0,
      sso_providers: 0,
      state_versions: 0,
    });
    expect(report.failed).toHaveLength(18);
    expect(new Set(report.failed.map((f) => f.id)).size).toBe(18);
  });

  test("the order rows happen to be stored in does not decide which are moved", async () => {
    const t = await fresh();
    const worlds: World[] = [];
    for (let i = 0; i < 4; i++) worlds.push(await seed(t, k1));
    // an update stores the row again at the end of the table: now the oldest id is read last
    for (const table of KEY_TABLES) {
      await t.db.execute(
        sql.raw(
          `UPDATE ${table} SET dek_key_id = dek_key_id WHERE id = (SELECT id FROM ${table} ORDER BY id LIMIT 1)`,
        ),
      );
    }
    const report = await rewrapAll(t.db, k1k2, 3);
    expect(report.rewrapped).toEqual({
      variable_keys: 8,
      connections: 4,
      notification_sinks: 4,
      sso_providers: 4,
      state_versions: 4,
    });
    for (const w of worlds) expect(await readAll(t, k2, w)).toEqual(EXPECTED);
  });

  test("a database error stops the run, what moved stays moved, and running again finishes", async () => {
    const t = await fresh();
    const w = await seed(t, k1);
    await failUpdates(t, "connections");
    await expect(rewrapAll(t.db, k1k2)).rejects.toThrow();
    // variable_keys come first in the run, and they were done
    expect(await keyUsage(t.db)).toEqual({
      variable_keys: { k2: 2 },
      connections: { k1: 1 },
      notification_sinks: { k1: 1 },
      sso_providers: { k1: 1 },
      state_versions: { k1: 1 },
    });
    await t.db.execute(sql`DROP TRIGGER no_updates ON connections`);
    const again = await rewrapAll(t.db, k1k2);
    expect(again.rewrapped).toEqual({
      variable_keys: 0,
      connections: 1,
      notification_sinks: 1,
      sso_providers: 1,
      state_versions: 1,
    });
    expect(await readAll(t, k2, w)).toEqual(EXPECTED);
  });

  test("every table that holds a wrapped data key is one the rotation moves", async () => {
    const t = await fresh();
    const rows = await t.db.execute(sql`
      SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND (column_name LIKE 'dek\_%' OR column_name LIKE '%wrapped%')`);
    // a new table with a data key that is not in KEY_TABLES would stay on the old master key for ever
    expect(rows.map((r: Record<string, unknown>) => r.table_name).sort()).toEqual(
      [...KEY_TABLES].sort(),
    );
  });

  test("a key that cannot be moved is reported and left alone, and the rest still move", async () => {
    const t = await fresh();
    const good = await seed(t, k1);
    const lost = await seed(t, only("k0", 9)); // wrapped by a master key that is no longer given
    const before = await wraps(t);
    const report = await rewrapAll(t.db, k1k2);
    expect(report.rewrapped).toEqual({
      variable_keys: 2,
      connections: 1,
      notification_sinks: 1,
      sso_providers: 1,
      state_versions: 1,
    });
    expect(report.failed).toHaveLength(6);
    expect(new Set(report.failed.map((f) => f.code))).toEqual(new Set(["unknown_key"]));
    expect(new Set(report.failed.map((f) => f.table))).toEqual(new Set(KEY_TABLES));
    expect(await readAll(t, k2, good)).toEqual(EXPECTED);
    // what failed is exactly what it was
    const after = await wraps(t);
    const failedIds = new Set(report.failed.map((f) => f.id));
    expect(after.filter((r) => failedIds.has(r[1] as string))).toEqual(
      before.filter((r) => failedIds.has(r[1] as string)),
    );
    expect(await readAll(t, only("k0", 9), lost)).toEqual(EXPECTED);
    expect(JSON.stringify(report)).not.toMatch(/k0|k1|k2|[A-Za-z0-9+/]{43}=/);
  });

  test("a wrap that does not open (tampered, or moved to another row) is reported, not rewrapped", async () => {
    const t = await fresh();
    const a = await seed(t, k1);
    const b = await seed(t, k1);
    // b's connection key is a's: the wrap is bound to the row it was made for
    await t.db.execute(sql`
      UPDATE connections SET dek_wrapped = (SELECT dek_wrapped FROM connections WHERE id = ${a.connection.id})
      WHERE id = ${b.connection.id}`);
    // a sink key with a flipped byte
    await t.db.execute(sql`
      UPDATE notification_sinks SET dek_wrapped = set_byte(dek_wrapped, 20, get_byte(dek_wrapped, 20) # 255)
      WHERE id = ${b.sink.id}`);
    const report = await rewrapAll(t.db, k1k2);
    expect(report.failed.map((f) => [f.table, f.id, f.code]).sort()).toEqual(
      [
        ["connections", b.connection.id, "decrypt_failed"],
        ["notification_sinks", b.sink.id, "decrypt_failed"],
      ].sort(),
    );
    expect(report.rewrapped).toEqual({
      variable_keys: 4,
      connections: 1,
      notification_sinks: 1,
      sso_providers: 2,
      state_versions: 2,
    });
    const usage = await keyUsage(t.db);
    expect(usage.connections).toEqual({ k2: 1, k1: 1 });
    expect(usage.notification_sinks).toEqual({ k2: 1, k1: 1 });
  });

  test("a new wrap that does not open is never written", async () => {
    const t = await fresh();
    const w = await seed(t, k1);
    const broken: KeyProvider = {
      currentKeyId: k1k2.currentKeyId,
      wrap: async () => ({ keyId: "k2", wrapped: new Uint8Array(60) }),
      unwrap: (wrapped, aad) => k1k2.unwrap(wrapped, aad),
    };
    const before = await wraps(t);
    const report = await rewrapAll(t.db, broken);
    expect(report.rewrapped).toEqual({
      variable_keys: 0,
      connections: 0,
      notification_sinks: 0,
      sso_providers: 0,
      state_versions: 0,
    });
    expect(report.failed).toHaveLength(6);
    expect(await wraps(t)).toEqual(before);
    expect(await readAll(t, k1, w)).toEqual(EXPECTED);
  });

  test("two runs at once move each key once and lose nothing", async () => {
    const t = await fresh();
    const worlds: World[] = [];
    for (let i = 0; i < 3; i++) worlds.push(await seed(t, k1));
    const [a, b] = await Promise.all([rewrapAll(t.db, k1k2, 2), rewrapAll(t.db, k1k2, 2)]);
    const moved = (r: typeof a) =>
      r.rewrapped.variable_keys +
      r.rewrapped.connections +
      r.rewrapped.notification_sinks +
      r.rewrapped.sso_providers +
      r.rewrapped.state_versions;
    expect(moved(a) + moved(b)).toBe(18); // 6 variable keys, 3 connections, 3 sinks, 3 providers, 3 states, each by one run
    expect(a.failed).toEqual([]);
    expect(b.failed).toEqual([]);
    for (const w of worlds) expect(await readAll(t, k2, w)).toEqual(EXPECTED);
  });

  /**
   * A provider that, the first time it wraps for each table (after the run has read that table's rows, before
   * it writes them), changes every row of the table with `change`, as a second writer would.
   */
  function racing(t: TestDb, change: (table: string) => string): KeyProvider {
    const done = new Set<string>();
    const tableOf = (context: string) =>
      context.includes('"connection:')
        ? "connections"
        : context.includes('"notification_sink:')
          ? "notification_sinks"
          : context.includes('"sso-provider:')
            ? "sso_providers"
            : context.includes('"state-version:')
              ? "state_versions"
              : "variable_keys";
    return {
      currentKeyId: "k2",
      wrap: async (plain, aad) => {
        const table = tableOf(aad);
        if (!done.has(table)) {
          done.add(table);
          await t.db.execute(sql.raw(change(table)));
        }
        return k1k2.wrap(plain, aad);
      },
      unwrap: (wrapped, aad) => k1k2.unwrap(wrapped, aad),
    };
  }

  test("a row another run moved first is not written over", async () => {
    const t = await fresh();
    await seed(t, k1);
    // the master key id changes under the run (a second run got there first), the bytes do not
    const report = await rewrapAll(
      t.db,
      racing(t, (table) => `UPDATE ${table} SET dek_key_id = 'k2'`),
    );
    expect(report.rewrapped).toEqual({
      variable_keys: 0,
      connections: 0,
      notification_sinks: 0,
      sso_providers: 0,
      state_versions: 0,
    });
    expect(report.failed).toEqual([]);
    expect(await keyUsage(t.db)).toEqual({
      variable_keys: { k2: 2 },
      connections: { k2: 1 },
      notification_sinks: { k2: 1 },
      sso_providers: { k2: 1 },
      state_versions: { k2: 1 },
    });
  });

  test("a row whose wrap was replaced by one on the same master key is not written over either", async () => {
    const t = await fresh();
    await seed(t, k1);
    const report = await rewrapAll(
      t.db,
      racing(
        t,
        (table) =>
          `UPDATE ${table} SET dek_wrapped = set_byte(dek_wrapped, 20, get_byte(dek_wrapped, 20) # 255)`,
      ),
    );
    expect(report.rewrapped).toEqual({
      variable_keys: 0,
      connections: 0,
      notification_sinks: 0,
      sso_providers: 0,
      state_versions: 0,
    });
    expect(report.failed).toEqual([]);
    // nothing of ours was written: they are all still on the key the other writer left them on
    expect(await keyUsage(t.db)).toEqual({
      variable_keys: { k1: 2 },
      connections: { k1: 1 },
      notification_sinks: { k1: 1 },
      sso_providers: { k1: 1 },
      state_versions: { k1: 1 },
    });
  });

  test("the context of a connection key is the connection's own, and so are a provider's and a state version's", () => {
    expect(connectionKeyContext("abc")).toBe("connection:abc");
    expect(ssoKeyContext("abc")).toBe("sso-provider:abc");
    expect(stateKeyContext("abc")).toBe("state-version:abc");
  });

  test("usage counts what each master key wraps, and what is still on an old one", async () => {
    const t = await fresh();
    await seed(t, k1);
    await seed(t, k1k2);
    const usage = await keyUsage(t.db);
    expect(usage).toEqual({
      variable_keys: { k1: 2, k2: 2 },
      connections: { k1: 1, k2: 1 },
      notification_sinks: { k1: 1, k2: 1 },
      sso_providers: { k1: 1, k2: 1 },
      state_versions: { k1: 1, k2: 1 },
    });
    expect(stillOnOldKeys(usage, "k2")).toBe(6);
    expect(stillOnOldKeys(usage, "k1")).toBe(6);
    expect(stillOnOldKeys(usage, "k9")).toBe(12);
    expect(
      stillOnOldKeys(
        {
          variable_keys: {},
          connections: {},
          notification_sinks: {},
          sso_providers: {},
          state_versions: {},
        },
        "k2",
      ),
    ).toBe(0);
  });
});

describe("the rotate-master-key command", () => {
  const script = fileURLToPath(new URL("./rotate-master-key.ts", import.meta.url));
  async function run(t: TestDb, keys: string, ...args: string[]) {
    const proc = Bun.spawn([process.execPath, script, ...args], {
      // `cwd` outside the repo keeps a developer's `.env` out of the child (Bun auto-loads it).
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: t.url, ORCH_MASTER_KEYS: keys },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code };
  }
  const logged = (out: string) =>
    out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const last = (out: string) => logged(out).at(-1);

  test("status says what is left, rotating finishes it, and the old key can then go", async () => {
    const t = await fresh();
    const w = await seed(t, k1);
    const both = `k2:${b64(2)},k1:${b64(1)}`;

    const before = await run(t, both, "--status");
    expect(before.code).toBe(1); // not done: everything is still on k1
    expect(last(before.out)).toMatchObject({
      current: "k2",
      remaining: 6,
      usage: expect.arrayContaining([{ table: "connections", wrappedBy: "k1", count: 1 }]),
    });

    const done = await run(t, both);
    expect(done.code).toBe(0);
    expect(last(done.out)).toMatchObject({
      current: "k2",
      remaining: 0,
      rewrapped: [
        { table: "variable_keys", count: 2 },
        { table: "connections", count: 1 },
        { table: "notification_sinks", count: 1 },
        { table: "sso_providers", count: 1 },
        { table: "state_versions", count: 1 },
      ],
    });
    expect((await run(t, both, "--status")).code).toBe(0);
    // the new key alone is enough
    expect((await run(t, `k2:${b64(2)}`)).code).toBe(0);
    expect(await readAll(t, k2, w)).toEqual(EXPECTED);
  });

  test("a key it cannot move fails the run, names the row and no key, and moves the rest", async () => {
    const t = await fresh();
    await seed(t, k1);
    await seed(t, only("k0", 9));
    const r = await run(t, `k2:${b64(2)},k1:${b64(1)}`);
    expect(r.code).toBe(1);
    const said = (msg: string) => logged(r.out).find((l) => l.msg === msg);
    expect(said("master key rotation finished")).toMatchObject({
      remaining: 6,
      rewrapped: [
        { table: "variable_keys", count: 2 },
        { table: "connections", count: 1 },
        { table: "notification_sinks", count: 1 },
        { table: "sso_providers", count: 1 },
        { table: "state_versions", count: 1 },
      ],
    });
    const failed = (said("some data keys could not be moved")?.failed ?? []) as { code: string }[];
    expect(failed).toHaveLength(6);
    expect(new Set(failed.map((f) => f.code))).toEqual(new Set(["unknown_key"]));
    expect(r.out + r.err).not.toContain(b64(1));
    expect(r.out + r.err).not.toContain(b64(2));
  });

  test("a database error stops the run with a short message: no query, no wrapped key", async () => {
    const t = await fresh();
    await seed(t, k1);
    await failUpdates(t, "connections");
    const r = await run(t, `k2:${b64(2)},k1:${b64(1)}`);
    expect(r.code).toBe(1);
    const stopped = logged(r.out).find((l) =>
      String(l.msg).startsWith("master key rotation stopped"),
    );
    expect(stopped).toMatchObject({ reason: expect.any(String) });
    const all = r.out + r.err;
    expect(all).not.toContain("dek_wrapped");
    expect(all).not.toContain("UPDATE");
    expect(all).not.toContain(b64(1));
    expect(all).not.toContain(b64(2));
  });

  test("bad settings and bad arguments stop it before it touches the database", async () => {
    const t = await fresh();
    await seed(t, k1);
    const before = await wraps(t);
    const badKeys = await run(t, "k2:not-base64");
    expect(badKeys.code).toBe(2);
    expect(badKeys.out + badKeys.err).toContain("ORCH_MASTER_KEYS is invalid");
    expect(badKeys.out + badKeys.err).not.toContain("not-base64");
    expect((await run(t, `k2:${b64(2)},k1:${b64(1)}`, "--rotate-everything")).code).toBe(2);
    expect(await wraps(t)).toEqual(before);
  });
});
