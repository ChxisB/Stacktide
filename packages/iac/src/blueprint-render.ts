import { createHash } from "node:crypto";
import {
  BLUEPRINT_SIZES,
  type Blueprint,
  BlueprintSchema,
  checkBlueprintWiring,
  stackNameOf,
} from "@orch/core";
import { stringify } from "yaml";
import { readModule } from "./blueprint-modules";
import { safeDir } from "./scan";
import { MARKER } from "./stack";

/** Where the forge keeps the stack's state (ADR-0017): GitLab's managed state, or the platform's for GitHub. */
export type BlueprintForge = "gitlab" | "github";

/** The version in the stack manifest: the last release the modules were validated with (the spike). */
export const BLUEPRINT_TERRAFORM_VERSION = "1.5.7";

export interface RenderedFile {
  /** Relative to the repository root, with `/` separators. */
  path: string;
  content: string;
}

export type Rendered =
  | {
      ok: true;
      /** The stack's name, which is also its state key. */
      stack: string;
      /** The stack's directory. */
      dir: string;
      /** Where the module is vendored; every file under it is the shipped module, byte for byte. */
      moduleDir: string;
      files: RenderedFile[];
    }
  | { ok: false; errors: string[] };

/**
 * The shipped modules and the version a repository gets them under (`_blueprints/<cloud>/<kind>-<version>`).
 * A vendored copy is never rewritten (ADR-0024), so a change to a module's files raises its version and
 * its digest together; the test fails on a digest that no longer matches.
 */
export const BLUEPRINT_MODULES: Record<string, { version: string; sha256: string }> = {
  "aws/bucket": {
    version: "v1",
    sha256: "380e33a0698d8e24a6ff4f9f129b30f60b8aac5ef2d15fa802bd173a5b3dee75",
  },
  "aws/deploy-identity": {
    version: "v1",
    sha256: "368bbdaca1dde173fca261278b45c7c9b6546c38acc28fac37a0e77b7a6693b6",
  },
  "aws/network": {
    version: "v1",
    sha256: "1238a2a27e53d9fdf03e4563a9eec8b49e1ff3dd87f2d53a18dfb56777715995",
  },
  "aws/postgres": {
    version: "v1",
    sha256: "e7eb82c68e0944d9f14dad20347ac4dd49224b788c8d435369c0010eff868df7",
  },
  "aws/service": {
    version: "v2",
    sha256: "74fbab6498f5adee94acdac54b35d14497f72d622ba0537d8f73a2ff8a3fb3b4",
  },
  "gcp/bucket": {
    version: "v1",
    sha256: "e72e413a08b432788f47492a725b8226e1ccefcfd1f448b4c849c9ecfe01c3b2",
  },
  "gcp/deploy-identity": {
    version: "v1",
    sha256: "194999944ee450e8644a0ada5b4c73b6c5074cde089688928f68b2136147f037",
  },
  "gcp/network": {
    version: "v1",
    sha256: "5c9d1865e9ee6789b38dee39305ab22cd92344854eb09c859bc8d24f6b74fc3c",
  },
  "gcp/postgres": {
    version: "v1",
    sha256: "f7e45c8f06ae168b6aa170c0aebda281602c04f15939e26eac01de83d20ee9c7",
  },
  "gcp/service": {
    version: "v1",
    sha256: "90bb5dd5cbb1c5afaf8ac077af4312b7ca286ef17ed8a336f69aa40f821df33f",
  },
};

/** A digest of a module's file names and bytes; the lengths keep one file's end from passing for another's start. */
export const moduleDigest = (files: { name: string; content: string }[]) => {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    h.update(`${f.name}\0${Buffer.byteLength(f.content)}\0`);
    h.update(f.content);
  }
  return h.digest("hex");
};

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");

/**
 * A string as an HCL literal. The schema already allows no character that could end a literal or open an
 * interpolation; this is the second lock: only printable ASCII is written as it is, `${` and `%{` are
 * doubled, and the rest is escaped.
 */
export const hclString = (s: string) => {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp > 0x7e) out += cp > 0xffff ? `\\U${hex(cp, 8)}` : `\\u${hex(cp, 4)}`;
    else out += ch;
  }
  return `"${out.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{")}"`;
};

type Arg = string | number | boolean | readonly string[];

