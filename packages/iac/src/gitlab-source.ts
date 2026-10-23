import type { Gitlab, ProjectRef } from "@orch/gitlab";
import { changedStacks, type Watching } from "./changes";
import type { RepoSource } from "./scan";

/** A repository on GitLab (or GitHub: only `repository` is read) at one ref, read through the platform's own client. */
export function gitlabSource(
  gitlab: Pick<Gitlab, "repository">,
  project: ProjectRef,
  ref: string,
): RepoSource {
  return {
    async *files() {
      for await (const entry of gitlab.repository.tree(project, { ref, recursive: true })) {
        if (entry.type === "blob") yield entry.path;
      }
    },
    read: async (path) => (await gitlab.repository.getFile(project, path, ref)).content,
  };
}

// shortcut: when GitLab says it gave up computing the diff, or the list is as long as a diff
// listing is commonly cut (1000 files; a guess, GitLab's own limit was not checked), every stack
// counts as changed. A plan only reads, so too many is safe and too few is not; upgrade by paging
// the compare once GitLab's real limit is known.
const MAX_COMPARE_FILES = 1000;

/**
 * The stacks changed between two refs (`from` the target branch or its commit, `to` the merge
 * request's head: GitLab diffs from their common ancestor, so only what the merge request adds
 * counts). `stacks` is the scan of `to`. `incomplete` says the comparison could not be trusted to be whole, and every stack is
 * returned as changed. The caller adds dependents with `graph.affected`.
 */
export async function detectChanges(
  gitlab: Pick<Gitlab, "repository">,
  project: ProjectRef,
  from: string,
  to: string,
  stacks: readonly Watching[],
) {
  const comparison = await gitlab.repository.compare(project, from, to);
  if (comparison.timedOut || comparison.files.length >= MAX_COMPARE_FILES) {
    return { changed: stacks.map((s) => s.name).sort(), incomplete: true };
  }
  return { changed: changedStacks(stacks, comparison.files), incomplete: false };
}
