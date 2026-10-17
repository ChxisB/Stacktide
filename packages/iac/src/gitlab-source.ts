import type { Gitlab, ProjectRef } from "@orch/gitlab";
import type { RepoSource } from "./scan";

/** A repository on GitLab at one ref, read through the platform's own GitLab client. */
export function gitlabSource(gitlab: Gitlab, project: ProjectRef, ref: string): RepoSource {
  return {
    async *files() {
      for await (const entry of gitlab.repository.tree(project, { ref, recursive: true })) {
        if (entry.type === "blob") yield entry.path;
      }
    },
    read: async (path) => (await gitlab.repository.getFile(project, path, ref)).content,
  };
}