const lit = (v: Arg): string =>
  typeof v === "string"
    ? hclString(v)
    : typeof v === "object"
      ? `[${v.map(hclString).join(", ")}]`
      : String(v);

/** A block of single-line attributes, with the `=` aligned the way `terraform fmt` writes it. */
const block = (head: string, attrs: [string, Arg][]) => {
  const width = Math.max(...attrs.map(([k]) => k.length));
  const lines = attrs.map(([k, v]) => `  ${k.padEnd(width)} = ${lit(v)}`);
  return [`${head} {`, ...lines, "}"].join("\n");
};

/** A root output that passes the module's output of the same name on. */
const forward = (name: string) => `output "${name}" {\n  value = module.this.${name}\n}`;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The names a resource uses of one kind, sorted so the order they were listed in changes nothing. */
const usedOf = (b: Blueprint, kind: string) =>
  b.uses.flatMap((u) => (u.startsWith(`${kind}:`) ? [u.slice(kind.length + 1)] : [])).sort(cmp);

/** The inputs of the module, in the order its variables are read. The schema has checked every one. */
function argsOf(b: Blueprint): [string, Arg][] {
  const [network = ""] = usedOf(b, "network");
  const databases = usedOf(b, "postgres");
  const buckets = usedOf(b, "bucket");
  const head: [string, Arg][] = [
    ["environment", b.environment],
    ["name", b.name],
  ];
  // the schema requires a project on GCP, so the fallback is not reachable
  if (b.cloud === "gcp") head.push(["project", b.project ?? ""]);
  head.push(["region", b.region]);

  switch (b.kind) {
    case "network":
      return [...head, ["cidr", b.cidr]];
    case "bucket":
      return [...head, ["versioning", b.versioning]];
    case "postgres": {
      const wire: [string, Arg][] = [
        ["network", network],
        ["postgres_version", b.version],
      ];
      if (b.cloud === "gcp") {
        const s = BLUEPRINT_SIZES.gcp.postgres[b.profile];
        return [...head, ...wire, ["tier", s.tier], ["storage_gb", s.storageGb]];
      }
      const s = BLUEPRINT_SIZES.aws.postgres[b.profile];
      return [...head, ...wire, ["instance_class", s.instanceClass], ["storage_gb", s.storageGb]];
    }
    case "deploy-identity": {
      const [service = ""] = usedOf(b, "service");
      return [
        ...head,
        ["service", service],
        ["forge", b.forge],
        ["repository", b.repository],
        ["repository_id", b.repositoryId],
        ["owner_id", b.ownerId],
        ...(b.branch === undefined ? [] : ([["branch", b.branch]] as [string, Arg][])),
        ...(b.forge === "github"
          ? ([["immutable_subject", b.immutableSubject]] as [string, Arg][])
          : []),
        ...(b.cloud === "aws"
          ? ([["existing_oidc_provider", b.existingOidcProvider]] as [string, Arg][])
          : []),
      ];
    }
    case "service": {
      const image: [string, Arg][] = b.image === undefined ? [] : [["image", b.image]];
      const traffic: [string, Arg][] = [
        ["port", b.port],
        ["public", b.public],
      ];
      const uses: [string, Arg][] = [];
      if (databases.length > 0) uses.push(["databases", databases]);
      if (buckets.length > 0) uses.push(["buckets", buckets]);
      if (b.cloud === "gcp") {
        const s = BLUEPRINT_SIZES.gcp.service[b.profile];
        return [
          ...head,
          ...image,
          ...traffic,
          ["cpu", s.cpu],
          ["memory", s.memory],
          ["min_instances", s.minInstances],
          ["max_instances", s.maxInstances],
          ...(network === "" ? [] : ([["network", network]] as [string, Arg][])),
          ...uses,
        ];
      }
      const s = BLUEPRINT_SIZES.aws.service[b.profile];
      return [
        ...head,
        ["network", network],
        ["certificate_arn", b.certificateArn ?? ""],
        ...image,
        ...traffic,
        ["cpu", s.cpu],
        ["memory", s.memory],
        ["desired_count", s.desiredCount],
        ...uses,
      ];
    }
  }
}

