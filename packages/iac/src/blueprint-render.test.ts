import { describe, expect, test } from "bun:test";
import { posix } from "node:path";
import { BLUEPRINT_SIZES, type Blueprint, BlueprintSchema, stackNameOf } from "@orch/core";
import { listModules, readModule } from "./blueprint-modules";
import {
  BLUEPRINT_MODULES,
  BLUEPRINT_TERRAFORM_VERSION,
  hclString,
  moduleDigest,
  type RenderedFile,
  renderBlueprint,
} from "./blueprint-render";
import { CASES, input, othersOf, siblings } from "./fixtures/blueprint-cases";
import { type RepoSource, scanStacks } from "./scan";
import { parseManifest } from "./stack";

const FORGES = ["gitlab", "github"] as const;
const ROOT = "infra";

const render = (which: string, forge: "gitlab" | "github" = "gitlab", root = ROOT) => {
  const r = renderBlueprint(input(which), forge, root, othersOf(which));
  if (!r.ok) throw new Error(`${which}: ${r.errors.join("; ")}`);
  return r;
};
const fileOf = (files: RenderedFile[], path: string) => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`no ${path} in ${files.map((x) => x.path).join(", ")}`);
  return f.content;
};
const source = (files: RenderedFile[]): RepoSource => ({
  async *files() {
    for (const f of files) yield f.path;
  },
  read: async (path) => fileOf(files, path),
});
/** The value of `key = value` in a block, as written (terraform fmt pads the `=`). */
const attr = (tf: string, key: string) => new RegExp(`^\\s+${key}\\s+= (.*)$`, "m").exec(tf)?.[1];
const kindOf = (which: string) => which.split(" ")[0] as string;
const cloudOf = (which: string) => which.split(" ")[1] as string;

