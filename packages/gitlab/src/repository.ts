import { z } from "zod";
import type { GitlabClient } from "./client";
import { decode } from "./decode";
import { GitlabError } from "./errors";
import { type Project, type ProjectRef, projectPath } from "./projects";

const entry = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  // `commit` is a submodule.
  type: z.enum(["blob", "tree", "commit"]),
  mode: z.string(),
});
export type TreeEntry = z.output<typeof entry>;

const file = z
  .object({
    file_path: z.string(),
    ref: z.string(),
    blob_id: z.string(),
    last_commit_id: z.string(),
    size: z.number(),
    content: z.string(),
    encoding: z.literal("base64"),
  })
  .transform((f) => ({
    path: f.file_path,
    ref: f.ref,
    blobId: f.blob_id,
    lastCommitId: f.last_commit_id,
    size: f.size,
    /** Decoded as UTF-8 text: meant for config and manifest files, not binaries. */
    content: Buffer.from(f.content, "base64").toString("utf8"),
  }));
export type RepoFile = z.output<typeof file>;

const comparison = z
  .object({
    commits: z.array(z.object({ id: z.string(), title: z.string() })),
    diffs: z.array(
      z.object({
        old_path: z.string(),
        new_path: z.string(),
        new_file: z.boolean(),
        renamed_file: z.boolean(),
        deleted_file: z.boolean(),
      }),
    ),
    compare_timeout: z.boolean().optional(),
    compare_same_ref: z.boolean().optional(),
  })
  .transform((c) => ({
    commits: c.commits,
    // Paths and change kind only: diff text can be large and carry file contents.
    files: c.diffs.map((d) => ({
      oldPath: d.old_path,
      newPath: d.new_path,
      status: d.new_file
        ? ("added" as const)
        : d.deleted_file
          ? ("deleted" as const)
          : d.renamed_file
            ? ("renamed" as const)
            : ("modified" as const),
    })),
    /** GitLab gave up computing the diff: `files` may be incomplete. */
    timedOut: c.compare_timeout ?? false,
    sameRef: c.compare_same_ref ?? false,
  }));
export type Comparison = z.output<typeof comparison>;

const branch = z
  .object({
    name: z.string(),
    commit: z.object({ id: z.string() }),
    protected: z.boolean(),
    default: z.boolean(),
  })
  .transform((b) => ({
    name: b.name,
    commitId: b.commit.id,
    protected: b.protected,
    default: b.default,
  }));
export type Branch = z.output<typeof branch>;

const commit = z
  .object({ id: z.string(), title: z.string(), web_url: z.string().optional() })
  .transform((c) => ({ id: c.id, title: c.title, webUrl: c.web_url ?? null }));
export type Commit = z.output<typeof commit>;

export type CommitAction =
  | { action: "create" | "update"; path: string; content: string }
  | { action: "delete"; path: string };

export interface CommitInput {
  branch: string;
  message: string;
  /** Create `branch` from this one when it does not exist yet. */
  startBranch?: string;
}

export function repositoryApi(
  client: GitlabClient,
  getProject: (p: ProjectRef) => Promise<Project>,
) {
  const repo = (p: ProjectRef) => `${projectPath(p)}/repository`;
  return {
    repository: {
      /** Every entry under `path` (whole tree by default), keyset-paginated. */
      async *tree(
        project: ProjectRef,
        o: { ref?: string; path?: string; recursive?: boolean } = {},
      ) {
        const query = {
          pagination: "keyset",
          ref: o.ref,
          path: o.path,
          recursive: o.recursive ?? true,
        };
        for await (const raw of client.paginate(`${repo(project)}/tree`, query)) {
          yield decode(entry, raw, "tree entry");
        }
      },
      async getFile(project: ProjectRef, path: string, ref: string) {
        const url = `${repo(project)}/files/${encodeURIComponent(path)}`;
        return decode(file, await client.request("GET", url, { query: { ref } }), "file");
      },
      async compare(project: ProjectRef, from: string, to: string) {
        const raw = await client.request("GET", `${repo(project)}/compare`, {
          query: { from, to },
        });
        return decode(comparison, raw, "comparison");
      },
      /** `not_found` means there is no such branch. */
      async getBranch(project: ProjectRef, name: string) {
        const raw = await client.request(
          "GET",
          `${repo(project)}/branches/${encodeURIComponent(name.replace(/^refs\/heads\//, ""))}`,
        );
        return decode(branch, raw, "branch");
      },
      async createBranch(project: ProjectRef, name: string, ref: string) {
        const raw = await client.request("POST", `${repo(project)}/branches`, {
          body: { branch: name, ref },
        });
        return decode(branch, raw, "branch");
      },
      /**
       * Removes a branch (also closes what hangs off it, as GitLab does). Never the default branch.
       * `not_found` means it is already gone.
       */
      async deleteBranch(project: ProjectRef, name: string) {
        const { defaultBranch } = await getProject(project);
        const branchName = name.replace(/^refs\/heads\//, "");
        if (branchName === defaultBranch) {
          throw new GitlabError("invalid", "Refusing to delete the default branch");
        }
        await client.request(
          "DELETE",
          `${repo(project)}/branches/${encodeURIComponent(branchName)}`,
        );
      },
      /**
       * One commit with several file actions. Refuses the project's default branch: changes
       * land through a merge request (ROADMAP invariant 6). This is defence in depth, not the
       * control: the default branch must also be protected in GitLab, since the name is looked up
       * just before the write and could change in between. Costs one extra GET per call.
       */
      async commitFiles(project: ProjectRef, input: CommitInput, actions: CommitAction[]) {
        const { defaultBranch } = await getProject(project);
        if (input.branch.replace(/^refs\/heads\//, "") === defaultBranch) {
          throw new GitlabError(
            "invalid",
            "Refusing to commit to the default branch: use a branch and a merge request",
          );
        }
        const raw = await client.request("POST", `${repo(project)}/commits`, {
          body: {
            branch: input.branch,
            commit_message: input.message,
            start_branch: input.startBranch,
            actions: actions.map((a) => ({
              action: a.action,
              file_path: a.path,
              content: a.action === "delete" ? undefined : a.content,
            })),
          },
        });
        return decode(commit, raw, "commit");
      },
    },
  };
}