const readme = (b: Blueprint, stack: string, source: string) =>
  [
    `# ${stack}`,
    "",
    `Written by the platform from a blueprint: a \`${b.kind}\` on \`${b.cloud}\`, profile \`${b.profile}\`.`,
    "",
    "- `stack.yml` marks this directory as a stack: its name, the Terraform version and where the state lives.",
    "- `main.tf` sets the provider, calls the module with the values the blueprint allows and passes on the module's public outputs (its console link, and a service's address). It holds no secret.",
    `- The module is a copy at \`${source}\`, shared by every \`${b.kind}\` on \`${b.cloud}\` in this repository. It is never edited in place: a newer version is a new directory and a new proposal.`,
    "",
    b.uses.length > 0
      ? `Uses: ${[...b.uses]
          .sort(cmp)
          .map((u) => `\`${u}\``)
          .join(", ")}.`
      : "Uses nothing.",
    "",
    "Change this resource by proposing a change through the platform. A hand edit of these files is overwritten by the next one.",
    "",
  ].join("\n");

/**
 * Writes a blueprint as the files of one stack and the module it calls (ADR-0024). Pure: the input goes
 * through `BlueprintSchema`, which is the only way a value reaches the HCL, and nothing is read but the
 * shipped module. `root` is the directory of the repository the resources live in (`.` for its root).
 * `others` are the project's other resources, already parsed: what the resource uses must be among them
 * (an empty list for a resource that uses nothing). The module files are always returned; a repository
 * that already holds that version is not written twice.
 */
export function renderBlueprint(
  input: unknown,
  forge: BlueprintForge,
  root: string,
  others: readonly Blueprint[],
): Rendered {
  if (!safeDir(root)) {
    return {
      ok: false,
      errors: [
        "root: must be a path inside the repository, like infra (letters, digits, . _ @ + = -)",
      ],
    };
  }
  const parsed = BlueprintSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) =>
        i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
      ),
    };
  }
  const b = parsed.data;
  const wiring = checkBlueprintWiring(b, others);
  if (wiring.length > 0) return { ok: false, errors: wiring };

  const pin = BLUEPRINT_MODULES[`${b.cloud}/${b.kind}`];
  if (!pin) throw new Error(`no module is pinned for ${b.cloud}/${b.kind}`);
  const stack = stackNameOf(b);
  const at = (...p: string[]) => (root === "." ? p : [root, ...p]).join("/");
  const dir = at(b.environment, `${b.name}-${b.kind}`);
  const moduleName = `${b.kind}-${pin.version}`;
  const moduleDir = at("_blueprints", b.cloud, moduleName);
  // the stack is two directories below the root, and so is nothing it calls
  const source = `../../_blueprints/${b.cloud}/${moduleName}`;

  const manifest = {
    name: stack,
    tool: "terraform",
    version: BLUEPRINT_TERRAFORM_VERSION,
    state: forge === "github" ? "orch" : "gitlab",
    ...(b.uses.length > 0
      ? {
          depends_on: b.uses
            .map((u) => {
              const [kind = "", name = ""] = u.split(":");
              return stackNameOf({
                environment: b.environment,
                name,
                kind: kind as Blueprint["kind"],
              });
            })
            .sort(cmp),
        }
      : {}),
    // a hand edit of the vendored copy is a change to this stack
    watch: [`${moduleDir}/**`],
  };

  const provider =
    b.cloud === "gcp"
      ? block('provider "google"', [
          ["project", b.project ?? ""],
          ["region", b.region],
        ])
      : block('provider "aws"', [["region", b.region]]);
  const mainTf = [
    'terraform {\n  backend "http" {}\n}',
    provider,
    block('module "this"', [["source", source], ...argsOf(b)]),
    // what a reader may see of the resource leaves the stack as an output (BLP-17); the summary job carries these two names only
    ...(b.kind === "service" ? [forward("url")] : []),
    forward("console_url"),
  ].join("\n\n");

  return {
    ok: true,
    stack,
    dir,
    moduleDir,
    files: [
      { path: `${dir}/README.md`, content: readme(b, stack, source) },
      { path: `${dir}/main.tf`, content: `${mainTf}\n` },
      {
        path: `${dir}/${MARKER}`,
        content: `# Written by the platform from a blueprint (${b.kind} on ${b.cloud}); see README.md.\n${stringify(manifest)}`,
      },
      ...readModule(b.cloud, b.kind).map((f) => ({
        path: `${moduleDir}/${f.name}`,
        content: f.content,
      })),
    ],
  };
}
