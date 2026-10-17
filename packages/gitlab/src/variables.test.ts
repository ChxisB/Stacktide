import { describe, expect, test } from "bun:test";
import { canMask } from "./index";

describe("canMask", () => {
  test("length: 8 characters or more", () => {
    expect(canMask("a".repeat(7))).toBe(false);
    expect(canMask("a".repeat(8))).toBe(true);
    expect(canMask("")).toBe(false);
    expect(canMask("a".repeat(7), { raw: false })).toBe(false);
    expect(canMask("a".repeat(8), { raw: false })).toBe(true);
  });

  test("a single line without spaces, whatever the expansion", () => {
    for (const raw of [true, false]) {
      for (const v of [
        "abcd efgh",
        "abcd\tefgh",
        "abcdefgh\n",
        "abcd\nefgh",
        " abcdefgh",
        "abcd\u00a0efgh",
      ]) {
        expect(canMask(v, { raw })).toBe(false);
      }
    }
  });

  test("raw (the default) allows any non-space character", () => {
    expect(canMask("p$ss%w0rd^&*()[]{}!")).toBe(true);
    expect(canMask("p$ss%w0rd^&*()", { raw: true })).toBe(true);
  });

  test("expanded variables allow letters, digits and _ : @ - + . ~ = / only", () => {
    expect(canMask("aZ09_:@-+.~=/", { raw: false })).toBe(true);
    for (const bad of [
      "abcd$efgh",
      "abcd%efgh",
      "abcd!efgh",
      "abcd#efgh",
      "abcd,efgh",
      "abcd\\efgh",
      "abcdéfgh",
    ]) {
      expect(canMask(bad, { raw: false })).toBe(false);
    }
  });
});
