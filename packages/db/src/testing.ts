import { SQL } from "bun";
import { createDb, type Db, migrateDb } from "./index";

export interface TestDb {
  db: Db;
  /** Connection URL of this test database (contains credentials: never log it). */
  url: string;
  name: string;
  drop(): Promise<void>;
}

// Connections are scarce (~100 on the server), so the admin client lives only for one statement
// and each test database gets a 2-connection pool.
async function withAdmin<T>(baseUrl: string, fn: (admin: SQL) => Promise<T>): Promise<T> {
  const admin = new SQL(baseUrl, { max: 1 });
  try {
    return await fn(admin);
  } catch (e) {
    // The server answered (bad password, missing database): its message is the useful one.
    if ((e as { code?: string }).code === "ERR_POSTGRES_SERVER_ERROR") throw e;
    throw new Error(
      `Postgres is not reachable at ${new URL(baseUrl).host}. Start it with \`bun run dev:db\`.`,
    );
  } finally {
    await admin.close().catch(() => {});
  }
}

/** A uniquely named database with nothing in it; `remove` drops it (the caller closes its own pool first). */
async function createBlank(baseUrl: string | undefined) {
  if (!baseUrl) throw new Error("DATABASE_URL is not set. Run tests with `bun run test`.");
  const name = `orch_test_${crypto.randomUUID().replaceAll("-", "")}`;
  // `name` is generated above from hex only, so interpolating it is safe.
  await withAdmin(baseUrl, (admin) => admin.unsafe(`CREATE DATABASE ${name}`));
  const target = new URL(baseUrl);
  target.pathname = `/${name}`;
  const remove = () =>
    withAdmin(baseUrl, (admin) => admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  return { name, url: target.toString(), remove };
}

/**
 * Creates a uniquely named, fully migrated database for one test file and returns a `drop()`
 * to call in `afterAll`.
 * shortcut: a crashed run leaves its `orch_test_*` database behind; add a sweeper if that bites.
 */
export async function createTestDb(baseUrl = process.env.DATABASE_URL): Promise<TestDb> {
  const { name, url, remove } = await createBlank(baseUrl);
  const db = createDb(url, 2);
  let dropping: Promise<void> | undefined;
  const drop = () => {
    // One shared promise: a second call waits for the first instead of returning early.
    dropping ??= (async () => {
      try {
        await db.$client.close();
      } finally {
        await remove();
      }
    })();
    return dropping;
  };
  try {
    await migrateDb(db);
  } catch (e) {
    await drop().catch(() => {});
    throw e;
  }
  return { db, url, name, drop };
}

/** A database with nothing in it (not even the migrations), for a restore test. `drop()` as for `createTestDb`. */
export async function createEmptyDb(baseUrl = process.env.DATABASE_URL) {
  const { name, url, remove } = await createBlank(baseUrl);
  return { name, url, drop: remove };
}
