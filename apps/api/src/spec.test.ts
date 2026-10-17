import { expect, test } from "bun:test";
import { buildSpec, specApp } from "./spec";

const committed = Bun.file(new URL("../../../docs/openapi.json", import.meta.url));

test("docs/openapi.json is current (regenerate with `bun run openapi`)", async () => {
  expect(await committed.text()).toBe(await buildSpec());
});

test("every API operation documents its guard, audit action and the problems it can answer", async () => {
  const spec = JSON.parse(await buildSpec()) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const ops = Object.entries(spec.paths)
    .filter(
      ([path]) =>
        !["/health", "/ready"].includes(path) &&
        !path.startsWith("/auth/") &&
        !path.startsWith("/webhooks/"),
    )
    .flatMap(([path, item]) =>
      Object.entries(item).map(([method, op]) => ({
        id: `${method.toUpperCase()} ${path}`,
        method,
        op,
      })),
    );
  expect(ops.length).toBe(84); // 5 per resource (list, get, create, update, delete; sync targets too) + plan, apply, run and drift of a sync target + 3 for tokens + 4 for connections + 2 for imports + 1 webhook secret + 13 per level of variables (3 levels) + the resolved set + the search + 3 for a pipeline (read, preview, apply) + 3 for upgrading a template's projects (list, plan, apply) + 3 for pipeline runs (list, latest, retry)
  for (const { id, method, op } of ops) {
    const codes = Object.keys(op.responses as object).sort();
    const writes = method !== "get";
    // A POST that is exempt from audit is a read with a body (a search): it has no conflicts to report.
    const readOnly = op["x-no-audit"] !== undefined;
    const expected = writes
      ? ["400", "401", "403", "404", ...(readOnly ? [] : ["409"]), "415", "422"]
      : ["400", "401", "403", "404", "422"];
    // Success codes differ per operation (200, 201, 204); the errors must all be there.
    expect([id, expected.filter((c) => !codes.includes(c))]).toEqual([id, []]);
    expect([id, codes.some((c) => c.startsWith("2"))]).toEqual([id, true]);
    expect([id, writes ? Boolean(op["x-audit"] ?? op["x-no-audit"]) : true]).toEqual([id, true]);
    expect([id, Boolean(op["x-guard"] ?? op["x-signed-in"])]).toEqual([id, true]);
  }
});

test("the sign-in operations document their answers and audit actions", async () => {
  const spec = JSON.parse(await buildSpec()) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const answers = (path: string, method: string) =>
    Object.keys((spec.paths[path]?.[method]?.responses ?? {}) as object).sort();
  expect(answers("/auth/login", "get")).toEqual(["302", "422", "503"]);
  expect(answers("/auth/callback", "get")).toEqual([
    "302",
    "400",
    "401",
    "403",
    "422",
    "502",
    "503",
  ]);
  expect(answers("/auth/me", "get")).toEqual(["200", "401"]);
  expect(answers("/auth/logout", "post")).toEqual(["204", "401", "415"]);
  expect(spec.paths["/auth/callback"]?.get?.["x-audit"]).toEqual(["auth.login"]);
  expect(spec.paths["/auth/logout"]?.post?.["x-audit"]).toEqual(["auth.logout"]);
});

test("the webhook receiver is public, documents its answers and has no audit action", async () => {
  const spec = JSON.parse(await buildSpec()) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const op = spec.paths["/webhooks/gitlab/{connectionId}"]?.post;
  expect(Object.keys((op?.responses ?? {}) as object).sort()).toEqual(["200", "400", "401", "413"]);
  expect(op?.["x-public"]).toBeString();
  expect(op?.["x-audit"]).toBeUndefined();
});

test("the document is served as JSON, and the docs UI (which loads CDN scripts) is off", async () => {
  const app = specApp();
  const json = await app.handle(new Request("http://localhost/openapi/json"));
  expect(json.status).toBe(200);
  expect(json.headers.get("content-type")).toContain("application/json");
  const ui = await app.handle(new Request("http://localhost/openapi"));
  expect(await ui.text()).not.toContain("<script");
});
