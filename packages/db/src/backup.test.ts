import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CryptoError, envKeyProvider } from "@orch/crypto";
import { sql } from "drizzle-orm";
import { createConnection, openConnection } from "./connections";
import { createDb, migrateDb } from "./index";
import { createSink, openSink } from "./notifications";
import { createOrganization, createProject } from "./repo";
import { rewrapAll } from "./rewrap";
import { listStateResources, putState, readState } from "./state";
import { createEmptyDb, createTestDb } from "./testing";
import { createVariable, revealVariable } from "./variables";

// The scripts need the Postgres client tools; the CI image does not carry them, so there this is skipped.
const TOOLS = ["bash", "pg_dump", "pg_restore", "psql"];
const missing = TOOLS.filter((t) => !Bun.which(t));
const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const BACKUP = here("../../../deploy/backup.sh");
const RESTORE = here("../../../deploy/restore.sh");

const b64 = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const k1 = envKeyProvider(`k1:${b64(1)}`);
const k2 = envKeyProvider(`k2:${b64(2)}`);
const k1k2 = envKeyProvider(`k2:${b64(2)},k1:${b64(1)}`);

const VALUE = "project-value-SECRET-1";
const TOKEN = "glpat-TOKEN-SECRET-3";
const SINK = "https://hooks.example.com/SECRET-4";
const TFSTATE = "tf-state-SECRET-CANARY-5";
const STATE_DOC = JSON.stringify({
  version: 4,
  serial: 7,
  lineage: "L-backup",
  outputs: { password: { value: TFSTATE, sensitive: true } },
});
const STATE_RESOURCES = [
  {
    address: "aws_db_instance.main",
    mode: "managed" as const,
    type: "aws_db_instance",
    name: "main",
    provider: "registry.terraform.io/hashicorp/aws",
    module: null,
    indexKey: null,
  },
];

const dbs: { drop(): Promise<void> }[] = [];
const files: string[] = [];
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dbs.map((d) => d.drop()));
  await Promise.all(files.map((f) => unlink(f).catch(() => {})));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
const path = () => {
  const f = join(tmpdir(), `orch-backup-test-${crypto.randomUUID()}.dump`);
  files.push(f);
  return f;
};

