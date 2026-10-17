import { expect, test } from "bun:test";
import { buildSpec, specApp } from "./spec";

const committed = Bun.file(new URL("../../../docs/openapi.json", import.meta.url));

test("docs/openapi.json is current (regenerate with `bun run openapi`)", async () => {
  expect(await committed.text()).toBe(await buildSpec());
});

test("every API operation documents its audit action and the problems it can answer", async () => {
  const spec = JSON.parse(await buildSpec()) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const ops = Object.entries(spec.paths)
    .filter(([path]) => path !== "/health" && path !== "/ready")
    .flatMap(([path, item]) =>
      Object.entries(item).map(([method, op]) => ({
        id: `${method.toUpperCase()} ${path}`,
        method,
        op,
      })),
    );
  expect(ops.length).toBe(15); // 5 per resource: list, get, create, update, delete
  for (const { id, method, op } of ops) {
    const codes = Object.keys(op.responses as object).sort();
    const writes = method !== "get";
    const expected = writes ? ["400", "404", "409", "415", "422"] : ["400", "404", "422"];
    // Success codes differ per operation (200, 201, 204); the errors must all be there.
    expect([id, expected.filter((c) => !codes.includes(c))]).toEqual([id, []]);
    expect([id, codes.some((c) => c.startsWith("2"))]).toEqual([id, true]);
    expect([id, writes ? Boolean(op["x-audit"]) : true]).toEqual([id, true]);
  }
});

test("the document is served as JSON, and the docs UI (which loads CDN scripts) is off", async () => {
  const app = specApp();
  const json = await app.handle(new Request("http://localhost/openapi/json"));
  expect(json.status).toBe(200);
  expect(json.headers.get("content-type")).toContain("application/json");
  const ui = await app.handle(new Request("http://localhost/openapi"));
  expect(await ui.text()).not.toContain("<script");
});
