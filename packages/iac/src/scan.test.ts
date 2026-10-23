import { describe, expect, test } from "bun:test";
import { backendOf, type RepoSource, scanStacks } from "./scan";
import { MAX_MANIFEST_BYTES } from "./stack";

const HTTP = 'terraform {\n  backend "http" {}\n}\n';
const manifest = (name: string, extra = "") => `name: ${name}\ntool: tofu\n${extra}`;

/** A repository in memory; a file whose text is an Error cannot be read. */
function repo(
  tree: Record<string, string | Error>,
  order?: string[],
): RepoSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async *files() {
      for (const p of order ?? Object.keys(tree)) yield p;
    },
    async read(path) {
      reads.push(path);
      const v = tree[path];
      if (v === undefined || v instanceof Error) throw v ?? new Error("no such file");
      return v;
    },
  };
}

describe("scanStacks", () => {
  test("a directory with a stack.yml is a stack, and its fields come from the file", async () => {
    const { stacks, problems } = await scanStacks(
      repo({
        "infra/network/stack.yml": manifest(
          "network",
          "version: 1.9.8\ntags: [prod]\ndepends_on: [base]\nwatch: [modules/**]\napply_on: merge\nenvironment: staging\npool: prod-runners\nstate: orch\ndrift_every: 1d\n",
        ),
        "infra/network/main.tf": HTTP,
        "infra/base/stack.yml": manifest("base"),
        "infra/base/main.tf": HTTP,
        "README.md": "not a stack",
      }),
    );
    expect(problems).toEqual([]);
    expect(stacks).toEqual([
      {
        name: "base",
        path: "infra/base",
        tool: "tofu",
        version: null,
        tags: [],
        dependsOn: [],
        watch: [],
        applyOn: "command",
        backend: "http",
      },
      {
        name: "network",
        path: "infra/network",
        tool: "tofu",
        version: "1.9.8",
        tags: ["prod"],
        dependsOn: ["base"],
        watch: ["modules/**"],
        applyOn: "merge",
        environment: "staging",
        pool: "prod-runners",
        state: "orch",
        driftEverySeconds: 86_400,
        backend: "http",
      },
    ]);
  });

  test("a repository with no stacks has none, and says nothing", async () => {
    expect(await scanStacks(repo({ "main.tf": HTTP, "src/a.ts": "" }))).toEqual({
      stacks: [],
      problems: [],
      complete: true,
    });
  });

  test("the root can be a stack", async () => {
    const { stacks, problems } = await scanStacks(
      repo({ "stack.yml": manifest("root"), "main.tf": HTTP }),
    );
    expect(problems).toEqual([]);
    expect(stacks.map((s) => [s.name, s.path, s.backend])).toEqual([["root", ".", "http"]]);
  });

  test("the same repository in any file order gives the same answer", async () => {
    const tree = {
      "b/stack.yml": manifest("b"),
      "b/x.tf": HTTP,
      "a/stack.yml": manifest("a"),
      "a/x.tf": "",
      "c/stack.yml": "name: [broken",
    };
    const keys = Object.keys(tree);
    const forward = await scanStacks(repo(tree, keys));
    expect(await scanStacks(repo(tree, [...keys].reverse()))).toEqual(forward);
    expect(await scanStacks(repo(tree, keys), { concurrency: 1 })).toEqual(forward);
    expect(forward.stacks.map((s) => s.path)).toEqual(["a", "b"]);
  });

  test("stacks may nest: each directory is its own stack", async () => {
    const { stacks, problems } = await scanStacks(
      repo({
        "env/stack.yml": manifest("outer"),
        "env/main.tf": HTTP,
        "env/inner/stack.yml": manifest("inner"),
        "env/inner/main.tf": HTTP,
      }),
    );
    expect(problems).toEqual([]);
    expect(stacks.map((s) => s.name)).toEqual(["outer", "inner"]);
  });

  describe("bad markers leave only themselves out", () => {
    test("an invalid manifest is an error naming the file and the key", async () => {
      const { stacks, problems } = await scanStacks(
        repo({
          "good/stack.yml": manifest("good"),
          "good/m.tf": HTTP,
          "bad/stack.yml": "name: Bad\ntool: tofu\n",
        }),
      );
      expect(stacks.map((s) => s.name)).toEqual(["good"]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({
        kind: "invalid-manifest",
        severity: "error",
        path: "bad/stack.yml",
      });
      expect(problems[0]?.message).toContain("name");
    });

    test("a manifest that is not YAML", async () => {
      const { stacks, problems } = await scanStacks(repo({ "a/stack.yml": "name: [oops" }));
      expect(stacks).toEqual([]);
      expect(problems[0]).toMatchObject({ kind: "invalid-manifest", path: "a/stack.yml" });
    });

    test("a manifest that cannot be read", async () => {
      const { stacks, problems } = await scanStacks(
        repo({ "a/stack.yml": new Error("boom: glpat-SECRET-0123") }),
      );
      expect(stacks).toEqual([]);
      expect(problems).toEqual([
        {
          kind: "unreadable",
          severity: "error",
          path: "a/stack.yml",
          message: "stack.yml could not be read",
        },
      ]);
      // what the source said about why is not repeated
      expect(JSON.stringify(problems)).not.toContain("glpat");
    });

    test("a manifest bigger than the limit is not parsed", async () => {
      const big = `${manifest("big")}# ${"x".repeat(MAX_MANIFEST_BYTES)}\n`;
      const { stacks, problems } = await scanStacks(repo({ "big/stack.yml": big }));
      expect(stacks).toEqual([]);
      expect(problems[0]).toMatchObject({
        kind: "too-large",
        severity: "error",
        path: "big/stack.yml",
      });
      // the limit is in bytes, not characters
      const wide = `${manifest("wide")}# ${"€".repeat(MAX_MANIFEST_BYTES / 3)}\n`;
      expect(wide.length).toBeLessThan(MAX_MANIFEST_BYTES);
      const r = await scanStacks(repo({ "wide/stack.yml": wide }));
      expect(r.problems[0]?.kind).toBe("too-large");
    });

    test("a manifest exactly at the limit is read", async () => {
      const head = manifest("edge");
      const text = `${head}#${"x".repeat(MAX_MANIFEST_BYTES - head.length - 1)}`;
      expect(Buffer.byteLength(text)).toBe(MAX_MANIFEST_BYTES);
      const { stacks } = await scanStacks(repo({ "edge/stack.yml": text, "edge/a.tf": HTTP }));
      expect(stacks.map((s) => s.name)).toEqual(["edge"]);
    });
  });

  describe("a stack's directory ends up in shell commands and job names", () => {
    const dirs = [
      "my stack",
      "a;rm -rf",
      "$(id)",
      "a`b`",
      "a'b",
      'a"b',
      "a&b",
      "a|b",
      "a>b",
      "a<b",
      "a*b",
      "a?b",
      "a\\b",
      "a\nb",
      "-rf",
      "-",
      "ünï",
      "a b/c",
      "ok/-opt",
    ];
    for (const dir of dirs) {
      test(`refuses ${JSON.stringify(dir)}`, async () => {
        const { stacks, problems } = await scanStacks(
          repo({ [`${dir}/stack.yml`]: manifest("x"), [`${dir}/m.tf`]: HTTP }),
        );
        expect(stacks).toEqual([]);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({ kind: "unsafe-path", severity: "error" });
        // the message is fixed text: it does not carry the repository's own characters back out
        expect(problems[0]?.message).toBe("the directory has characters a stack path may not have");
      });
    }

    test("and does not read what it refuses", async () => {
      const source = repo({ "a b/stack.yml": manifest("x") });
      await scanStacks(source);
      expect(source.reads).toEqual([]);
    });

    test("accepts the usual: dots, @, +, =, digits, inside a segment", async () => {
      const ok = ["infra/eu-west-1", "v1.2/app_1", "a@b/c+d=e", ".github/stacks", "x/.hidden"];
      for (const dir of ok) {
        const { stacks } = await scanStacks(
          repo({ [`${dir}/stack.yml`]: manifest("x"), [`${dir}/m.tf`]: HTTP }),
        );
        expect(stacks.map((s) => s.path)).toEqual([dir]);
      }
    });

    test("refuses a segment that climbs", async () => {
      for (const dir of ["a/../b", "../a", "a/./b"]) {
        const { stacks, problems } = await scanStacks(
          repo({ [`${dir}/stack.yml`]: manifest("x") }),
        );
        expect(stacks).toEqual([]);
        expect(problems[0]?.kind).toBe("unsafe-path");
      }
    });
  });

  describe("two stacks with one name", () => {
    test("neither is returned, and the error lists both paths", async () => {
      const { stacks, problems } = await scanStacks(
        repo({
          "a/stack.yml": manifest("same"),
          "a/m.tf": HTTP,
          "b/stack.yml": manifest("same"),
          "b/m.tf": HTTP,
          "c/stack.yml": manifest("other"),
          "c/m.tf": HTTP,
        }),
      );
      expect(stacks.map((s) => s.name)).toEqual(["other"]);
      expect(problems).toEqual([
        {
          kind: "duplicate-name",
          severity: "error",
          path: "a",
          message: 'the name "same" is used by a, b',
        },
      ]);
    });

    test("three claimants are one error, and their backend warnings go with them", async () => {
      const { stacks, problems } = await scanStacks(
        repo({
          "a/stack.yml": manifest("same"),
          "b/stack.yml": manifest("same"),
          "c/stack.yml": manifest("same"),
        }),
      );
      expect(stacks).toEqual([]);
      expect(problems.map((p) => p.kind)).toEqual(["duplicate-name"]);
      expect(problems[0]?.message).toBe('the name "same" is used by a, b, c');
    });

    test("an invalid manifest does not claim its name", async () => {
      const { stacks } = await scanStacks(
        repo({
          "a/stack.yml": manifest("same"),
          "a/m.tf": HTTP,
          "b/stack.yml": `${manifest("same")}bogus: 1\n`,
        }),
      );
      expect(stacks.map((s) => s.path)).toEqual(["a"]);
    });
  });

  describe("the state backend", () => {
    const one = async (tree: Record<string, string | Error>, tool = "tofu") => {
      const r = await scanStacks(repo({ "s/stack.yml": `name: s\ntool: ${tool}\n`, ...tree }));
      return { backend: r.stacks[0]?.backend, kinds: r.problems.map((p) => [p.kind, p.severity]) };
    };

    test("backend http is what the platform wires: no problem", async () => {
      expect(await one({ "s/main.tf": HTTP })).toEqual({ backend: "http", kinds: [] });
    });

    test("no backend at all: the stack stays, with a warning that state would be lost", async () => {
      const r = await scanStacks(
        repo({ "s/stack.yml": manifest("s"), "s/main.tf": "resource {}\n" }),
      );
      expect(r.stacks.map((s) => [s.name, s.backend])).toEqual([["s", "none"]]);
      expect(r.problems).toEqual([
        {
          kind: "missing-backend",
          severity: "warning",
          path: "s",
          message: expect.stringContaining("state would be local"),
        },
      ]);
    });

    test("no .tf files at all is the same as no backend", async () => {
      expect(await one({})).toEqual({ backend: "none", kinds: [["missing-backend", "warning"]] });
    });

    test("another backend is told apart from none", async () => {
      const r = await scanStacks(
        repo({ "s/stack.yml": manifest("s"), "s/b.tf": 'terraform {\n  backend "s3" {\n  }\n}\n' }),
      );
      expect(r.stacks[0]?.backend).toBe("other");
      expect(r.problems[0]?.message).toContain("other than");
      expect(r.problems[0]?.message).not.toContain("state would be local");
    });

    test("the backend may be in any .tf file of the directory, and only that directory", async () => {
      expect(await one({ "s/a.tf": "", "s/z.tf": HTTP })).toEqual({ backend: "http", kinds: [] });
      // a backend one level down belongs to that directory
      expect(await one({ "s/sub/main.tf": HTTP })).toEqual({
        backend: "none",
        kinds: [["missing-backend", "warning"]],
      });
    });

    test("a block that is commented out does not count", async () => {
      for (const text of [
        '# backend "http" {}\n',
        '// backend "http" {}\n',
        '/* backend "http" {} */\n',
        'terraform {\n  /*\n  backend "http" {}\n  */\n}\n',
        'x = 1 # backend "http" {}\n',
      ]) {
        expect((await one({ "s/main.tf": text })).backend).toBe("none");
      }
    });

    test("a DNS zone has no Terraform state: it is not judged, its files are not read, and prune is kept", async () => {
      const source = repo({
        "dns/stack.yml": "name: zone\ntool: dnscontrol\nversion: 5.5.0\ndns: { prune: true }\n",
        "dns/dnsconfig.js": "",
        "dns/main.tf": "",
      });
      const r = await scanStacks(source);
      expect(r.problems).toEqual([]);
      expect(r.stacks[0]).toMatchObject({
        tool: "dnscontrol",
        version: "5.5.0",
        backend: "unchecked",
        dnsPrune: true,
      });
      expect(source.reads).toEqual(["dns/stack.yml"]);
    });

    test("Terragrunt generates its backend, so it is not judged and its files are not read", async () => {
      const source = repo({ "s/stack.yml": "name: s\ntool: terragrunt\n", "s/terragrunt.hcl": "" });
      const r = await scanStacks(source);
      expect(r.stacks[0]?.backend).toBe("unchecked");
      expect(r.problems).toEqual([]);
      expect(source.reads).toEqual(["s/stack.yml"]);
    });

    test("a .tf file that cannot be read is a warning, and the rest still decide", async () => {
      const r = await scanStacks(
        repo({
          "s/stack.yml": manifest("s"),
          "s/a.tf": new Error("denied"),
          "s/b.tf": HTTP,
        }),
      );
      expect(r.stacks[0]?.backend).toBe("http");
      expect(r.problems).toEqual([
        {
          kind: "unreadable",
          severity: "warning",
          path: "s/a.tf",
          message: expect.stringContaining("backend may be misjudged"),
        },
      ]);
    });

    test("only the first 50 .tf files are read", async () => {
      const tree: Record<string, string> = { "s/stack.yml": manifest("s") };
      for (let i = 0; i < 60; i++) tree[`s/f${String(i).padStart(2, "0")}.tf`] = "";
      const source = repo(tree);
      await scanStacks(source);
      expect(source.reads.filter((p) => p.endsWith(".tf"))).toHaveLength(50);
    });

    test("any warning of a stack that was left out goes with it, an error stays", async () => {
      const r = await scanStacks(
        repo({
          "a/stack.yml": manifest("same"),
          "a/m.tf": new Error("x"),
          "b/stack.yml": manifest("same"),
          "b/m.tf": new Error("x"),
          "c/stack.yml": "bogus",
          "c/m.tf": new Error("x"),
        }),
      );
      expect(r.problems.map((p) => [p.kind, p.path])).toEqual([
        ["duplicate-name", "a"],
        ["invalid-manifest", "c/stack.yml"],
      ]);
    });

    test("the warning of a stack that was left out is not shown", async () => {
      const r = await scanStacks(
        repo({ "a/stack.yml": manifest("same"), "b/stack.yml": manifest("same") }),
      );
      expect(r.problems.map((p) => p.kind)).toEqual(["duplicate-name"]);
    });
  });

  describe("complete: whether every stack of the repository was read", () => {
    const complete = async (tree: Record<string, string | Error>, options = {}) =>
      (await scanStacks(repo(tree), options)).complete;

    test("a clean scan is complete, and so is one with only warnings", async () => {
      expect(await complete({ "a/stack.yml": manifest("a"), "a/m.tf": HTTP })).toBe(true);
      // a missing backend is a warning: the stack was still read
      expect(await complete({ "a/stack.yml": manifest("a") })).toBe(true);
      expect(await complete({ "a/stack.yml": manifest("a"), "a/m.tf": new Error("x") })).toBe(true);
    });

    test("any error leaves the scan incomplete: the stack may only have failed to read", async () => {
      const ok = { "ok/stack.yml": manifest("ok"), "ok/m.tf": HTTP };
      expect(await complete({ ...ok, "bad/stack.yml": "name: [oops" })).toBe(false);
      expect(await complete({ ...ok, "bad/stack.yml": new Error("x") })).toBe(false);
      expect(await complete({ ...ok, "a b/stack.yml": manifest("x") })).toBe(false);
      expect(await complete({ ...ok, "dup/stack.yml": manifest("ok") })).toBe(false);
      expect(await complete({ ...ok, "x/stack.yml": manifest("x") }, { maxStacks: 1 })).toBe(false);
    });
  });

  describe("limits", () => {
    test("too many markers: the first ones are read, and the error says how many there were", async () => {
      const tree: Record<string, string> = {};
      for (const n of ["a", "b", "c", "d"]) {
        tree[`${n}/stack.yml`] = manifest(n);
        tree[`${n}/m.tf`] = HTTP;
      }
      const { stacks, problems } = await scanStacks(repo(tree), { maxStacks: 3 });
      expect(stacks.map((s) => s.name)).toEqual(["a", "b", "c"]);
      expect(problems).toEqual([
        {
          kind: "too-many",
          severity: "error",
          path: "",
          message: "4 stacks found; only the first 3 are read",
        },
      ]);
    });

    test("exactly the limit is fine", async () => {
      const { problems } = await scanStacks(
        repo({ "a/stack.yml": manifest("a"), "a/m.tf": HTTP }),
        { maxStacks: 1 },
      );
      expect(problems).toEqual([]);
    });

    test("reads are bounded by the concurrency", async () => {
      let live = 0;
      let peak = 0;
      const source: RepoSource = {
        async *files() {
          for (let i = 0; i < 20; i++) yield `s${i}/stack.yml`;
        },
        async read(path) {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 2));
          live--;
          return manifest(path.split("/")[0] ?? "x");
        },
      };
      const { stacks } = await scanStacks(source, { concurrency: 3 });
      expect(stacks).toHaveLength(20);
      expect(peak).toBeLessThanOrEqual(3);
      expect(peak).toBeGreaterThan(1);
    });
  });
});

