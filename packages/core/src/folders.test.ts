import { describe, expect, test } from "bun:test";
import { address, FOLDER_PATTERN, isFolderPath, MAX_DEPTH, ROOT, splitAddress } from "./folders";

describe("folders", () => {
  test("a folder name is lower-case letters, digits, hyphens and underscores, 1 to 32 characters", () => {
    for (const ok of ["a", "db", "v2", "a-b_c", "0", "x".repeat(32)]) {
      expect([ok, FOLDER_PATTERN.test(ok)]).toEqual([ok, true]);
    }
    for (const bad of ["", "A", "a b", "a/b", ".", "..", "é", "a\n", "x".repeat(33)]) {
      expect([bad, FOLDER_PATTERN.test(bad)]).toEqual([bad, false]);
    }
    expect([ROOT, MAX_DEPTH]).toEqual(["/", 5]);
  });

  test("a folder path is the root, or names from the root down, at most five deep", () => {
    for (const ok of ["/", "/a", "/db", "/a/b", "/a/b/c/d/e"]) {
      expect([ok, isFolderPath(ok)]).toEqual([ok, true]);
    }
    for (const bad of [
      "",
      "a",
      "a/b",
      "//",
      "/a/",
      "/a//b",
      "/A",
      "/a b",
      "/a/../b",
      "/./a",
      "/a/b/c/d/e/f",
      `/${"x".repeat(33)}`,
      "/a\n",
    ]) {
      expect([bad, isFolderPath(bad)]).toEqual([bad, false]);
    }
  });

  test("an address is /KEY at the root and /folder/KEY in a folder", () => {
    expect(address(undefined, "URL")).toBe("/URL");
    expect(address("/", "URL")).toBe("/URL");
    expect(address("/db", "URL")).toBe("/db/URL");
    expect(address("/a/b", "URL")).toBe("/a/b/URL");
  });

  test("an address in a folder that cannot exist is refused, not guessed at", () => {
    for (const bad of ["", "db", "/DB", "/a/", "/a/b/c/d/e/f"]) {
      expect(() => address(bad, "URL")).toThrow();
    }
  });

  test("splitting an address undoes it", () => {
    expect(splitAddress("/URL")).toEqual({ folder: "/", key: "URL" });
    expect(splitAddress("/db/URL")).toEqual({ folder: "/db", key: "URL" });
    expect(splitAddress("/a/b/URL")).toEqual({ folder: "/a/b", key: "URL" });
    for (const [folder, key] of [
      ["/", "K"],
      ["/x", "K_2"],
      ["/x/y/z", "k"],
    ] as const) {
      expect(splitAddress(address(folder, key))).toEqual({ folder, key });
    }
  });
});
