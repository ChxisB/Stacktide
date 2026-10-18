import { describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { createDb } from "@orch/db";
import { createApp } from "./app";
import {
  declaredTooLarge,
  edgeHeaders,
  HARDENING_DEFAULTS,
  type Hardening,
  hardeningEnv,
  hardeningOf,
  parseOrigins,
  SECURITY_HEADERS,
} from "./hardening";
import { devPrincipal, type PrincipalResolver } from "./principal";

// Nothing here reaches a query; the client connects lazily, so none opens.
const unusedDb = createDb("postgres://unused:unused@127.0.0.1:1/unused", 1);
const APP = "https://app.example.com";

function setup(hardening: Partial<Hardening> = {}, principal: PrincipalResolver = devPrincipal) {
  const app = createApp({
    logger: createLogger({ write: () => {}, level: "error" }),
    db: unusedDb,
    principal,
    ready: async () => {},
    hardening,
  });
  return (path: string, init?: RequestInit) =>
    app.handle(new Request(`http://localhost${path}`, init));
}

const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("security headers", () => {
  const sameOn = (res: Response) =>
    Object.entries(SECURITY_HEADERS).map(([k]) => [k, res.headers.get(k)]);
  const expected = Object.entries(SECURITY_HEADERS);

  test("are the same fixed set, and they forbid framing, sniffing, caching and loading anything", () => {
    expect(SECURITY_HEADERS).toEqual({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "no-store",
    });
  });

  test("are on a 200, a 404, a 401, a 415 and a 422", async () => {
    const dev = setup();
    const signedOut = setup({}, () => undefined);
    const answers = [
      [200, await dev("/health")],
      [404, await dev("/no/such/route")],
      [401, await signedOut("/organizations")],
      [415, await dev("/organizations", { method: "POST", body: "a=1" })],
      [422, await dev("/organizations", json({ name: 1 }))],
    ] as const;
    for (const [status, res] of answers) {
      expect([status, res.status]).toEqual([status, status]);
      expect([status, sameOn(res)]).toEqual([status, expected]);
    }
  });

  test("are on a 413, which is answered before the route", async () => {
    const big = await setup()("/organizations", json({}, { "content-length": "99999999" }));
    expect(big.status).toBe(413);
    expect(sameOn(big)).toEqual(expected);
  });

  test("HSTS is sent only when the API is served over https", async () => {
    expect((await setup()("/health")).headers.get("strict-transport-security")).toBeNull();
    const res = await setup({ hsts: true })("/health");
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect((await setup({ hsts: true })("/nope")).headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});

describe("CORS", () => {
  const cors = (res: Response) =>
    [...res.headers.keys()].filter((k) => k.startsWith("access-control-")).sort();

  test("is off by default: no origin is allowed and no preflight is answered", async () => {
    const call = setup();
    const res = await call("/health", { headers: { origin: APP } });
    expect(cors(res)).toEqual([]);
    expect(res.headers.get("vary")).toBeNull();
    const pre = await call("/organizations", {
      method: "OPTIONS",
      headers: { origin: APP, "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(404);
    expect(cors(pre)).toEqual([]);
  });

  test("a listed origin gets its own origin back with credentials, and the answer varies by Origin", async () => {
    const call = setup({ corsOrigins: [APP, "http://localhost:5173"] });
    const res = await call("/health", { headers: { origin: APP } });
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-expose-headers")).toBe("x-request-id, retry-after");
    expect(res.headers.get("vary")).toBe("Origin");
    const other = await call("/health", { headers: { origin: "http://localhost:5173" } });
    expect(other.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  test("an origin that is not listed gets nothing, however close it looks", async () => {
    const call = setup({ corsOrigins: [APP] });
    for (const origin of [
      "https://evil.example.com",
      `${APP}.evil.example.com`,
      `${APP}:8443`,
      "http://app.example.com",
      "https://APP.example.com",
      `${APP}/`,
      "null",
      "*",
      "",
    ]) {
      const res = await call("/health", { headers: { origin } });
      expect([origin, cors(res)]).toEqual([origin, []]);
      // the answer still varies by Origin, so a cache cannot hand it to a listed one
      expect([origin, res.headers.get("vary")]).toEqual([origin, "Origin"]);
    }
    expect(cors(await call("/health"))).toEqual([]);
  });

  test("a preflight from a listed origin is answered 204 before any route or sign-in", async () => {
    const call = setup({ corsOrigins: [APP] }, () => undefined);
    const res = await call("/organizations", {
      method: "OPTIONS",
      headers: { origin: APP, "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, PATCH, DELETE");
    expect(res.headers.get("access-control-allow-headers")).toBe(
      "content-type, authorization, x-request-id",
    );
    expect(res.headers.get("access-control-max-age")).toBe("600");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a preflight from another origin, or without the request method, is not answered", async () => {
    const call = setup({ corsOrigins: [APP] });
    const foreign = await call("/organizations", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com", "access-control-request-method": "POST" },
    });
    expect(foreign.status).toBe(404);
    expect(cors(foreign)).toEqual([]);
    const plain = await call("/organizations", { method: "OPTIONS", headers: { origin: APP } });
    expect(plain.status).toBe(404);
    expect(plain.headers.get("access-control-allow-methods")).toBeNull();
    // only OPTIONS is a preflight
    const get = await call("/health", {
      headers: { origin: APP, "access-control-request-method": "POST" },
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-methods")).toBeNull();
  });
});

describe("edgeHeaders", () => {
  test("the origin is matched exactly, not by prefix or case", () => {
    const h = { ...HARDENING_DEFAULTS, corsOrigins: [APP] };
    expect(edgeHeaders(h, APP)["access-control-allow-origin"]).toBe(APP);
    for (const o of [null, `${APP}x`, APP.toUpperCase(), "https://app.example.co"]) {
      expect(edgeHeaders(h, o)["access-control-allow-origin"]).toBeUndefined();
    }
  });
});

describe("parseOrigins", () => {
  test("takes a comma separated list of origins", () => {
    expect(parseOrigins("")).toEqual([]);
    expect(parseOrigins(` ${APP} , http://localhost:5173,,`)).toEqual([
      APP,
      "http://localhost:5173",
    ]);
  });

  test("refuses anything that is not exactly an origin", () => {
    for (const bad of [
      "*",
      "null",
      "app.example.com",
      `${APP}/`,
      `${APP}/path`,
      `${APP}?x=1`,
      "ftp://app.example.com",
      "javascript:alert(1)",
      "https://user:pw@app.example.com",
      "HTTPS://APP.EXAMPLE.COM",
    ]) {
      expect(() => parseOrigins(bad)).toThrow(/not an origin/);
    }
  });
});

describe("environment", () => {
  const parse = (env: Record<string, string>) => {
    const out: Record<string, unknown> = {};
    for (const [k, schema] of Object.entries(hardeningEnv)) {
      const r = schema.safeParse(env[k]);
      out[k] = r.success ? r.data : "invalid";
    }
    return out;
  };

  test("the defaults", () => {
    expect(parse({})).toEqual({
      ORCH_CORS_ORIGINS: [],
      ORCH_MAX_BODY_BYTES: 2 * 1024 * 1024,
      ORCH_TRUSTED_PROXY_HOPS: 0,
      ORCH_RATE_LIMIT_SCALE: 1,
    });
  });

  test("each setting is bounded", () => {
    const bad = (k: string, v: string) => parse({ [k]: v })[k];
    expect(bad("ORCH_MAX_BODY_BYTES", String(1024 * 1024 - 1))).toBe("invalid");
    expect(bad("ORCH_MAX_BODY_BYTES", String(64 * 1024 * 1024 + 1))).toBe("invalid");
    expect(bad("ORCH_MAX_BODY_BYTES", "1500000.5")).toBe("invalid");
    expect(bad("ORCH_MAX_BODY_BYTES", String(1024 * 1024))).toBe(1024 * 1024);
    expect(bad("ORCH_TRUSTED_PROXY_HOPS", "-1")).toBe("invalid");
    expect(bad("ORCH_TRUSTED_PROXY_HOPS", "6")).toBe("invalid");
    expect(bad("ORCH_TRUSTED_PROXY_HOPS", "1.5")).toBe("invalid");
    expect(bad("ORCH_TRUSTED_PROXY_HOPS", "5")).toBe(5);
    expect(bad("ORCH_RATE_LIMIT_SCALE", "0.09")).toBe("invalid");
    expect(bad("ORCH_RATE_LIMIT_SCALE", "101")).toBe("invalid");
    expect(bad("ORCH_RATE_LIMIT_SCALE", "0.1")).toBe(0.1);
    expect(bad("ORCH_CORS_ORIGINS", "*")).toBe("invalid");
    expect(bad("ORCH_CORS_ORIGINS", APP)).toEqual([APP]);
  });
});

describe("hardeningOf", () => {
  test("takes each setting from the environment, and HSTS from whether the API is https", () => {
    const env = {
      ORCH_CORS_ORIGINS: [APP],
      ORCH_MAX_BODY_BYTES: 3_000_000,
      ORCH_TRUSTED_PROXY_HOPS: 2,
      ORCH_RATE_LIMIT_SCALE: 4,
    };
    expect(hardeningOf(env, true)).toEqual({
      corsOrigins: [APP],
      maxBodyBytes: 3_000_000,
      hsts: true,
      proxyHops: 2,
      rateLimitScale: 4,
    });
    expect(hardeningOf(env, false).hsts).toBe(false);
  });
});

describe("body cap", () => {
  const request = (length: string | null) =>
    new Request("http://localhost/x", {
      method: "POST",
      headers: length === null ? {} : { "content-length": length },
    });
  const h = { ...HARDENING_DEFAULTS, maxBodyBytes: 1000 };

  test("a declared length over the cap is too large, one at the cap is not", () => {
    expect(declaredTooLarge(h, request("1001"))).toBe(true);
    expect(declaredTooLarge(h, request("1000"))).toBe(false);
    expect(declaredTooLarge(h, request("0"))).toBe(false);
  });

  test("a length that is not a plain number, or not declared, is the server's to stop", () => {
    for (const odd of [null, "", "abc", "-5", "1e9", "1001, 1001", "0x7d0"]) {
      expect([odd, declaredTooLarge(h, request(odd))]).toEqual([odd, false]);
    }
    // however many digits, a number over the cap is over the cap
    for (const huge of ["9999999999999999", "9".repeat(400)]) {
      expect([huge, declaredTooLarge(h, request(huge))]).toEqual([huge, true]);
    }
  });

  test("an API call over the cap is refused 413 before sign-in, in the problem format", async () => {
    // the signed-out answer would be 401: the size is judged first
    const call = setup({ maxBodyBytes: 1000 }, () => undefined);
    const res = await call("/organizations", json({}, { "content-length": "1001" }));
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 413,
      code: "payload_too_large",
      title: "Content Too Large",
    });
    expect(typeof body.request_id).toBe("string");
    expect(res.headers.get("x-request-id")).toBe(body.request_id as string);
  });

  test("a call at the cap goes on to the route", async () => {
    const call = setup({ maxBodyBytes: 1000 }, () => undefined);
    const res = await call("/organizations", json({}, { "content-length": "1000" }));
    expect(res.status).toBe(401);
  });
});
