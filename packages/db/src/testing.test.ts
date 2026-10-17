import { afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { migrateDb } from "./index";
import { createTestDb, type TestDb } from "./testing";

const scratch = pgTable("scratch", { id: integer().primaryKey(), name: text().notNull() });

describe("createTestDb", () => {
  const made: TestDb[] = [];
  const make = async () => {
    const t = await createTestDb();
    made.push(t);
    return t;
  };
  afterAll(async () => {
    await Promise.all(made.map((t) => t.drop()));
  });

  test("runs the baseline migration on a fresh database", async () => {
    const t = await make();
    const rows = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  test("migrating again is a no-op", async () => {
    const t = await make();
    await migrateDb(t.db);
    const rows = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  test("baseline provides set_updated_at() for table triggers", async () => {
    const t = await make();
    await t.db.execute(
      sql`CREATE TABLE touched (id int PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT now())`,
    );
    await t.db.execute(sql`CREATE TRIGGER touched_updated BEFORE UPDATE ON touched
      FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
    await t.db.execute(sql`INSERT INTO touched (id, updated_at) VALUES (1, '2000-01-01')`);
    await t.db.execute(sql`UPDATE touched SET id = 1 WHERE id = 1`);
    const rows = await t.db.execute(sql`SELECT updated_at > '2020-01-01' AS moved FROM touched`);
    expect(rows[0]?.moved).toBe(true);
  });

  test("drizzle queries work on Bun.sql (ADR-0004 driver check)", async () => {
    const t = await make();
    await t.db.execute(sql`CREATE TABLE scratch (id int PRIMARY KEY, name text NOT NULL)`);
    await t.db.insert(scratch).values({ id: 1, name: "a" });
    const rows = await t.db.select().from(scratch);
    expect(rows).toEqual([{ id: 1, name: "a" }]);
  });

  test("databases created together do not see each other", async () => {
    const [a, b] = await Promise.all([make(), make()]);
    expect(a?.name).not.toBe(b?.name);
    await a?.db.execute(sql`CREATE TABLE only_in_a (id int)`);
    // drizzle returns a thenable, not a Promise, so `.rejects` needs the wrapper
    const err = await Promise.resolve(b?.db.execute(sql`SELECT * FROM only_in_a`)).catch((e) => e);
    expect(String(err.cause ?? err)).toContain("only_in_a");
  });

  test("drop removes the database and is idempotent", async () => {
    const t = await createTestDb();
    await Promise.all([t.drop(), t.drop()]);
    await t.drop();
    const admin = new SQL(process.env.DATABASE_URL as string, { max: 1 });
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${t.name}`;
    await admin.close();
    expect(rows).toHaveLength(0);
  });

  test("an unreachable server gives a hint without leaking credentials", async () => {
    const err = await createTestDb("postgres://orch:hunter2@127.0.0.1:1/orch").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("127.0.0.1:1");
    expect(err.message).toContain("dev:db");
    expect(err.message).not.toContain("hunter2");
  });

  test("a server rejection (bad password) is reported as itself, not as 'unreachable'", async () => {
    const bad = new URL(process.env.DATABASE_URL as string);
    bad.password = "wrongpw-CANARY";
    const err = await createTestDb(bad.toString()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("password authentication failed");
    expect(err.message).not.toContain("dev:db");
    expect(err.message).not.toContain("wrongpw-CANARY");
  });
});

describe("parallel processes", () => {
  test("separate processes each get an isolated database", async () => {
    const probe = fileURLToPath(new URL("./fixtures/isolation-probe.ts", import.meta.url));
    const runs = Array.from({ length: 4 }, (_, i) =>
      Bun.spawn([process.execPath, probe, `tag-${i}`], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const results = await Promise.all(
      runs.map(async (p) => ({
        code: await p.exited,
        out: (await new Response(p.stdout).text()).trim(),
        err: await new Response(p.stderr).text(),
      })),
    );
    for (const r of results) expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(results.map((r) => r.out).sort()).toEqual(["tag-0:1", "tag-1:1", "tag-2:1", "tag-3:1"]);
  }, 30_000);
});
