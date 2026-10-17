import { afterAll, expect, test } from "bun:test";
import { pingDb } from "./index";
import { createTestDb } from "./testing";

const t = await createTestDb();
afterAll(() => t.drop());

test("pingDb resolves against a live database and rejects once it is gone", async () => {
  await pingDb(t.db);
  await t.drop();
  await expect(Promise.resolve(pingDb(t.db))).rejects.toThrow();
});