describe("backendOf", () => {
  test("none, http, other", () => {
    expect(backendOf([])).toBe("none");
    expect(backendOf(["resource {}"])).toBe("none");
    expect(backendOf([HTTP])).toBe("http");
    expect(backendOf(['backend "gcs" {}'])).toBe("other");
  });

  test("http wins when another is also declared (a workspace-specific override is not judged here)", () => {
    expect(backendOf(['backend "s3" {}', HTTP])).toBe("http");
  });

  test("tolerates spacing and a one-line block", () => {
    expect(backendOf(['backend   "http"{}'])).toBe("http");
    expect(backendOf(['backend\n"http"\n{\n}'])).toBe("http");
  });

  test("a comment marker inside a string starts no comment", () => {
    // an ARN glob and a URL are everyday strings in Terraform
    const policy = 'resources = ["arn:aws:s3:::bucket/*"]\nurl = "https://example.com" # note\n';
    expect(backendOf([`${policy}${HTTP}other = "all */ done"\n`])).toBe("http");
    expect(backendOf([`x = "a#b"\n${HTTP}`])).toBe("http");
    expect(backendOf([`x = "//"\n${HTTP}`])).toBe("http");
    expect(backendOf([`x = "say \\"hi\\" /*"\n${HTTP}y = 1 */\n`])).toBe("http");
  });

  test("a backend named inside a string is not a backend", () => {
    expect(backendOf(['description = "backend \\"http\\" {"'])).toBe("none");
    expect(backendOf(['x = "backend"\nlabel "http" {}'])).toBe("none");
  });

  test("a word that merely contains the name is not a backend", () => {
    expect(backendOf(['xbackend "http" {}'])).toBe("none");
    expect(backendOf(['backend_url = "http"'])).toBe("none");
  });
});
