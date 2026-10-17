import { describe, expect, test } from "bun:test";
import { createLogger, DomainError } from "@orch/core";
import { createDb } from "@orch/db";
import { Elysia, status, t } from "elysia";
import { createApp } from "./app";
import { devPrincipal, principalPlugin } from "./principal";

const CANARY = "SECRET-CANARY-9f3a";
// These tests never reach a route that queries; the client connects lazily, so none opens.
const unusedDb = createDb("postgres://unused:unused@127.0.0.1:1/unused", 1);

function setup(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ write: (l) => lines.push(JSON.parse(l)), level: "debug" });
  const app = createApp({
    logger,
    db: unusedDb,
    principal: devPrincipal,
    ready: async () => {},
    ...over,
  });
  const call = (path: string, init?: RequestInit) =>
    app.handle(new Request(`http://localhost${path}`, init));
  return { app, call, lines };
}

/** `onAfterResponse` runs after `handle()` has returned, so wait for the line to appear. */
async function requestLines(lines: Record<string, unknown>[], count = 1) {
  for (let i = 0; i < 100 && lines.filter((l) => l.msg === "request").length < count; i++) {
    await Bun.sleep(2);
  }
  return lines.filter((l) => l.msg === "request");
}

describe("health and readiness", () => {
  test("/health answers without touching dependencies", async () => {
    const { call } = setup({
      ready: async () => {
        throw new Error("db down");
      },
    });
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("/ready is 200 when the dependency check passes", async () => {
    const res = await setup().call("/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready" });
  });

  test("/ready is a 503 problem without internals when the check fails", async () => {
    const { call, lines } = setup({
      ready: async () => {
        throw new Error(`connect ECONNREFUSED postgres://orch:${CANARY}@db:5432/orch`);
      },
    });
    const res = await call("/ready");
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(JSON.parse(text)).toMatchObject({ status: 503, code: "not_ready" });
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  test("concurrent /ready calls share one dependency check", async () => {
    let calls = 0;
    const { call } = setup({
      ready: async () => {
        calls++;
        await Bun.sleep(30);
      },
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => call("/ready")));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(calls).toBe(1);
    await call("/ready");
    expect(calls).toBe(2);
  });

  test("/ready gives up on a hanging check", async () => {
    const { call } = setup({ ready: () => new Promise(() => {}), readyTimeoutMs: 30 });
    const res = await call("/ready");
    expect(res.status).toBe(503);
  });
});

describe("request id", () => {
  test("is generated, returned as a header and in the problem body", async () => {
    const { call } = setup();
    const ok = await call("/health");
    const id = ok.headers.get("x-request-id") ?? "";
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const missing = await call("/nope");
    expect(((await missing.json()) as { request_id: string }).request_id).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  test("a well-formed inbound id is kept", async () => {
    const res = await setup().call("/health", { headers: { "x-request-id": "trace-abc.123_X" } });
    expect(res.headers.get("x-request-id")).toBe("trace-abc.123_X");
  });

  test("a malformed or oversized inbound id is replaced", async () => {
    const { call } = setup();
    for (const bad of ["has space", "a".repeat(129), "<script>", "xé"]) {
      const res = await call("/health", { headers: { "x-request-id": bad } });
      expect(res.headers.get("x-request-id")).not.toBe(bad);
      expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe("error mapping", () => {
  const withRoutes = () => {
    const s = setup();
    const app = s.app
      .get("/domain", () => {
        throw new DomainError("project_not_found", 404, "Project not found");
      })
      .get("/boom", () => {
        throw new Error(`kaboom ${CANARY} at /etc/passwd`);
      })
      .post("/typed", ({ body }) => body, {
        body: t.Object({ name: t.String({ pattern: "^[0-9]+$" }) }),
      })
      .use(
        new Elysia().get("/plugin-boom", () => {
          throw new DomainError("teapot", 418, "I am a teapot");
        }),
      );
    return {
      ...s,
      call: (path: string, init?: RequestInit) =>
        app.handle(new Request(`http://localhost${path}`, init)),
    };
  };

  test("a domain error becomes problem+json with its status and code", async () => {
    const res = await withRoutes().call("/domain");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toEqual({
      type: "urn:orch:problem:project_not_found",
      title: "Not Found",
      status: 404,
      code: "project_not_found",
      detail: "Project not found",
      request_id: res.headers.get("x-request-id"),
    });
  });

  test("domain errors from a mounted plugin are mapped too", async () => {
    const res = await withRoutes().call("/plugin-boom");
    expect(res.status).toBe(418);
    expect(((await res.json()) as { code: string }).code).toBe("teapot");
  });

  test("an unknown error is a generic 500 with no internals, logged with the request id", async () => {
    const { call, lines } = withRoutes();
    const res = await call("/boom");
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      type: "urn:orch:problem:internal_error",
      title: "Internal Server Error",
      status: 500,
      code: "internal_error",
      detail: "Internal server error",
      request_id: res.headers.get("x-request-id"),
    });
    expect(text).not.toMatch(/kaboom|passwd|stack|\.ts/);
    const logged = lines.find((l) => l.level === "error");
    expect(logged?.request_id).toBe(res.headers.get("x-request-id"));
    expect(JSON.stringify(logged)).toContain("kaboom");
  });

  test("a thrown or returned Elysia status() keeps its status, without echoing its payload", async () => {
    const s = setup();
    const app = s.app
      .get("/thrown", () => {
        throw status(409, `already exists ${CANARY}`);
      })
      .get("/returned", () => status(409, `already exists ${CANARY}`))
      .get("/created", () => status(201, { ok: true }));
    for (const path of ["/thrown", "/returned"]) {
      const res = await app.handle(new Request(`http://localhost${path}`));
      const text = await res.text();
      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(JSON.parse(text).code).toBe("http_409");
      expect(text).not.toContain(CANARY);
    }
    const created = await app.handle(new Request("http://localhost/created"));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ ok: true });
    expect(JSON.stringify(s.lines.filter((l) => l.level === "error"))).toBe("[]");
  });

  test("an unknown route is a 404 problem", async () => {
    const res = await withRoutes().call("/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  test("a validation failure is a 422 listing paths but never the submitted value", async () => {
    const res = await withRoutes().call("/typed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: CANARY }),
    });
    const text = await res.text();
    expect(res.status).toBe(422);
    const body = JSON.parse(text) as { code: string; errors: { path: string }[] };
    expect(body.code).toBe("validation_failed");
    expect(body.errors.map((e) => e.path)).toContain("/name");
    expect(text).not.toContain(CANARY);
  });

  test("malformed JSON is a 400 problem without a parser trace", async () => {
    const res = await withRoutes().call("/typed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"name": ${CANARY}`,
    });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(JSON.parse(text).code).toBe("bad_request");
    expect(text).not.toContain(CANARY);
  });

  test("DomainError rejects statuses outside 4xx/5xx", () => {
    expect(() => new DomainError("x", 200, "ok")).toThrow(RangeError);
    expect(() => new DomainError("x", 700, "no")).toThrow(RangeError);
  });
});

describe("access log", () => {
  test("one line per request with method, path, status and duration, never the query", async () => {
    const { call, lines } = setup();
    const res = await call(`/health?token=${CANARY}`);
    const entries = await requestLines(lines);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      method: "GET",
      path: "/health",
      status: 200,
      request_id: res.headers.get("x-request-id"),
    });
    expect(typeof entries[0]?.duration_ms).toBe("number");
    expect(JSON.stringify(lines)).not.toContain(CANARY);
  });

  test("a status set by name is logged as its number", async () => {
    const s = setup();
    const app = s.app.get("/named", ({ set }) => {
      set.status = "Not Found";
      return "nothing here";
    });
    await app.handle(new Request("http://localhost/named"));
    expect((await requestLines(s.lines))[0]).toMatchObject({ path: "/named", status: 404 });
  });

  test("error responses are logged with their real status", async () => {
    const { call, lines } = setup();
    await call("/nope");
    expect((await requestLines(lines))[0]).toMatchObject({ path: "/nope", status: 404 });
  });
});

describe("principal", () => {
  test("routes after createApp see ctx.principal, public routes do not need it", async () => {
    const deny = async () => {
      throw new DomainError("unauthenticated", 401, "Authentication required");
    };
    const { app, call } = setup({ principal: deny });
    const guarded = app.get("/who", ({ principal }) => principal);
    const hit = (p: string) => guarded.handle(new Request(`http://localhost${p}`));
    expect((await hit("/health")).status).toBe(200);
    expect((await hit("/who")).status).toBe(401);
    expect(await call("/health").then((r) => r.status)).toBe(200);
  });

  test("the dev stub identifies as a dev principal, also inside mounted plugins", async () => {
    const { app } = setup();
    const full = app
      .get("/who", ({ principal }) => principal)
      .use(
        new Elysia().use(principalPlugin(devPrincipal)).get("/who2", ({ principal }) => principal),
      );
    for (const path of ["/who", "/who2"]) {
      const res = await full.handle(new Request(`http://localhost${path}`));
      expect(await res.json()).toEqual({ id: "dev", kind: "dev" });
    }
  });
});