describe("renderBlueprint", () => {
  for (const which of Object.keys(CASES)) {
    for (const forge of FORGES) {
      test(`${which} on ${forge}: the stack's own files`, () => {
        const { files, dir } = render(which, forge);
        const own = files.filter((f) => f.path.startsWith(`${dir}/`));
        expect(own.map((f) => f.path)).toEqual([
          `${dir}/README.md`,
          `${dir}/main.tf`,
          `${dir}/stack.yml`,
        ]);
        expect(own.map((f) => `# ${f.path}\n${f.content}`).join("\n")).toMatchSnapshot();
      });
    }
  }

  test("the files are the stack's three and the vendored module, nothing else", () => {
    for (const which of Object.keys(CASES)) {
      const { files, dir, moduleDir } = render(which);
      const kind = kindOf(which);
      const cloud = cloudOf(which);
      expect(dir).toBe(`${ROOT}/staging/main-${kind}`);
      expect(moduleDir).toBe(
        `${ROOT}/_blueprints/${cloud}/${kind}-${BLUEPRINT_MODULES[`${cloud}/${kind}`]?.version}`,
      );
      const vendored = files.filter((f) => f.path.startsWith(`${moduleDir}/`));
      expect(files).toHaveLength(3 + vendored.length);
      // the module is copied byte for byte: what was reviewed is what is proposed
      expect(vendored.map((f) => [f.path.slice(moduleDir.length + 1), f.content])).toEqual(
        readModule(cloud, kind).map((m) => [m.name, m.content]),
      );
    }
  });

  test("main.tf forwards the module's console_url, and a service's url, as the stack's outputs and nothing else", () => {
    for (const which of Object.keys(CASES)) {
      const { files, dir } = render(which);
      const tf = fileOf(files, `${dir}/main.tf`);
      const forwarded = [...tf.matchAll(/^output "([^"]+)" \{\n {2}value = (.*)\n\}$/gm)].map(
        (m) => [m[1], m[2]],
      );
      const want = [["console_url", "module.this.console_url"]];
      if (kindOf(which) === "service") want.push(["url", "module.this.url"]);
      expect(forwarded.sort()).toEqual(want.sort());
      // no other output, and none of them sensitive: what leaves a stack is what a reader may see
      expect(tf.match(/^output /gm)).toHaveLength(want.length);
      expect(tf).not.toContain("sensitive");
    }
  });

  test("stack.yml parses with the stack schema, and scan finds the stack with the platform's backend", async () => {
    for (const which of Object.keys(CASES)) {
      for (const forge of FORGES) {
        const { files, dir } = render(which, forge);
        const parsed = parseManifest(fileOf(files, `${dir}/stack.yml`));
        if (!parsed.ok) throw new Error(`${which}: ${parsed.errors.join("; ")}`);
        expect(parsed.manifest).toMatchObject({
          name: `staging-main-${kindOf(which)}`,
          tool: "terraform",
          version: BLUEPRINT_TERRAFORM_VERSION,
          state: forge === "github" ? "orch" : "gitlab",
          apply_on: "command",
        });
        // a blueprint reads no platform variables, and GitHub refuses the key
        expect(parsed.manifest.environment).toBeUndefined();

        const scan = await scanStacks(source(files));
        expect(scan.problems).toEqual([]);
        expect(scan.stacks).toHaveLength(1);
        expect(scan.stacks[0]).toMatchObject({ path: dir, backend: "http", tool: "terraform" });
      }
    }
  });

  test("the stack name is the stack key and the name the schema derives", () => {
    const { stack, files, dir } = render("postgres aws");
    expect(stack).toBe(stackNameOf({ environment: "staging", name: "main", kind: "postgres" }));
    expect(fileOf(files, `${dir}/stack.yml`)).toContain(`name: ${stack}\n`);
  });

  test("uses becomes depends_on and the names the module takes, in a fixed order", () => {
    const { files, dir } = render("service gcp");
    const m = parseManifest(fileOf(files, `${dir}/stack.yml`));
    if (!m.ok) throw new Error(m.errors.join("; "));
    expect(m.manifest.depends_on).toEqual([
      "staging-files-bucket",
      "staging-main-network",
      "staging-main-postgres",
    ]);
    const tf = fileOf(files, `${dir}/main.tf`);
    expect(attr(tf, "network")).toBe('"main"');
    expect(attr(tf, "databases")).toBe('["main"]');
    expect(attr(tf, "buckets")).toBe('["files"]');

    // the order the author listed them in does not change what is written
    const flipped = renderBlueprint(
      input("service gcp", { uses: ["bucket:files", "network:main", "postgres:main"] }),
      "gitlab",
      ROOT,
      othersOf("service gcp"),
    );
    expect(flipped).toEqual(render("service gcp"));
  });

  test("several databases and buckets are passed sorted, whatever order they were listed in", () => {
    const uses = ["postgres:zeta", "bucket:y", "network:main", "postgres:alpha", "bucket:x"];
    const many = [
      ...siblings("gcp"),
      ...["zeta", "alpha"].map((name) => ({ ...siblings("gcp")[1], name }) as Blueprint),
      ...["x", "y"].map((name) => ({ ...siblings("gcp")[2], name }) as Blueprint),
    ];
    const a = renderBlueprint(input("service gcp", { uses }), "gitlab", ROOT, many);
    const b = renderBlueprint(
      input("service gcp", { uses: [...uses].reverse() }),
      "gitlab",
      ROOT,
      many,
    );
    if (!a.ok) throw new Error(a.errors.join("; "));
    expect(b).toEqual(a);
    const tf = fileOf(a.files, `${a.dir}/main.tf`);
    expect(attr(tf, "databases")).toBe('["alpha", "zeta"]');
    expect(attr(tf, "buckets")).toBe('["x", "y"]');
  });

  test("a stack that uses nothing has no depends_on and passes no wiring", () => {
    const { files, dir } = render("service gcp bare");
    expect(fileOf(files, `${dir}/stack.yml`)).not.toContain("depends_on");
    const tf = fileOf(files, `${dir}/main.tf`);
    for (const word of ["network", "databases", "buckets"]) {
      expect(tf.split("\n").filter((l) => l.trim().startsWith(word))).toEqual([]);
    }
  });

  test("the module call uses a relative path and is the only way the module is reached", () => {
    for (const which of Object.keys(CASES)) {
      const { files, dir } = render(which);
      const tf = fileOf(files, `${dir}/main.tf`);
      const v = BLUEPRINT_MODULES[`${cloudOf(which)}/${kindOf(which)}`]?.version;
      expect(tf).toContain('backend "http" {}');
      expect(attr(tf, "source")).toBe(
        `"../../_blueprints/${cloudOf(which)}/${kindOf(which)}-${v}"`,
      );
      expect(tf.match(/^module "/gm)).toHaveLength(1);
      // nothing but the module call, the backend, the provider and the outputs it passes on
      expect([...tf.matchAll(/^(\w+) /gm)].map((m) => m[1])).toEqual([
        "terraform",
        "provider",
        "module",
        ...(kindOf(which) === "service" ? ["output", "output"] : ["output"]),
      ]);
    }
  });

  test("the module path in main.tf lands on the vendored copy, whatever the root", () => {
    for (const root of [".", "infra", "deploy/infra", "a/b/c"]) {
      for (const which of Object.keys(CASES)) {
        const r = render(which, "gitlab", root);
        const source = JSON.parse(attr(fileOf(r.files, `${r.dir}/main.tf`), "source") ?? "null");
        expect([root, which, posix.join(r.dir, source)]).toEqual([root, which, r.moduleDir]);
      }
    }
  });

  test("the provider is set in the stack: a project and region on GCP, a region on AWS", () => {
    const gcp = render("bucket gcp");
    expect(fileOf(gcp.files, `${gcp.dir}/main.tf`)).toContain(
      'provider "google" {\n  project = "my-proj-123"\n  region  = "us-central1"\n}',
    );
    const aws = render("bucket aws");
    const tf = fileOf(aws.files, `${aws.dir}/main.tf`);
    expect(tf).toContain('provider "aws" {\n  region = "eu-west-2"\n}');
    expect(tf).not.toContain("project");
  });

  test("a profile means the numbers in the reviewed table, in both clouds", () => {
    const gs = BLUEPRINT_SIZES.gcp.service.medium;
    const g = render("service gcp");
    const gtf = fileOf(g.files, `${g.dir}/main.tf`);
    expect(attr(gtf, "cpu")).toBe(`"${gs.cpu}"`);
    expect(attr(gtf, "memory")).toBe(`"${gs.memory}"`);
    expect(attr(gtf, "min_instances")).toBe(String(gs.minInstances));
    expect(attr(gtf, "max_instances")).toBe(String(gs.maxInstances));

    const as = BLUEPRINT_SIZES.aws.service.large;
    const a = render("service aws");
    const atf = fileOf(a.files, `${a.dir}/main.tf`);
    expect(attr(atf, "cpu")).toBe(String(as.cpu));
    expect(attr(atf, "memory")).toBe(String(as.memory));
    expect(attr(atf, "desired_count")).toBe(String(as.desiredCount));

    const ap = BLUEPRINT_SIZES.aws.postgres.medium;
    const p = render("postgres aws");
    const ptf = fileOf(p.files, `${p.dir}/main.tf`);
    expect(attr(ptf, "instance_class")).toBe(`"${ap.instanceClass}"`);
    expect(attr(ptf, "storage_gb")).toBe(String(ap.storageGb));
    expect(attr(ptf, "postgres_version")).toBe('"16"');
  });

  test("the safe defaults are written down, not left to the module", () => {
    const bare = render("service gcp bare");
    expect(attr(fileOf(bare.files, `${bare.dir}/main.tf`), "public")).toBe("false");
    const bucket = render("bucket aws");
    expect(attr(fileOf(bucket.files, `${bucket.dir}/main.tf`), "versioning")).toBe("false");
  });

  test("the stack watches its vendored module, so a hand edit of it is planned", () => {
    const { files, dir, moduleDir } = render("network gcp");
    const m = parseManifest(fileOf(files, `${dir}/stack.yml`));
    if (!m.ok) throw new Error(m.errors.join("; "));
    expect(m.manifest.watch).toEqual([`${moduleDir}/**`]);
  });

  test("at the repository root the paths have no leading ./", async () => {
    const r = render("bucket aws", "github", ".");
    expect(r.dir).toBe("staging/main-bucket");
    expect(r.moduleDir).toBe(`_blueprints/aws/bucket-${BLUEPRINT_MODULES["aws/bucket"]?.version}`);
    for (const f of r.files) expect(f.path.startsWith("./")).toBe(false);
    const scan = await scanStacks(source(r.files));
    expect(scan.problems).toEqual([]);
    expect(scan.stacks[0]?.path).toBe("staging/main-bucket");
  });

  test("the same input renders the same files", () => {
    for (const which of Object.keys(CASES)) {
      for (const forge of FORGES) {
        expect(render(which, forge)).toEqual(render(which, forge));
      }
    }
  });

  test("a root that is not a safe repository path is refused, and nothing is rendered", () => {
    for (const bad of [
      "",
      "/abs",
      "../x",
      "a/../b",
      "a/./b",
      "./a",
      "a/",
      "a b",
      "a\\b",
      "a;b",
      "-rf",
      "a\nb",
      "$(id)",
    ]) {
      const r = renderBlueprint(input("bucket aws"), "gitlab", bad, []);
      expect([bad, r.ok]).toEqual([bad, false]);
      if (!r.ok) expect(r.errors[0]).toContain("root");
    }
    for (const ok of [".", "infra", "deploy/infra", "a.b/c_d"]) {
      expect([ok, renderBlueprint(input("bucket aws"), "gitlab", ok, []).ok]).toEqual([ok, true]);
    }
  });

  test("input the schema refuses is an error list, not an exception", () => {
    for (const bad of [null, undefined, "bucket", 7, [], {}, { kind: "cache" }]) {
      const r = renderBlueprint(bad, "gitlab", ROOT, []);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
    }
    const r = renderBlueprint(input("bucket aws", { password: "x" }), "gitlab", ROOT, []);
    expect(r.ok).toBe(false);
  });

  // The schema is the only way a value reaches HCL (ADR-0024). The same strings that blueprints.test.ts
  // throws at the schema are thrown here at the whole renderer, and none may produce a file.
  const HOSTILE = [
    'a"b',
    "a\nb",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the point is a HCL interpolation, not a JS template
    "a${b}",
    "a%{b}",
    "a\\b",
    "a'b",
    "a`b",
    "a#b",
    "a b",
    "/*",
    "a;b",
    "a\u0000b",
    "\u202e",
    'x\n  provider "aws" {}',
  ];
  for (const which of Object.keys(CASES)) {
    test(`no hostile string passes through the renderer: ${which}`, () => {
      const base = input(which);
      const strings = Object.entries(base)
        .filter(([, v]) => typeof v === "string")
        .map(([k]) => k);
      for (const field of new Set([...strings, "image", "cidr", "version", "certificateArn"])) {
        for (const h of HOSTILE) {
          for (const forge of FORGES) {
            const r = renderBlueprint({ ...base, [field]: h }, forge, ROOT, othersOf(which));
            expect([which, field, h, r.ok]).toEqual([which, field, h, false]);
            expect("files" in r).toBe(false);
          }
        }
      }
      for (const h of HOSTILE) {
        expect(
          renderBlueprint({ ...base, uses: [`postgres:${h}`] }, "gitlab", ROOT, othersOf(which)).ok,
        ).toBe(false);
      }
    });
  }
});

describe("wiring to the project's other resources", () => {
  const refused = (which: string, others: Blueprint[], over: Record<string, unknown> = {}) => {
    const r = renderBlueprint(input(which, over), "gitlab", ROOT, others);
    if (r.ok) throw new Error(`${which} was rendered`);
    expect("files" in r).toBe(false);
    return r.errors;
  };
  const make = (which: string, over: Record<string, unknown> = {}) =>
    BlueprintSchema.parse(input(which, over));

  test("a resource that is not there is refused by name, and nothing is rendered", () => {
    const [network, postgres] = siblings("gcp");
    expect(refused("service gcp", [network, postgres] as Blueprint[])).toEqual([
      "uses: bucket:files is not a resource of staging",
    ]);
    expect(refused("service gcp", [])).toHaveLength(3);
    expect(refused("postgres gcp", [])).toEqual([
      "uses: network:main is not a resource of staging",
    ]);
  });

  test("a resource on another cloud is refused by name", () => {
    expect(refused("service gcp", siblings("aws"))).toEqual([
      "uses: network:main is on aws, not gcp",
      "uses: postgres:main is on aws, not gcp",
      "uses: bucket:files is on aws, not gcp",
    ]);
  });

  test("a service and a database on different networks are refused by name", () => {
    const [network, , bucket] = siblings("gcp") as [Blueprint, Blueprint, Blueprint];
    const apart = [
      network,
      bucket,
      make("network gcp", { name: "other" }),
      make("postgres gcp", { uses: ["network:other"] }),
    ];
    expect(refused("service gcp", apart)).toEqual([
      "uses: postgres:main is on network:other, but this service uses network:main",
    ]);
  });

  test("what the schema refuses is reported by the schema, without a word about the others", () => {
    expect(refused("service gcp", [], { uses: ["postgres:main"] })).toEqual([
      "uses: a service that uses a postgres needs a network: add network:<name> to uses",
    ]);
  });

  test("a service is wired to exactly the resources it uses, and the others' values go nowhere", () => {
    // a spare database and bucket sit in the project beside the ones the service uses
    const spare = [
      make("postgres gcp", { name: "spare", version: "15", uses: ["network:main"] }),
      make("bucket gcp", { name: "extra" }),
      make("network gcp", { name: "wide", cidr: "10.77.0.0/16" }),
    ];
    const r = renderBlueprint(input("service gcp"), "gitlab", ROOT, [...siblings("gcp"), ...spare]);
    if (!r.ok) throw new Error(r.errors.join("; "));
    const own = r.files
      .filter((f) => f.path.startsWith(`${r.dir}/`))
      .map((f) => f.content)
      .join("\n");
    const tf = fileOf(r.files, `${r.dir}/main.tf`);
    expect(attr(tf, "databases")).toBe('["main"]');
    expect(attr(tf, "buckets")).toBe('["files"]');
    for (const leaked of ["spare", "extra", "wide", "10.77.0.0", '"15"']) {
      expect([leaked, own.includes(leaked)]).toEqual([leaked, false]);
    }
    // the same input renders the same files, whatever else is in the project
    expect(r).toEqual(render("service gcp"));
  });

  // The platform holds no secret and generates none: the password is made by the database module while it
  // is applied, and the connection string goes to the cloud's secret store from there.
  const SECRETISH =
    /password|passwd|token|private[_ ]key|api[_ ]key|credential|secret_data|secret_string|random_/i;
  for (const which of Object.keys(CASES)) {
    test(`no secret value, generated password or credential in the files of ${which}`, () => {
      const { files, dir } = render(which);
      for (const f of files.filter((x) => x.path.startsWith(`${dir}/`))) {
        expect([f.path, SECRETISH.exec(f.content)?.[0]]).toEqual([f.path, undefined]);
      }
    });
  }
});

describe("hclString", () => {
  // one quoted literal: no raw quote, backslash or newline inside, and `${` / `%{` only as their escapes
  const LITERAL =
    /^"(?:[^"\\\n$%]|\\["\\nrt]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}|\$\$\{|%%\{|\$(?!\{)|%(?!\{))*"$/;
  const printable = (out: string) => [...out].every((c) => c >= " " && c <= "~");
  test("whatever it is given comes out as one literal", () => {
    for (const s of [
      "plain",
      "",
      'q"uote',
      "back\\slash",
      "new\nline",
      "tab\t",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the point is a HCL interpolation, not a JS template
      "${var.x}",
      "%{if true}x%{endif}",
      "$${already}",
      "%%{already}",
      "$",
      "%",
      "a$",
      "\u0000\u001f\u007f",
      "\u202e",
      "\u{1f600}",
    ]) {
      const out = hclString(s);
      expect([s, LITERAL.test(out), printable(out)]).toEqual([s, true, true]);
    }
  });
  test("a plain string is just quoted", () => {
    expect(hclString("my-proj-123")).toBe('"my-proj-123"');
  });
});

describe("the shipped modules", () => {
  test("every module on disk has a pinned version and digest, and every pin has a module", () => {
    const onDisk = listModules()
      .map((m) => `${m.cloud}/${m.kind}`)
      .sort();
    expect(Object.keys(BLUEPRINT_MODULES).sort()).toEqual(onDisk);
    expect(onDisk).toHaveLength(10);
  });

  // A vendored copy is never rewritten (ADR-0024). Change a module's files and this fails: put the new
  // digest in BLUEPRINT_MODULES and raise its version in the same change, so a repository that has the
  // old copy gets a new directory and a new proposal, not a silent edit.
  for (const [key, pin] of Object.entries(BLUEPRINT_MODULES)) {
    test(`${key} is ${pin.version} at the pinned digest`, () => {
      const [cloud, kind] = key.split("/") as [string, string];
      expect(pin.version).toMatch(/^v[1-9]\d*$/);
      expect(moduleDigest(readModule(cloud, kind))).toBe(pin.sha256);
    });
  }

  test("the digest depends on every file's name and content", () => {
    const a = [{ name: "a.tf", content: "x" }];
    expect(moduleDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(moduleDigest(a)).not.toBe(moduleDigest([{ name: "b.tf", content: "x" }]));
    expect(moduleDigest(a)).not.toBe(moduleDigest([{ name: "a.tf", content: "y" }]));
    expect(moduleDigest([{ name: "a.tf", content: "xb.tf" }])).not.toBe(
      moduleDigest([
        { name: "a.tf", content: "x" },
        { name: "b.tf", content: "" },
      ]),
    );
  });
});
