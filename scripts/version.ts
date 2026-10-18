import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Semantic versioning from Conventional Commits. Run it from the repository root:
//   bun scripts/version.ts [--apply] [--notes FILE]
// It prints the next version, or nothing when no commit since the last v* tag is releasable. --apply
// writes it into apps/cli/package.json (the version the binary reports), bun.lock and CHANGELOG.md.
// --notes writes the release notes of this version to FILE. It never commits, tags or pushes.

export type Bump = "major" | "minor" | "patch";
export type Change = {
  hash: string;
  type: string;
  scope?: string;
  subject: string;
  breaking: boolean;
};

const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/;
const FOOTER = /^BREAKING[ -]CHANGE: /m;
const SECTIONS = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["revert", "Reverts"],
] as const;
const VERSION = /^\d+\.\d+\.\d+$/;

export function parse(hash: string, message: string): Change | undefined {
  const [subject = "", ...body] = message.trim().split("\n");
  const found = HEADER.exec(subject);
  if (!found) return undefined;
  const [, type = "", scope, bang, text = ""] = found;
  return {
    hash,
    type: type.toLowerCase(),
    ...(scope ? { scope } : {}),
    subject: text,
    breaking: bang === "!" || FOOTER.test(body.join("\n")),
  };
}

export function bumpOf(changes: Change[], version: string): Bump | undefined {
  // shortcut: below 1.0.0 a breaking change is a minor bump; 1.0.0 is a release someone chooses
  if (changes.some((c) => c.breaking)) return version.startsWith("0.") ? "minor" : "major";
  if (changes.some((c) => c.type === "feat")) return "minor";
  if (changes.some((c) => c.type === "fix" || c.type === "perf" || c.type === "revert"))
    return "patch";
  return undefined;
}

export function bump(version: string, by: Bump) {
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a version like 1.2.3`);
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (by === "major") return `${major + 1}.0.0`;
  return by === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export function notes(version: string, date: string, changes: Change[]) {
  const line = (c: Change) =>
    `- ${c.scope ? `**${c.scope}:** ` : ""}${c.subject} (${c.hash.slice(0, 7)})`;
  const section = (title: string, items: Change[]) =>
    items.length ? ["", `### ${title}`, ...items.map(line)] : [];
  return [
    `## v${version} (${date})`,
    ...section(
      "Breaking changes",
      changes.filter((c) => c.breaking),
    ),
    ...SECTIONS.flatMap(([type, title]) =>
      section(
        title,
        changes.filter((c) => c.type === type),
      ),
    ),
    "",
  ].join("\n");
}

/** What the commits since the last release tag make of the next release. */
export async function plan(cwd: string, date: string) {
  const git = async (...args: string[]) =>
    (await Bun.$`git ${args}`.cwd(cwd).quiet().nothrow().text()).trim();
  const last = await git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*.[0-9]*.[0-9]*");
  const from = last ? last.slice(1) : "0.0.0";
  // a tag that is not major.minor.patch (v1.0.0-rc.1) stops here: guessing past it would pick a wrong number
  bump(from, "patch");
  const log = await git("log", last ? `${last}..HEAD` : "HEAD", "--format=%H%x1f%B%x1e");
  const changes = log
    .split("\x1e")
    .map((entry) => entry.trim().split("\x1f"))
    .flatMap(([hash = "", message = ""]) => (hash ? (parse(hash, message) ?? []) : []));
  const by = bumpOf(changes, from);
  if (!by) return undefined;
  const version = bump(from, by);
  return { version, tag: `v${version}`, notes: notes(version, date, changes) };
}

/** Writes `version` where the build reads it, and puts `text` at the top of CHANGELOG.md. */
export async function apply(root: string, version: string, text: string) {
  const edit = async (file: string, pattern: RegExp, what: string) => {
    const path = join(root, file);
    const old = await readFile(path, "utf8");
    if (!pattern.test(old)) throw new Error(`${file} has no ${what} to update`);
    await writeFile(path, old.replace(pattern, `$1${version}`));
  };
  await edit("apps/cli/package.json", /("version":\s*")[^"]+/, "version");
  // bun install --frozen-lockfile fails when the lock's copy of a workspace version is stale
  await edit("bun.lock", /("name": "@orch\/cli",\s*"version": ")[^"]+/, "@orch/cli version");
  const changelog = join(root, "CHANGELOG.md");
  const old = await readFile(changelog, "utf8").catch(() => "# Changelog\n");
  const rest = old.replace(/^# Changelog\n+/, "");
  await writeFile(changelog, `# Changelog\n\n${text}${rest ? `\n${rest}` : ""}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args[args.indexOf("--notes") + 1];
  if (args.includes("--notes") && !file) throw new Error("--notes needs a file");
  const next = await plan(process.cwd(), new Date().toISOString().slice(0, 10));
  if (next) {
    if (file) await writeFile(file, next.notes);
    if (args.includes("--apply")) await apply(process.cwd(), next.version, next.notes);
    console.log(next.version);
  }
}
