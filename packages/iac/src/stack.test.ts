import { describe, expect, test } from "bun:test";
import { MAX_MANIFEST_BYTES, parseManifest } from "./stack";

const ok = (text: string) => {
  const r = parseManifest(text);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.manifest;
};
const bad = (text: string) => {
  const r = parseManifest(text);
  if (r.ok) throw new Error("expected a refusal");
  return r.errors;
};

describe("stack.yml", () => {
  test("a name and a tool are enough, and nothing is applied unless asked", () => {
    expect(ok("name: network\ntool: tofu\n")).toEqual({
      name: "network",
      tool: "tofu",
      tags: [],
      depends_on: [],
      watch: [],
      apply_on: "command",
    });
  });

  test("every key is read", () => {
    expect(
      ok(
        [
          "name: app-1",
          "tool: terragrunt",
          "version: 1.9.8",
          "tags: [prod, eu-west.1]",
          "depends_on: [network, db]",
          "watch: [../modules/**, shared/*.tf]".replace("../", "mods/"),
          "apply_on: merge",
        ].join("\n"),
      ),
    ).toEqual({
      name: "app-1",
      tool: "terragrunt",
      version: "1.9.8",
      tags: ["prod", "eu-west.1"],
      depends_on: ["network", "db"],
      watch: ["mods/modules/**", "shared/*.tf"],
      apply_on: "merge",
    });
    expect(ok("name: a\ntool: terraform\nversion: 1.10.0-rc1\n").version).toBe("1.10.0-rc1");
  });

  test("a misspelt key is an error, not a stack that quietly has no dependencies", () => {
    expect(bad("name: a\ntool: tofu\ndepend_on: [b]\n")[0]).toContain("depend_on");
    expect(bad("name: a\ntool: tofu\nApply_on: merge\n")[0]).toContain("Apply_on");
  });

  test("a name is lowercase letters, digits and inner hyphens, up to 63", () => {
    for (const n of [
      "Network",
      "a b",
      "-a",
      "a-",
      "a_b",
      "",
      "a/b",
      "a.b",
      "x".repeat(64),
      "näme",
    ]) {
      expect(bad(`name: ${JSON.stringify(n)}\ntool: tofu\n`)[0]).toContain("name");
    }
    for (const n of ["a", "a1", "a-b", "0", "x".repeat(63)]) {
      expect(ok(`name: ${JSON.stringify(n)}\ntool: tofu\n`).name).toBe(n);
    }
    // a name in depends_on follows the same rule
    expect(bad("name: a\ntool: tofu\ndepends_on: [B]\n")[0]).toContain("depends_on");
  });

  test("the tool is one of three, and required", () => {
    expect(bad("name: a\ntool: pulumi\n")[0]).toContain("tool");
    expect(bad("name: a\n")[0]).toContain("tool");
    expect(bad("tool: tofu\n")[0]).toContain("name");
  });

  test("a version is a plain release number: no v, no range, no spaces", () => {
    for (const v of ["v1.9.8", "~> 1.9", "1.9", "1.9.8 ", "1.9.8; rm", "latest", ">=1.0.0"]) {
      expect(bad(`name: a\ntool: tofu\nversion: ${JSON.stringify(v)}\n`)[0]).toContain("version");
    }
    // a number is not text: the file must quote what it means as a version
    expect(bad("name: a\ntool: tofu\nversion: 1.9\n")[0]).toContain("version");
  });

  test("tags are small and plain", () => {
    expect(bad("name: a\ntool: tofu\ntags: [Prod]\n")[0]).toContain("tags.0");
    expect(bad("name: a\ntool: tofu\ntags: ['a b']\n")[0]).toContain("tags.0");
    expect(bad(`name: a\ntool: tofu\ntags: [${Array(21).fill("t").join(",")}]\n`)[0]).toContain(
      "tags",
    );
  });

  test("a watch path stays inside the repository", () => {
    for (const w of ["/etc", "../x", "a/../b", "a\\b", "", "a\u0000b", "x".repeat(201)]) {
      expect(bad(`name: a\ntool: tofu\nwatch: [${JSON.stringify(w)}]\n`)[0]).toContain("watch.0");
    }
    // `..` is a segment; a name that merely contains dots is fine
    expect(ok("name: a\ntool: tofu\nwatch: ['a..b/**', '.hidden/x', '**/*.tf']\n").watch).toEqual([
      "a..b/**",
      ".hidden/x",
      "**/*.tf",
    ]);
  });

  test("apply_on is merge or command", () => {
    expect(bad("name: a\ntool: tofu\napply_on: always\n")[0]).toContain("apply_on");
  });

  test("an empty file, a list or a scalar is not a manifest", () => {
    for (const t of ["", "\n", "# nothing\n", "- a\n- b\n", "just text\n", "42\n", "null\n"]) {
      expect(bad(t)).toEqual(["must be a mapping of keys to values"]);
    }
  });

  test("YAML that does not parse says so, and an alias is refused", () => {
    expect(bad("name: [unclosed\n")[0]).toMatch(/^not valid YAML: /);
    expect(bad("name: a\nname: b\ntool: tofu\n")[0]).toMatch(/^not valid YAML: /);
    // an alias would let a small file stand for a large one
    expect(bad("x: &a [1, 2]\nname: a\ntool: tofu\ny: *a\n")[0]).toMatch(/^not valid YAML: /);
  });

  test("what a refusal says names the key, never the value", () => {
    const secret = "glpat-SECRET-0123456789";
    const errors = bad(`name: a\ntool: tofu\ntoken: ${secret}\nversion: ${secret}\n`);
    expect(errors.join(" ")).toContain("token");
    expect(errors.join(" ")).not.toContain(secret);
  });

  test("the size limit is a few KiB beyond a real file", () => {
    expect(MAX_MANIFEST_BYTES).toBe(65536);
  });
});
