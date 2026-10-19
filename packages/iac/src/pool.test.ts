import { describe, expect, test } from "bun:test";
import { type PoolRef, resolvePool } from "./pool";

const pool = (name: string, over: Partial<PoolRef> = {}): PoolRef => ({
  name,
  tags: [name],
  image: null,
  enabled: true,
  isDefault: false,
  ...over,
});
const prod = pool("prod");
const dev = pool("dev", { isDefault: true });

describe("resolvePool", () => {
  test("a stack's own pool is the one it names, even when the organization has a default", () => {
    expect(resolvePool("prod", [prod, dev])).toEqual({ kind: "pool", pool: prod });
    expect(resolvePool("dev", [prod, dev])).toEqual({ kind: "pool", pool: dev });
  });

  test("a stack that names none gets the default", () => {
    expect(resolvePool(undefined, [prod, dev])).toEqual({ kind: "pool", pool: dev });
  });

  test("no pool named and no default is today's behaviour: none", () => {
    expect(resolvePool(undefined, [prod])).toEqual({ kind: "none" });
    expect(resolvePool(undefined, [])).toEqual({ kind: "none" });
  });

  test("a name that is not a pool is unknown, never the default and never none", () => {
    expect(resolvePool("nope", [prod, dev])).toEqual({ kind: "unknown", name: "nope" });
    expect(resolvePool("nope", [])).toEqual({ kind: "unknown", name: "nope" });
    // a name is exact
    expect(resolvePool("Prod", [prod])).toEqual({ kind: "unknown", name: "Prod" });
  });

  test("a disabled pool is refused by name, whether it was named or is the default (the table forbids the latter; this does not rely on it)", () => {
    const off = pool("off", { enabled: false });
    expect(resolvePool("off", [off, dev])).toEqual({ kind: "disabled", name: "off" });
    const oddDefault = pool("odd", { enabled: false, isDefault: true });
    expect(resolvePool(undefined, [oddDefault, prod])).toEqual({ kind: "disabled", name: "odd" });
  });
});