/** Runs a script the way an operator would. `databaseUrl` is DATABASE_URL (undefined removes it). */
async function run(
  script: string,
  args: string[],
  databaseUrl: string | undefined,
  extraEnv: Record<string, string> = {},
) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    ...extraEnv,
  };
  if (databaseUrl === undefined) delete env.DATABASE_URL;
  const p = Bun.spawn(["bash", script, ...args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

/** Temporary files a backup of `file` left behind: none, whatever happened. */
const leftovers = async (file: string) =>
  (await readdir(tmpdir())).filter((f) => f.startsWith(`${basename(file)}.`));

/** The dump as SQL text: what a person reading the file would see. */
async function asSql(dump: string) {
  const p = Bun.spawn(["pg_restore", "--file=-", dump], { stdout: "pipe", stderr: "pipe" });
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect(code).toBe(0);
  return text;
}

/** A migrated database holding one secret of each kind the platform seals, under k1. */
async function source() {
  const t = await createTestDb();
  dbs.push(t);
  const organizationId = (await createOrganization(t.db, { slug: "o", name: "O" })).id;
  const projectId = (await createProject(t.db, { organizationId, name: "p" })).id;
  const variable = await createVariable(t.db, k1, {
    organizationId,
    projectId,
    key: "A",
    kind: "secret",
    value: VALUE,
    actor: { kind: "user", id: "u1" },
  });
  const connection = await createConnection(t.db, k1, {
    organizationId,
    type: "gitlab",
    name: "c",
    token: TOKEN,
  });
  const sink = await createSink(t.db, k1, {
    organizationId,
    kind: "webhook",
    name: "s",
    host: "hooks.example.com",
    secret: SINK,
  });
  const stack = { organizationId, projectId, stackName: "network" };
  const put = await putState(t.db, k1, stack, {
    serial: 7,
    lineage: "L-backup",
    content: STATE_DOC,
    createdBy: "ci:job-1",
    resources: STATE_RESOURCES,
  });
  expect(put.ok).toBe(true);
  return { t, organizationId, projectId, variable, connection, sink, stack };
}
type Source = Awaited<ReturnType<typeof source>>;

/** Opens the four secrets of `source` (the Terraform state is one) in whatever database `db` is. */
async function readBack(db: ReturnType<typeof createDb>, keys: typeof k1, s: Source) {
  return {
    variable: (
      await revealVariable(
        db,
        keys,
        { organizationId: s.organizationId, projectId: s.projectId },
        s.variable.id,
      )
    )?.value,
    connection: (await openConnection(db, keys, s.organizationId, s.connection.id))?.token,
    sink: (await openSink(db, keys, s.organizationId, s.sink.id))?.secret,
    state: (await readState(db, keys, s.stack))?.content,
  };
}
const EXPECTED = { variable: VALUE, connection: TOKEN, sink: SINK, state: STATE_DOC };

/** Backs `s` up and restores it into a new empty database, which it opens. */
async function backedUpAndRestored(s: Source) {
  const file = path();
  const made = await run(BACKUP, [file], s.t.url);
  expect(made.code).toBe(0);
  const empty = await createEmptyDb();
  dbs.push(empty);
  const restored = await run(RESTORE, [file], empty.url);
  expect(restored.code).toBe(0);
  const db = createDb(empty.url, 2);
  dbs.push({ drop: () => db.$client.close() });
  return { file, db, empty };
}

describe.skipIf(missing.length > 0)(
  `backup and restore scripts (skipped without: ${missing.join(", ") || "-"})`,
  () => {
    test("a restored database opens every secret with the same master keys, and with no others", async () => {
      const s = await source();
      expect(await readBack(s.t.db, k1, s)).toEqual(EXPECTED);
      const { db } = await backedUpAndRestored(s);

      expect(await readBack(db, k1, s)).toEqual(EXPECTED);
      // the keys are not in the backup: another key opens nothing
      await expect(readBack(db, k2, s)).rejects.toBeInstanceOf(CryptoError);
      // a release newer than the backup migrates the restored database like any other, and one that is
      // not newer has nothing to do
      await migrateDb(db);
      expect(await readBack(db, k1, s)).toEqual(EXPECTED);
    });

    test("the backup file holds no plaintext and no master key", async () => {
      const s = await source();
      const file = path();
      expect((await run(BACKUP, [file], s.t.url)).code).toBe(0);
      const text = await asSql(file);
      for (const plain of [
        VALUE,
        TOKEN,
        SINK,
        TFSTATE,
        "hooks.example.com/SECRET",
        b64(1),
        b64(2),
      ]) {
        expect(text).not.toContain(plain);
      }
      // it is the database that was asked for, and the data is in it
      expect(text).toContain("variable_keys");
      expect(text).toContain("dek_wrapped");
      expect(text).toContain("state_versions");
    });

    test("keys can be rotated on a restored database: afterwards it opens with the new key alone", async () => {
      const s = await source();
      const { db } = await backedUpAndRestored(s);

      const report = await rewrapAll(db, k1k2);
      expect(report.failed).toEqual([]);
      expect(report.rewrapped).toEqual({
        variable_keys: 1,
        connections: 1,
        notification_sinks: 1,
        sso_providers: 0,
        state_versions: 1,
      });
      expect(await readBack(db, k2, s)).toEqual(EXPECTED);
      await expect(readBack(db, k1, s)).rejects.toBeInstanceOf(CryptoError);
      // the source database was not touched by any of it
      expect(await readBack(s.t.db, k1, s)).toEqual(EXPECTED);
    });

    test("a restored Terraform state is the state that was backed up, and the stack carries on from it", async () => {
      const s = await source();
      const { db } = await backedUpAndRestored(s);

      const back = await readState(db, k1, s.stack);
      expect(back?.content).toBe(STATE_DOC);
      expect([back?.version.serial, back?.version.lineage, back?.version.createdBy]).toEqual([
        7,
        "L-backup",
        "ci:job-1",
      ]);
      // the index came with it
      expect(await listStateResources(db, s.stack, { limit: 10 })).toEqual(STATE_RESOURCES);
      // the next write takes the serial after the restored one, and an older one is still refused
      const next = JSON.stringify({ version: 4, serial: 8, lineage: "L-backup", outputs: {} });
      const ok = await putState(db, k1, s.stack, {
        serial: 8,
        lineage: "L-backup",
        content: next,
        createdBy: "ci:job-2",
        resources: [],
      });
      expect(ok.ok).toBe(true);
      const old = await putState(db, k1, s.stack, {
        serial: 7,
        lineage: "L-backup",
        content: STATE_DOC,
        createdBy: "ci:job-3",
        resources: [],
      });
      expect(old).toMatchObject({ ok: false, reason: "serial_too_low" });
      // the stack in the source database did not move
      expect((await readState(s.t.db, k1, s.stack))?.content).toBe(STATE_DOC);
    });

    test("restore refuses a database that has anything in it, and leaves it as it was", async () => {
      const s = await source();
      const file = path();
      expect((await run(BACKUP, [file], s.t.url)).code).toBe(0);

      const other = await createTestDb(); // migrated, so not empty
      dbs.push(other);
      await createOrganization(other.db, { slug: "keep", name: "Keep" });
      const count = async () =>
        (await other.db.execute(sql`SELECT count(*)::int AS n FROM organizations`))[0]?.n;
      expect(await count()).toBe(1);

      const r = await run(RESTORE, [file], other.url);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not empty");
      expect(await count()).toBe(1);

      // not even a table from somewhere else is room enough
      const stray = await createEmptyDb();
      dbs.push(stray);
      const sh = Bun.spawn(
        ["psql", stray.url, "--no-psqlrc", "--command", "create table stray (a int)"],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      expect(await sh.exited).toBe(0);
      const again = await run(RESTORE, [file], stray.url);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("not empty");
    });

    test("a restore that fails halfway leaves the database empty", async () => {
      const s = await source();
      const file = path();
      expect((await run(BACKUP, [file], s.t.url)).code).toBe(0);

      // a composite type is not a table, so the empty check lets it pass, but it takes the name of a table
      // that the restore creates after others
      const target = await createEmptyDb();
      dbs.push(target);
      const make = Bun.spawn(
        ["psql", target.url, "--no-psqlrc", "--command", "create type public.projects as (a int)"],
        { stdout: "ignore", stderr: "ignore" },
      );
      expect(await make.exited).toBe(0);

      const r = await run(RESTORE, [file], target.url);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("already exists"); // it got as far as the table, not stopped at the door
      const count = Bun.spawn(
        [
          "psql",
          target.url,
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--command",
          "select count(*) from pg_tables where schemaname = 'public'",
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      expect((await new Response(count.stdout).text()).trim()).toBe("0");
    });

    test("restore needs a file that exists and a database to put it in", async () => {
      const empty = await createEmptyDb();
      dbs.push(empty);
      const none = await run(RESTORE, [path()], empty.url);
      expect(none.code).toBe(1);
      expect(none.stderr).toContain("no such file");
      const noUrl = await run(RESTORE, [path()], undefined);
      expect(noUrl.code).not.toBe(0);
      expect(noUrl.stderr).toContain("DATABASE_URL");
      const noFile = await run(RESTORE, [], empty.url);
      expect(noFile.code).not.toBe(0);
    });

    test("backup never overwrites a file, and leaves nothing behind when it fails", async () => {
      const s = await source();
      const file = path();
      expect((await run(BACKUP, [file], s.t.url)).code).toBe(0);
      expect(await leftovers(file)).toEqual([]);
      const before = await Bun.file(file).bytes();

      const again = await run(BACKUP, [file], s.t.url);
      expect(again.code).toBe(1);
      expect(again.stderr).toContain("refusing to overwrite");
      expect(await Bun.file(file).bytes()).toEqual(before);

      const lost = path();
      const url = new URL(s.t.url);
      url.pathname = `/orch_test_missing_${crypto.randomUUID().replaceAll("-", "")}`;
      const failed = await run(BACKUP, [lost], url.toString());
      expect(failed.code).toBe(1);
      expect(await Bun.file(lost).exists()).toBe(false);
      expect(await leftovers(lost)).toEqual([]);

      const noUrl = await run(BACKUP, [path()], undefined);
      expect(noUrl.code).not.toBe(0);
      expect(noUrl.stderr).toContain("DATABASE_URL");
    });

    test("a file that appears while the dump runs is not overwritten", async () => {
      const s = await source();
      const out = path();
      // a pg_dump that first creates the file the backup is going to end up in: another backup got there
      const bin = await mkdtemp(join(tmpdir(), "orch-shim-"));
      dirs.push(bin);
      const shim = join(bin, "pg_dump");
      await Bun.write(
        shim,
        `#!/usr/bin/env bash\nfor a in "$@"; do [ "\${prev:-}" = "--file" ] && f="$a"; prev="$a"; done\necho theirs > "\${f%.part.*}"\nexec ${Bun.which("pg_dump")} "$@"\n`,
      );
      await chmod(shim, 0o755);

      const r = await run(BACKUP, [out], s.t.url, { PATH: `${bin}:${process.env.PATH}` });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("refusing to overwrite");
      expect((await Bun.file(out).text()).trim()).toBe("theirs");
      expect(await leftovers(out)).toEqual([]);
    });

    test("the backup file can be read by its owner only", async () => {
      const s = await source();
      const file = path();
      expect((await run(BACKUP, [file], s.t.url)).code).toBe(0);
      const mode = (await Bun.file(file).stat()).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  },
);
