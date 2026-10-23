/**
 * The little git the mock GitHub keeps for each repository: blobs, flat trees (path to blob), commits, branches and
 * tags. Hashes are SHA-1 over the content, so an unchanged file keeps its blob id across commits and a comparison can
 * tell a changed file from an untouched one the way GitHub's does. Only what the routes need: no merges, no renames.
 */

export interface GitCommit {
  sha: string;
  parents: string[];
  tree: string;
  message: string;
}

const sha1 = (s: string) => new Bun.CryptoHasher("sha1").update(s).digest("hex");

export class MockGit {
  blobs = new Map<string, string>();
  trees = new Map<string, Record<string, string>>();
  commits = new Map<string, GitCommit>();
  branches = new Map<string, string>();
  tags = new Map<string, string>();
  private made = 0;

  blob(content: string): string {
    const sha = sha1(`blob\0${content}`);
    this.blobs.set(sha, content);
    return sha;
  }

  /** `files` maps a path to a blob id. */
  tree(files: Record<string, string>): string {
    const sha = sha1(`tree\0${JSON.stringify(Object.entries(files).sort())}`);
    this.trees.set(sha, files);
    return sha;
  }

  commit(parents: string[], tree: string, message: string): string {
    const sha = sha1(`commit\0${this.made++}\0${parents.join(",")}\0${tree}\0${message}`);
    this.commits.set(sha, { sha, parents, tree, message });
    return sha;
  }

  /** A first commit holding `texts` (path to content), on `branch`. */
  seed(branch: string, texts: Record<string, string>): string {
    const files: Record<string, string> = {};
    for (const [path, text] of Object.entries(texts)) files[path] = this.blob(text);
    const sha = this.commit([], this.tree(files), "initial commit");
    this.branches.set(branch, sha);
    return sha;
  }

  /** A branch, a tag or a commit id. */
  resolve(ref: string): string | undefined {
    return (
      this.branches.get(ref) ?? this.tags.get(ref) ?? (this.commits.has(ref) ? ref : undefined)
    );
  }

  filesAt(commit: string): Record<string, string> {
    const c = this.commits.get(commit);
    return (c && this.trees.get(c.tree)) ?? {};
  }

  /** The commits from `sha` back along first parents, newest first. */
  chain(sha: string): GitCommit[] {
    const out: GitCommit[] = [];
    for (let c = this.commits.get(sha); c; c = this.commits.get(c.parents[0] ?? "")) out.push(c);
    return out;
  }

  isAncestor(maybe: string, of: string): boolean {
    return this.chain(of).some((c) => c.sha === maybe);
  }

  /** What `to` has that `from` does not: its commits (oldest first) and the files that differ. */
  compare(from: string, to: string) {
    const had = new Set(this.chain(from).map((c) => c.sha));
    const commits = this.chain(to)
      .filter((c) => !had.has(c.sha))
      .reverse();
    const a = this.filesAt(from);
    const b = this.filesAt(to);
    const files: { filename: string; status: "added" | "removed" | "modified" }[] = [];
    for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (a[path] === b[path]) continue;
      files.push({
        filename: path,
        status: a[path] === undefined ? "added" : b[path] === undefined ? "removed" : "modified",
      });
    }
    return { commits, files };
  }
}

/** The entries of a tree listing: every file, plus a `tree` entry for each directory above one (all of it, or one level). */
export function treeEntries(
  git: MockGit,
  files: Record<string, string>,
  recursive: boolean,
): { path: string; mode: string; type: "blob" | "tree"; sha: string; size?: number }[] {
  const out = new Map<
    string,
    { path: string; mode: string; type: "blob" | "tree"; sha: string; size?: number }
  >();
  for (const [path, blob] of Object.entries(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (!recursive && i > 1) break;
      const dir = parts.slice(0, i).join("/");
      out.set(dir, { path: dir, mode: "040000", type: "tree", sha: sha1(`dir\0${dir}`) });
    }
    if (recursive || parts.length === 1) {
      out.set(path, {
        path,
        mode: "100644",
        type: "blob",
        sha: blob,
        size: Buffer.byteLength(git.blobs.get(blob) ?? ""),
      });
    }
  }
  return [...out.values()].sort((x, y) => (x.path < y.path ? -1 : 1));
}
