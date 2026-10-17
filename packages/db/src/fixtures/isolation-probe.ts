// Spawned by testing.test.ts: proves that separate processes get separate databases.
// Prints "<tag>:<rows seen>"; any cross-talk would show up as a count above 1.
import { sql } from "drizzle-orm";
import { createTestDb } from "../testing";

const tag = process.argv[2] ?? "none";
const t = await createTestDb();
try {
  await t.db.execute(sql`CREATE TABLE probe (tag text)`);
  await t.db.execute(sql`INSERT INTO probe VALUES (${tag})`);
  await Bun.sleep(100);
  const rows = await t.db.execute(sql`SELECT count(*)::int AS n FROM probe WHERE tag LIKE 'tag-%'`);
  console.log(`${tag}:${rows[0]?.n}`);
} finally {
  await t.drop();
}
