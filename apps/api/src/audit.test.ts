import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, DomainError } from "@orch/core";
import { auditEvents, createOrganization, organizations } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq, inArray } from "drizzle-orm";
import { Elysia } from "elysia";
import { createApp } from "./app";
import { unauditedRoutes } from "./audit";
import { devPrincipal } from "./principal";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const CANARY = "SECRET-CANARY-5521";
const uniq = () => crypto.randomUUID().slice(0, 8);

function setup() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ write: (l) => lines.push(JSON.parse(l)), level: "debug" });
  const slugOf = (request: Request) => new URL(request.url).searchParams.get("slug") ?? uniq();
  const app = createApp({ logger, db: t.db, principal: devPrincipal, ready: async () => {} })
    .post(
      "/things",
      ({ request, audit }) =>
        t.db.transaction(async (tx) => {
          const org = await createOrganization(tx, { slug: slugOf(request), name: "T" });
          await audit(tx, {
            action: "thing.create",
            resourceType: "organization",
            resourceId: org.id,
            organizationId: org.id,
            metadata: { slug: org.slug },
          });
          return { id: org.id };
        }),
      { audit: "thing.create" },
    )
    // A route that learns who the caller is while handling the request (sign-in) names them itself.
    .post(
      "/as-someone",
      ({ audit }) =>
        t.db.transaction((tx) =>
          audit(
            tx,
            { action: "thing.one", resourceType: "thing" },
            { kind: "dev", id: "someone-else" },
          ),
        ),
      { audit: "thing.one" },
    )
    .post(
      "/multi",
      ({ audit }) =>
        t.db.transaction(async (tx) => {
          await audit(tx, { action: "thing.one", resourceType: "thing" });
          await audit(tx, { action: "thing.two", resourceType: "thing" });
          return "ok";
        }),
      { audit: ["thing.one", "thing.two"] },
    )
    // Declared, but the handler forgot to audit its change.
    .post(
      "/forgot",
      ({ request }) =>
        createOrganization(t.db, { slug: slugOf(request), name: "T" }).then((o) => ({ id: o.id })),
      { audit: "thing.create" },
    )
    // Audits an action the route did not declare.
    .post(
      "/wrong",
      ({ request, audit }) =>
        t.db.transaction(async (tx) => {
          await createOrganization(tx, { slug: slugOf(request), name: "T" });
          await audit(tx, { action: "thing.delete", resourceType: "thing" });
          return "ok";
        }),
      { audit: "thing.create" },
    )
    .post(
      "/leaky",
      ({ request, audit }) =>
        t.db.transaction(async (tx) => {
          await createOrganization(tx, { slug: slugOf(request), name: "T" });
          await audit(tx, {
            action: "thing.create",
            resourceType: "thing",
            metadata: { value: CANARY },
          });
          return "ok";
        }),
      { audit: "thing.create" },
    )
    .post(
      "/conflict",
      () => {
        throw new DomainError("conflict", 409, "Already there");
      },
      { audit: "thing.create" },
    )
    // A handled refusal: returned (not thrown), so `set.status` stays untouched.
    .post("/refuse", ({ status }) => status(409, { code: "conflict" }), { audit: "thing.create" })
    .post("/refuse-raw", () => new Response("no", { status: 404 }), { audit: "thing.create" })
    // Exempt routes write no audit rows.
    .post(
      "/exempt-writes",
      ({ audit }) =>
        t.db.transaction((tx) => audit(tx, { action: "thing.one", resourceType: "thing" })),
      { noAudit: "test: should not be able to audit" },
    )
    .delete("/quiet", () => "ok", { noAudit: "test route that changes nothing" });
  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    app.handle(new Request(`http://localhost${path}`, { method, headers }));
  const orgs = (slug: string) =>
    t.db.select().from(organizations).where(eq(organizations.slug, slug));
  return { app, call, lines, orgs };
}

