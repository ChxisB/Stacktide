import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createRateLimiter, LIMITS, rateLimitPlugin } from "./rate-limit";

const req = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/x", { headers });

describe("windows", () => {
  test("allows `max` requests per window, then says how long to wait, then starts again", () => {
    let t = 1_000_000;
    const l = createRateLimiter({ now: () => t });
    const { max, windowMs } = LIMITS.token_create;
    for (let i = 0; i < max; i++) expect(l.hit("token_create", "a")).toBeUndefined();
    expect(l.hit("token_create", "a")).toBe(windowMs / 1000);
    t += windowMs - 1500;
    expect(l.hit("token_create", "a")).toBe(2); // rounds up
    t += 1500;
    expect(l.hit("token_create", "a")).toBeUndefined(); // the window has ended
  });

  test("keeps classes and clients apart", () => {
    const l = createRateLimiter({ scale: 0.1 }); // login: 3
    for (let i = 0; i < 3; i++) l.hit("login", "ip:1");
    expect(l.hit("login", "ip:1")).toBeDefined();
    expect(l.hit("login", "ip:2")).toBeUndefined();
    expect(l.hit("webhook", "ip:1")).toBeUndefined();
    expect(l.hit("reveal", "ip:1")).toBeUndefined();
  });

  test("the scale multiplies each limit, and one request is always allowed", () => {
    const double = createRateLimiter({ scale: 2 });
    for (let i = 0; i < LIMITS.token_create.max * 2; i++) {
      expect(double.hit("token_create", "a")).toBeUndefined();
    }
    expect(double.hit("token_create", "a")).toBeDefined();
    const tiny = createRateLimiter({ scale: 0.1 }); // token_create: 10 * 0.1 = 1
    expect(tiny.hit("token_create", "a")).toBeUndefined();
    expect(tiny.hit("token_create", "a")).toBeDefined();
  });

  test("a scale that would round a limit down to nothing still lets one request through", () => {
    const l = createRateLimiter({ scale: 0.01 });
    expect(l.hit("token_create", "a")).toBeUndefined();
    expect(l.hit("token_create", "a")).toBeDefined();
  });

  test("tells the owner of each refusal, once per refused request", () => {
    const seen: string[] = [];
    const l = createRateLimiter({ scale: 0.1, onLimited: (c) => seen.push(c) });
    for (let i = 0; i < 5; i++) l.hit("login", "a"); // 3 allowed, 2 refused
    l.hit("webhook", "a");
    expect(seen).toEqual(["login", "login"]);
  });

  test("a refused request does not push the window out", () => {
    let t = 0;
    const l = createRateLimiter({ now: () => t, scale: 0.1 });
    l.hit("token_create", "a");
    t = 100_000;
    expect(l.hit("token_create", "a")).toBe(500);
    t = 599_999;
    expect(l.hit("token_create", "a")).toBe(1);
    t = 600_000;
    expect(l.hit("token_create", "a")).toBeUndefined();
  });
});

describe("the route option", () => {
  test("a route without the limiter that createApp decorates fails, it is not let through", async () => {
    const app = new Elysia().use(rateLimitPlugin).get("/x", () => "ok", { limit: "login" });
    const res = await app.handle(new Request("http://localhost/x"));
    expect(res.status).toBe(500);
  });

  test("a class that does not exist is refused when the route is defined", () => {
    expect(() =>
      new Elysia().use(rateLimitPlugin).get("/x", () => "ok", { limit: "nope" as never }),
    ).toThrow(TypeError);
  });
});

describe("memory", () => {
  test("holds at most maxKeys counters: the oldest goes first", () => {
    const l = createRateLimiter({ maxKeys: 3, scale: 0.1 });
    for (const who of ["a", "b", "c", "d", "e"]) l.hit("token_create", who);
    expect(l.size()).toBe(3);
    // `a` was dropped: its count starts again (one allowed), `e` is still counted (refused)
    expect(l.hit("token_create", "e")).toBeDefined();
  });

  test("counters whose window has ended are swept before a live one is dropped", () => {
    let t = 0;
    const l = createRateLimiter({ maxKeys: 3, now: () => t, scale: 0.1 });
    l.hit("token_create", "live"); // the oldest counter, with a 10-minute window
    l.hit("login", "old1");
    l.hit("login", "old2"); // 5-minute windows
    t = 6 * 60_000;
    l.hit("login", "new"); // full: the two ended windows go, not `live`
    expect(l.size()).toBe(2);
    expect(l.hit("token_create", "live")).toBeDefined(); // 1 allowed at this scale: this is the second
  });
});

