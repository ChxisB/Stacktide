import { describe, expect, test } from "bun:test";
import { MAX_TAG, MAX_TAGS, normalizeTags, parseTags, TAG_PATTERN } from "./tags";

describe("tags", () => {
  test("a tag is lower-case letters, digits and hyphens, 1 to 24 characters", () => {
    for (const ok of ["a", "backend", "v2", "a-b-c", "0", "x".repeat(MAX_TAG)]) {
      expect([ok, TAG_PATTERN.test(ok)]).toEqual([ok, true]);
    }
    for (const bad of ["", "A", "a b", "a_b", "é", "a,b", "a\n", "x".repeat(MAX_TAG + 1)]) {
      expect([bad, TAG_PATTERN.test(bad)]).toEqual([bad, false]);
    }
    expect(MAX_TAGS).toBe(8);
  });

  test("parseTags reads commas and spaces, lowers the case, drops repeats and sorts", () => {
    expect(parseTags("Backend, api  billing,API\n eu")).toEqual([
      "api",
      "backend",
      "billing",
      "eu",
    ]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags(" , ,, ")).toEqual([]);
  });

  test("parseTags keeps what is not a tag, so the form can say so", () => {
    expect(parseTags("ok not_ok")).toEqual(["not_ok", "ok"]);
  });

  test("normalizeTags drops repeats and sorts, and changes nothing else", () => {
    expect(normalizeTags(["b", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizeTags([])).toEqual([]);
  });
});