describe("declared audit", () => {
  test("a mutation and its audit row commit together, with the caller and request id", async () => {
    const { call } = setup();
    const res = await call("POST", `/things?slug=a-${uniq()}`, { "x-request-id": "req-audit-1" });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const [row] = await t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, id));
    expect(row).toMatchObject({
      actorKind: "dev",
      actorId: "dev",
      action: "thing.create",
      resourceType: "organization",
      organizationId: id,
      requestId: "req-audit-1",
      ip: null, // no socket when called through app.handle
    });
  });

  test("a route may name the actor itself; the request's principal is the default", async () => {
    const { call } = setup();
    expect((await call("POST", "/as-someone", { "x-request-id": "req-actor" })).status).toBe(200);
    const [row] = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.requestId, "req-actor"));
    expect(row).toMatchObject({ actorKind: "dev", actorId: "someone-else" });
  });

  test("a route may declare several actions and write each", async () => {
    const { call } = setup();
    expect((await call("POST", "/multi", { "x-request-id": "req-multi" })).status).toBe(200);
    const rows = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.requestId, "req-multi"));
    expect(rows.map((r) => r.action).sort()).toEqual(["thing.one", "thing.two"]);
  });

  test("a success that wrote no audit row is a generic 500, and says so in the log", async () => {
    const { call, lines } = setup();
    const res = await call("POST", `/forgot?slug=f-${uniq()}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      code: "internal_error",
      detail: "Internal server error",
    });
    expect(JSON.stringify(lines)).toContain("declared audit thing.create but wrote none");
  });

  test("an undeclared action is refused and the change rolls back with it", async () => {
    const { call, orgs } = setup();
    const slug = `w-${uniq()}`;
    expect((await call("POST", `/wrong?slug=${slug}`)).status).toBe(500);
    expect(await orgs(slug)).toEqual([]);
  });

  test("a metadata value is refused, rolls the change back, and is not echoed or logged", async () => {
    const { call, orgs, lines } = setup();
    const slug = `l-${uniq()}`;
    const res = await call("POST", `/leaky?slug=${slug}`);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(CANARY);
    expect(JSON.stringify(lines)).not.toContain(CANARY);
    expect(await orgs(slug)).toEqual([]);
    const rows = await t.db
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.action, ["thing.create"]));
    expect(JSON.stringify(rows)).not.toContain(CANARY);
  });

  test("a failed request needs no audit row; noAudit routes need none either", async () => {
    const { call } = setup();
    expect((await call("POST", "/conflict")).status).toBe(409);
    expect((await call("DELETE", "/quiet")).status).toBe(200);
  });

  test("a returned error response needs no audit row either", async () => {
    const { call } = setup();
    expect((await call("POST", "/refuse")).status).toBe(409);
    expect((await call("POST", "/refuse-raw")).status).toBe(404);
  });

  test("a route that did not declare audit cannot write audit rows", async () => {
    const { call } = setup();
    expect((await call("POST", "/exempt-writes")).status).toBe(500);
  });

  test("a request id is recorded even when the caller sent none", async () => {
    const { call } = setup();
    const { id } = (await (await call("POST", `/things?slug=n-${uniq()}`)).json()) as {
      id: string;
    };
    const [row] = await t.db.select().from(auditEvents).where(eq(auditEvents.resourceId, id));
    expect(row?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("noAudit needs a reason", () => {
    expect(() => new Elysia().use(setup().app).post("/x", () => 1, { noAudit: " " })).toThrow(
      TypeError,
    );
  });
});

describe("route coverage", () => {
  const fresh = () => setup().app;

  test("every mutating route of the app declares audit or noAudit", () => {
    expect(unauditedRoutes(fresh())).toEqual([]);
  });

  test("the check flags a mutating route that declares neither, also inside plugins", () => {
    const bad = fresh()
      .post("/orphan", () => 1)
      .put("/orphan2", () => 1)
      .use(new Elysia().delete("/in-plugin", () => 1))
      .get("/read", () => 1);
    expect(unauditedRoutes(bad).sort()).toEqual([
      "DELETE /in-plugin",
      "POST /orphan",
      "PUT /orphan2",
    ]);
  });

  test("the declarations are visible to OpenAPI as x-audit / x-no-audit", () => {
    const detail = (path: string) => {
      const hooks = fresh().routes.find((r) => r.path === path)?.hooks as { detail?: object };
      return hooks.detail;
    };
    expect(detail("/multi")).toEqual({ "x-audit": ["thing.one", "thing.two"] });
    expect(detail("/quiet")).toEqual({ "x-no-audit": "test route that changes nothing" });
  });
});
