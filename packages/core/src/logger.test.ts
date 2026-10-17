import { describe, expect, test } from "bun:test";
import { createLogger } from "./logger";

const CANARY = "SECRET-CANARY-9f3a";

function capture(level?: "debug" | "info" | "warn" | "error") {
  const lines: string[] = [];
  const log = createLogger({ write: (l) => lines.push(l), level });
  const out = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { log, lines, out };
}

describe("createLogger", () => {
  test("writes one JSON line with time, level and msg", () => {
    const { log, out } = capture();
    log.info("hello", { requestId: "r1" });
    const [line] = out();
    expect(line).toMatchObject({ level: "info", msg: "hello", requestId: "r1" });
    expect(typeof line?.time).toBe("string");
  });

  test("redacts sensitive keys at any depth, including inside arrays", () => {
    const { log, lines, out } = capture();
    log.info("x", {
      password: CANARY,
      nested: { apiToken: CANARY, deeper: [{ client_secret: CANARY }, { ok: "visible" }] },
      variable: { name: "DB_URL", value: CANARY },
      privateKey: CANARY,
    });
    expect(lines.join("")).not.toContain(CANARY);
    const [line] = out();
    expect(line?.password).toBe("[REDACTED]");
    expect(line?.variable).toEqual({ name: "DB_URL", value: "[REDACTED]" });
    expect(JSON.stringify(line)).toContain("visible");
  });

  test("redacts headers given as a plain object", () => {
    const { log, lines, out } = capture();
    log.info("req", {
      headers: { Authorization: `Bearer ${CANARY}`, Cookie: `s=${CANARY}`, "x-trace": "t1" },
    });
    expect(lines.join("")).not.toContain(CANARY);
    const headers = out()[0]?.headers as Record<string, string> | undefined;
    expect(headers?.["x-trace"]).toBe("t1");
  });

  test("redacts headers given as a Headers instance", () => {
    const { log, lines, out } = capture();
    log.info("req", {
      headers: new Headers({ authorization: `Bearer ${CANARY}`, "x-trace": "t1" }),
    });
    expect(lines.join("")).not.toContain(CANARY);
    expect(out()[0]?.headers).toEqual({ authorization: "[REDACTED]", "x-trace": "t1" });
  });

  test("redacts bindings from child loggers", () => {
    const { log, lines, out } = capture();
    log.child({ component: "sync", token: CANARY }).info("go");
    expect(lines.join("")).not.toContain(CANARY);
    expect(out()[0]).toMatchObject({ component: "sync", token: "[REDACTED]" });
  });

  test("redacts other common secret-bearing key names", () => {
    const { log, lines } = capture();
    log.info("x", {
      credentials: { u: CANARY },
      jwt: CANARY,
      sessionId: CANARY,
      dsn: CANARY,
      connectionString: CANARY,
    });
    expect(lines.join("")).not.toContain(CANARY);
  });

  test("scrubs secrets embedded in string values, messages and error text", () => {
    const { log, lines } = capture();
    log.info(`clone https://oauth2:${CANARY}@gitlab.com/g/p.git`, {
      url: `https://gitlab.com/api?private_token=${CANARY}&per_page=5`,
      note: `sent Authorization: Bearer ${CANARY}`,
      err: new Error(`401 from https://x/?token=${CANARY}`),
    });
    const text = lines.join("");
    expect(text).not.toContain(CANARY);
    expect(text).toContain("per_page=5");
    expect(text).toContain("gitlab.com/g/p.git");
  });

  test("scrubbing stays linear on hostile input (no ReDoS)", () => {
    const { log } = capture();
    const hostile = `?${"token".repeat(40_000)}`;
    const started = performance.now();
    log.info("req", { url: hostile, other: `//${"a".repeat(100_000)}` });
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("redacts pwd and private keys", () => {
    const { log, lines } = capture();
    log.info("x", { pwd: CANARY, private: CANARY });
    expect(lines.join("")).not.toContain(CANARY);
  });

  test("keeps error code and cause, redacted", () => {
    const { log, lines, out } = capture();
    const cause = Object.assign(new Error("inner"), { code: "ECONNRESET" });
    log.error("failed", { err: new Error(`outer ${CANARY}`, { cause }) });
    const err = out()[0]?.err as { cause?: { code?: string; message?: string } } | undefined;
    expect(err?.cause).toMatchObject({ message: "inner", code: "ECONNRESET" });
    expect(lines.join("")).toContain("outer");
  });

  test("keeps Map, Set and URL contents instead of dropping them", () => {
    const { log, lines, out } = capture();
    log.info("x", {
      m: new Map([
        ["name", "a"],
        ["apiToken", CANARY],
      ]),
      s: new Set(["x", "y"]),
      u: new URL(`https://user:${CANARY}@host.test/path`),
    });
    expect(lines.join("")).not.toContain(CANARY);
    expect(out()[0]).toMatchObject({
      m: { name: "a", apiToken: "[REDACTED]" },
      s: ["x", "y"],
    });
    expect(String(out()[0]?.u)).toContain("host.test/path");
  });

  test("a throwing getter does not throw out of the logger", () => {
    const { log, out } = capture();
    const bad = {
      get boom(): string {
        throw new Error("nope");
      },
    };
    expect(() => log.info("x", { bad })).not.toThrow();
    expect(out()).toHaveLength(1);
  });

  test("an unknown level falls back to info, not debug", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (l) => lines.push(l), level: "WARNING" as never });
    log.debug("d");
    log.info("i");
    expect(lines).toHaveLength(1);
  });

  test("masks binary buffers (key material) and survives bigint", () => {
    const { log, lines, out } = capture();
    log.info("bin", { dek: Buffer.from(CANARY), raw: new Uint8Array([1, 2, 3]), n: 10n });
    expect(lines.join("")).not.toContain(CANARY);
    expect(out()[0]).toMatchObject({ dek: "[Binary]", raw: "[Binary]", n: "10" });
  });

  test("serialises errors without throwing and keeps the message", () => {
    const { log, out } = capture();
    log.error("failed", { err: new Error("boom") });
    const err = out()[0]?.err as Record<string, unknown> | undefined;
    expect(err?.message).toBe("boom");
  });

  test("survives circular references", () => {
    const { log, out } = capture();
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    log.info("loop", { a });
    expect(out()[0]?.a).toEqual({ name: "a", self: "[Circular]" });
  });

  test("filters below the configured level", () => {
    const { log, lines } = capture("warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines).toHaveLength(2);
  });
});
