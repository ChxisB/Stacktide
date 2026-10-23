/** What a repository looks like it is. A project can be several of these at once. */
export const PROJECT_TAGS = [
  "bun",
  "node",
  "docker",
  "terraform",
  "terragrunt",
  "dnscontrol",
] as const;
export type ProjectTag = (typeof PROJECT_TAGS)[number];

/** The tags of the projects whose stacks are planned: merge requests (IAC-7) and drift runs (POL-1). A DNS zone is a stack too. */
export const IAC_TAGS: readonly ProjectTag[] = ["terraform", "terragrunt", "dnscontrol"];

export interface DetectedType {
  tag: ProjectTag;
  /** `high`: a marker file at the repository root. `medium`: only nested, or a weaker marker. */
  confidence: "high" | "medium";
  /** Up to three paths that led to the tag, sorted. */
  evidence: string[];
}

const IGNORED = new Set(["node_modules", "vendor", ".terraform", ".git"]);
const NODE_LOCKS = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const BUN_MARKERS = new Set(["bun.lock", "bun.lockb", "bunfig.toml"]);
const COMPOSE = /^(docker-)?compose\.ya?ml$/;
// `Dockerfile.prod` yes, `Dockerfile.md` (a document about one) no.
const DOCKERFILE = /^(Dockerfile(\.(?!(md|txt|rst)$).+)?|.+\.Dockerfile|Containerfile)$/;
const TERRAFORM = /\.tf(\.json)?$|^\.terraform\.lock\.hcl$/;
const TERRAGRUNT = /^terragrunt\.hcl(\.json)?$/;
// the file DNSControl reads, and `orch dns init` writes, for a zone (DNS-12)
const DNSCONFIG = "dnsconfig.js";
const EVIDENCE = 3;

const split = (path: string) => {
  const i = path.lastIndexOf("/");
  return { dir: i < 0 ? "" : path.slice(0, i), file: path.slice(i + 1) };
};

/**
 * Tags for a repository from the paths in its tree (blobs, `a/b/c.ext`, as GitLab lists them).
 * Pure: it names files and never reads them, so a `package.json` is Node unless a Bun marker sits
 * beside it. Matching is exact and case-sensitive, and paths under `node_modules`, `vendor`,
 * `.terraform` and `.git` are ignored. Result order is `PROJECT_TAGS` order.
 */
export function detectProjectTypes(paths: readonly string[]): DetectedType[] {
  const files = [
    ...new Set(
      paths.filter((p) => p !== "" && !p.split("/").some((segment) => IGNORED.has(segment))),
    ),
  ].sort();
  const entries = files.map((path) => ({ path, ...split(path) }));
  const dirsWith = (match: (file: string) => boolean) =>
    new Set(entries.filter((e) => match(e.file)).map((e) => e.dir));
  const bunDirs = dirsWith((f) => BUN_MARKERS.has(f));
  const nodeLockDirs = dirsWith((f) => NODE_LOCKS.has(f));

  const found = new Map<ProjectTag, { root: boolean; evidence: string[] }>();
  const add = (tag: ProjectTag, path: string, strong: boolean) => {
    const entry = found.get(tag) ?? { root: false, evidence: [] };
    entry.root ||= strong;
    entry.evidence.push(path);
    found.set(tag, entry);
  };
  for (const { path, dir, file } of entries) {
    const atRoot = dir === "";
    if (BUN_MARKERS.has(file)) add("bun", path, atRoot);
    // A bare package.json is a weaker sign than one with its lockfile beside it.
    else if (file === "package.json" && !bunDirs.has(dir)) {
      add("node", path, atRoot && nodeLockDirs.has(dir));
    }
    if (DOCKERFILE.test(file) || COMPOSE.test(file)) add("docker", path, atRoot);
    if (TERRAFORM.test(file)) add("terraform", path, atRoot);
    if (TERRAGRUNT.test(file)) add("terragrunt", path, atRoot);
    if (file === DNSCONFIG) add("dnscontrol", path, atRoot);
  }
  return PROJECT_TAGS.flatMap((tag) => {
    const entry = found.get(tag);
    return entry
      ? [
          {
            tag,
            confidence: entry.root ? ("high" as const) : ("medium" as const),
            evidence: entry.evidence.slice(0, EVIDENCE),
          },
        ]
      : [];
  });
}
