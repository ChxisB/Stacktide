import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const WRITER = /\b(createVariable|setVariable|deleteVariable|restoreLevel|importLevel|bulkLevel)\b/;

test("only the variable routes and the approval of a change request write variables", async () => {
  const users: string[] = [];
  for await (const f of new Bun.Glob("{apps,packages}/*/src/**/*.{ts,tsx}").scan({ cwd: root })) {
    if (/\.test\.tsx?$/.test(f)) continue;
    if (WRITER.test(await Bun.file(join(root, f)).text())) users.push(f);
  }
  // A new writer must hold a protected environment off (GOV-2) or be added here on purpose.
  // rotate.ts writes only after locking the environment and finding it unprotected; a protected one gets a change request
  expect(users.sort()).toEqual([
    "apps/api/src/rotate.ts",
    "apps/api/src/routes/variables.ts",
    "packages/db/src/change-requests.ts",
    "packages/db/src/variables.ts",
  ]);
});

test("every variable route that writes holds a protected environment off first", async () => {
  const src = await Bun.file(join(root, "apps/api/src/routes/variables.ts")).text();
  const writing = src
    .split(/\n {4}\.(?=(?:get|post|patch|delete|put)\()/)
    .filter((route) => new RegExp(`${WRITER.source}\\(`).test(route));
  // create, update, delete, restore one, restore the level, import, bulk
  expect(writing).toHaveLength(7);
  for (const route of writing) expect(route).toContain("await writable(tx, p)");
});