describe("the client's address", () => {
  const xff = (v: string) => req({ "x-forwarded-for": v });

  test("with no proxy it is the peer, and X-Forwarded-For is ignored (anyone can send it)", () => {
    const l = createRateLimiter();
    expect(l.clientIp(xff("6.6.6.6"), "10.0.0.1")).toBe("10.0.0.1");
    expect(l.clientIp(req(), undefined)).toBe("unknown");
  });

  test("behind n proxies it is the entry the nearest n-th proxy appended, not what the client claimed", () => {
    const one = createRateLimiter({ proxyHops: 1 });
    expect(one.clientIp(xff("6.6.6.6, 203.0.113.9"), "10.0.0.1")).toBe("203.0.113.9");
    expect(one.clientIp(xff("203.0.113.9"), "10.0.0.1")).toBe("203.0.113.9");
    const two = createRateLimiter({ proxyHops: 2 });
    expect(two.clientIp(xff("6.6.6.6, 203.0.113.9, 10.0.0.7"), "10.0.0.1")).toBe("203.0.113.9");
  });

  test("an entry with a port, or a bracketed IPv6 address, is the address", () => {
    const one = createRateLimiter({ proxyHops: 1 });
    expect(one.clientIp(xff("203.0.113.9:51234"), "10.0.0.1")).toBe("203.0.113.9");
    expect(one.clientIp(xff("[2001:db8::1]:443"), "10.0.0.1")).toBe("2001:db8::1");
    expect(one.clientIp(xff("[2001:db8::1]"), "10.0.0.1")).toBe("2001:db8::1");
    expect(one.clientIp(xff("203.0.113.9:99999999"), "10.0.0.1")).toBe("10.0.0.1");
    expect(one.clientIp(xff("[evil]:80"), "10.0.0.1")).toBe("10.0.0.1");
  });

  test("a header that cannot be used is reported once per cause, and the report names no address", () => {
    const said: string[] = [];
    const none = createRateLimiter({ warn: (m) => said.push(m) });
    none.clientIp(xff("203.0.113.9"), "10.0.0.1");
    none.clientIp(xff("203.0.113.10"), "10.0.0.1");
    none.clientIp(req(), "10.0.0.1"); // no header: nothing to say
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("ORCH_TRUSTED_PROXY_HOPS is 0");
    const one = createRateLimiter({ proxyHops: 1, warn: (m) => said.push(m) });
    one.clientIp(req(), "10.0.0.1"); // a direct caller: nothing to say
    one.clientIp(xff("203.0.113.9"), "10.0.0.1"); // fine
    expect(said).toHaveLength(1);
    one.clientIp(xff("nonsense 198.51.100.7"), "10.0.0.1");
    one.clientIp(xff("more nonsense"), "10.0.0.1");
    expect(said).toHaveLength(2);
    expect(said[1]).toContain("is not an address");
    expect(said.join(" ")).not.toMatch(/\d+\.\d+\.\d+\.\d+|nonsense/);
  });

  test("a chain that is too short, missing or not an address falls back to the peer", () => {
    const two = createRateLimiter({ proxyHops: 2 });
    expect(two.clientIp(xff("203.0.113.9"), "10.0.0.1")).toBe("10.0.0.1");
    const one = createRateLimiter({ proxyHops: 1 });
    expect(one.clientIp(req(), "10.0.0.1")).toBe("10.0.0.1");
    for (const bad of ["not an address", "x".repeat(60), "1.2.3.4 evil", "", "<script>"]) {
      expect(one.clientIp(xff(bad), "10.0.0.1")).toBe("10.0.0.1");
    }
    expect(one.clientIp(xff("2001:db8::1"), "10.0.0.1")).toBe("2001:db8::1");
  });
});
