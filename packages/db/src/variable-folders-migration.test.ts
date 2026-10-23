import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createDb, migrateDb } from "./index";
import { pgConstraint } from "./pg-error";
import { createEmptyDb } from "./testing";

const drizzle = fileURLToPath(new URL("../drizzle", import.meta.url));

/** A copy of the migrations up to and including `tag`: a database as it was before the next one. */
function upTo(tag: string) {
  const dir = mkdtempSync(join(tmpdir(), "orch-migrations-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(drizzle, "meta/_journal.json"), "utf8"));
  const last = journal.entries.findIndex((e: { tag: string }) => e.tag === tag);
  journal.entries = journal.entries.slice(0, last + 1);
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries)
    copyFileSync(join(drizzle, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

describe("0059: variables get a folder", () => {
  test("variables made before it stay at the root, keep their keys unique, and can then be put in a folder", async () => {
    const empty = await createEmptyDb();
    const db = createDb(empty.url, 2);
    try {
      await migrate(db, { migrationsFolder: upTo("0058_variable_folders") });
      const one = async (q: ReturnType<typeof sql>) => (await db.execute(q))[0] as { id: string };
      const org = await one(
        sql`INSERT INTO organizations (slug, name) VALUES ('o', 'O') RETURNING id`,
      );
      const project = await one(
        sql`INSERT INTO projects (organization_id, name) VALUES (${org.id}, 'p') RETURNING id`,
      );
      const env = await one(
        sql`INSERT INTO environments (organization_id, project_id, name, slug) VALUES (${org.id}, ${project.id}, 'Prod', 'prod') RETURNING id`,
      );
      const add = (key: string, projectId: string | null, environmentId: string | null) =>
        db.execute(
          sql`INSERT INTO variables (organization_id, project_id, environment_id, key, kind) VALUES (${org.id}, ${projectId}, ${environmentId}, ${key}, 'plain')`,
        );
      await add("ORG", null, null);
      await add("PROJ", project.id, null);
      await add("ENV", project.id, env.id);

      await migrateDb(db);

      const rows = (await db.execute(sql`SELECT key, folder_id FROM variables ORDER BY key`)) as {
        key: string;
        folder_id: string | null;
      }[];
      expect(rows.map((r) => [r.key, r.folder_id])).toEqual([
        ["ENV", null],
        ["ORG", null],
        ["PROJ", null],
      ]);

      // the re-made indexes still hold a root key once per level ...
      for (const [key, projectId, environmentId, name] of [
        ["ORG", null, null, "variables_org_key"],
        ["PROJ", project.id, null, "variables_project_key"],
        ["ENV", project.id, env.id, "variables_environment_key"],
      ] as const) {
        const error = await add(key, projectId, environmentId).then(
          () => undefined,
          (e: unknown) => pgConstraint(e),
        );
        expect(error).toBe(name);
      }
      // ... and a folder now holds a variable of the same key
      const folder = await one(
        sql`INSERT INTO variable_folders (organization_id, project_id, path) VALUES (${org.id}, ${project.id}, '/a') RETURNING id`,
      );
      await db.execute(
        sql`INSERT INTO variables (organization_id, project_id, key, kind, folder_id) VALUES (${org.id}, ${project.id}, 'PROJ', 'plain', ${folder.id})`,
      );
    } finally {
      await db.$client.close();
      await empty.drop();
    }
  });
});
