import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ConfigError, loadConfig } from "./config";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  API_TOKEN: z.string().min(20),
});

describe("loadConfig", () => {
  test("returns parsed and coerced values", () => {
    const cfg = loadConfig(schema, {
      PORT: "8080",
      DATABASE_URL: "postgres://x",
      API_TOKEN: "a".repeat(20),
    });
    expect(cfg).toEqual({ PORT: 8080, DATABASE_URL: "postgres://x", API_TOKEN: "a".repeat(20) });
  });

  test("applies schema defaults", () => {
    const cfg = loadConfig(schema, { DATABASE_URL: "postgres://x", API_TOKEN: "a".repeat(20) });
    expect(cfg.PORT).toBe(3000);
  });

  test("throws listing every bad key and never the values", () => {
    const err = failure({ PORT: "not-a-number-hunter2", API_TOKEN: "short-SECRET-CANARY" });
    expect([...err.keys].sort()).toEqual(["API_TOKEN", "DATABASE_URL", "PORT"]);
    for (const key of err.keys) expect(err.message).toContain(key);
    const everything = `${err.message}\n${err.stack}\n${JSON.stringify(err)}`;
    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain("SECRET-CANARY");
  });

  test("says whether a key is missing or invalid", () => {
    const err = failure({ PORT: "abc", API_TOKEN: "short" });
    expect(err.message).toContain("DATABASE_URL (missing)");
    expect(err.message).not.toContain("PORT (missing)");
    expect(err.message).not.toContain("API_TOKEN (missing)");
  });

  test("a missing key that has a default is not reported", () => {
    const err = failure({});
    expect(err.keys).not.toContain("PORT");
    expect(err.keys).toContain("DATABASE_URL");
  });
});

function failure(env: Record<string, string>): ConfigError {
  try {
    loadConfig(schema, env);
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error("expected loadConfig to throw");
}
