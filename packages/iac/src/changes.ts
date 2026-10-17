import type { Stack } from "./scan";

/**
 * A file a comparison says changed, as GitLab names it: a repository-relative path with no leading
 * `./` or `/`. A deleted or added file has the same path twice.
 */
export interface ChangedFile {
  oldPath: string;
  newPath: string;
}

/** What change detection needs of a stack. */
export type Watching = Pick<Stack, "name" | "path" | "watch">;

const dirsOf = (path: string) => {
  // the directories a file is in, innermost first, ending with the root
  const out: string[] = [];
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    out.push(path.slice(0, i));
  }
  out.push(".");
  return out;
};

/**
 * The stacks a set of changed files touches directly (the caller adds the stacks that depend on
 * them with `graph.affected`). `stacks` is the scan of the head the files lead to, so a stack the
 * change adds is there and one it removes is not (a removed stack is not planned: nothing says
 * what its removal should do to its infrastructure). A stack is touched when a changed file is in its directory and no
 * stack nested inside that directory is closer to it, or when a changed file matches one of its
 * `watch` patterns (repository-relative globs; a pattern that names a directory counts for every
 * file under it). A renamed file counts at both its old and its new path, so moving a file from
 * one stack to another touches both. Sorted by name.
 */
export function changedStacks(
  stacks: readonly Watching[],
  files: readonly ChangedFile[],
): string[] {
  const paths = [...new Set(files.flatMap((f) => [f.oldPath, f.newPath]))];
  if (paths.length === 0) return [];
  const byDir = new Map<string, string[]>();
  for (const s of stacks) byDir.set(s.path, [...(byDir.get(s.path) ?? []), s.name]);

  const touched = new Set<string>();
  for (const path of paths) {
    const owner = dirsOf(path).find((d) => byDir.has(d));
    for (const name of byDir.get(owner ?? "") ?? []) touched.add(name);
  }

  // each distinct pattern is tried once, however many stacks share it
  const hit = new Map<string, boolean>();
  const hits = (pattern: string) => {
    let known = hit.get(pattern);
    if (known === undefined) {
      const exact = new Bun.Glob(pattern);
      const below = new Bun.Glob(`${pattern}/**`);
      known = paths.some((p) => exact.match(p) || below.match(p));
      hit.set(pattern, known);
    }
    return known;
  };
  for (const s of stacks) {
    if (!touched.has(s.name) && s.watch.some(hits)) touched.add(s.name);
  }
  return [...touched].sort();
}
