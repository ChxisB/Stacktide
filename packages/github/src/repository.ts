import { type Gitlab, GitlabError, type ProjectRef } from "@orch/gitlab";
import { z } from "zod";
import type { GithubClient } from "./client";
import { decode } from "./decode";
import { branchName, firstLine, segments } from "./paths";

const MAX_COMPARE_PAGES = 30;
const PER_PAGE = 100;

const treeListing = z.object({
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.enum(["blob", "tree", "commit"]),
      sha: z.string(),
    }),
  ),
  truncated: z.boolean().optional(),
});

const contents = z.object({
  type: z.string(),
  path: z.string(),
  sha: z.string(),
  size: z.number(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});

const commitList = z.array(z.object({ sha: z.string() }));

const comparison = z.object({
  commits: z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string() }) })),
  files: z
    .array(
      z.object({
        filename: z.string(),
        status: z.string(),
        previous_filename: z.string().optional(),
      }),
    )
    .optional(),
});

const branch = z.object({
  name: z.string(),
  commit: z.object({ sha: z.string(), commit: z.object({ tree: z.object({ sha: z.string() }) }) }),
  protected: z.boolean().optional(),
});

const tag = z.object({ name: z.string(), commit: z.object({ sha: z.string() }) });
const sha = z.object({ sha: z.string() });
const madeCommit = z.object({ sha: z.string(), html_url: z.string().optional() });

const invalid = (message: string) => new GitlabError("invalid", message);
const notFound = (message: string) => new GitlabError("not_found", message);

export function repositoryApi(
  client: GithubClient,
  base: (p: ProjectRef) => Promise<string>,
  getProject: Gitlab["projects"]["get"],
): Pick<Gitlab, "repository"> {
  /** The branch's tip commit and tree; null when there is no such branch. */
  async function tip(root: string, name: string) {
    try {
      const b = decode(
        branch,
        await client.request("GET", `${root}/branches/${segments(name)}`),
        "branch",
      );
      return { commit: b.commit.sha, tree: b.commit.commit.tree.sha };
    } catch (e) {
      if (e instanceof GitlabError && e.kind === "not_found") return null;
      throw e;
    }
  }

  /** What is at `path` in a commit: a file, a directory (anything else is `other`), or nothing. */
  async function kindAt(root: string, path: string, commit: string) {
    try {
      const raw = await client.request("GET", `${root}/contents/${segments(path)}`, {
        query: { ref: commit },
      });
      if (Array.isArray(raw)) return "dir";
      return decode(contents, raw, "file").type === "file" ? "file" : "other";
    } catch (e) {
      if (e instanceof GitlabError && e.kind === "not_found") return null;
      throw e;
    }
  }

  const getBranch: Gitlab["repository"]["getBranch"] = async (project, name) => {
    const root = await base(project);
    const raw = await client.request("GET", `${root}/branches/${segments(branchName(name))}`);
    const b = decode(branch, raw, "branch");
    return {
      name: b.name,
      commitId: b.commit.sha,
      protected: b.protected ?? false,
      default: b.name === (await getProject(project)).defaultBranch,
    };
  };

  return {
    repository: {
      async *tree(project, o = {}) {
        const root = await base(project);
        const ref = o.ref ?? (await getProject(project)).defaultBranch;
        if (ref === null) return; // an empty repository has nothing to list
        const listing = decode(
          treeListing,
          await client.request("GET", `${root}/git/trees/${segments(ref)}`, {
            query: { recursive: 1 },
          }),
          "tree",
        );
        // shortcut: GitHub cuts a very large tree short, and the one request cannot continue it; refused, not guessed.
        // Upgrade: walk the tree one directory at a time.
        if (listing.truncated)
          throw new GitlabError("unexpected", "GitHub cut the tree short: too large to list");
        const dir = (o.path ?? "").replace(/^\/+|\/+$/g, "");
        const prefix = dir === "" ? "" : `${dir}/`;
        for (const e of listing.tree) {
          if (!e.path.startsWith(prefix)) continue;
          const within = e.path.slice(prefix.length);
          if (o.recursive === false && within.includes("/")) continue;
          yield {
            id: e.sha,
            name: e.path.split("/").pop() ?? e.path,
            path: e.path,
            type: e.type,
            mode: e.mode,
          };
        }
      },

      async getFile(project, path, ref) {
        const root = await base(project);
        const at = segments(path);
        const raw = await client.request("GET", `${root}/contents/${at}`, { query: { ref } });
        // a directory comes back as a list; a link or a submodule is not a file to read
        if (Array.isArray(raw)) throw notFound(`${path} is a directory`);
        const f = decode(contents, raw, "file");
        if (f.type !== "file") throw notFound(`${path} is not a file`);
        // shortcut: GitHub sends no content for a file over 1 MB; refused. Upgrade: ask for the raw bytes (`download`).
        if (f.encoding !== "base64") throw invalid(`${path} is too large to read`);
        const last = decode(
          commitList,
          await client.request("GET", `${root}/commits`, {
            query: { sha: ref, path, per_page: 1 },
          }),
          "commit list",
        );
        return {
          path: f.path,
          ref,
          blobId: f.sha,
          // shortcut: one more request per file for a value nothing reads yet; upgrade by dropping it from the type.
          lastCommitId: last[0]?.sha ?? "",
          size: f.size,
          content: Buffer.from((f.content ?? "").replace(/\s/g, ""), "base64").toString("utf8"),
        };
      },

      async compare(project, from, to) {
        const root = await base(project);
        // git forbids `..` in a ref name, and `...` is what joins the two in the URL
        if (from.includes("..") || to.includes("..")) throw invalid("Not a ref GitHub can compare");
        const url = `${root}/compare/${segments(from)}...${segments(to)}`;
        const commits: { id: string; title: string }[] = [];
        const files: {
          oldPath: string;
          newPath: string;
          status: "added" | "deleted" | "renamed" | "modified";
        }[] = [];
        let timedOut = false;
        for (let page = 1; ; page++) {
          const c = decode(
            comparison,
            await client.request("GET", url, { query: { per_page: PER_PAGE, page } }),
            "comparison",
          );
          for (const k of c.commits)
            commits.push({ id: k.sha, title: firstLine(k.commit.message) });
          for (const f of c.files ?? []) {
            files.push({
              oldPath: f.previous_filename ?? f.filename,
              newPath: f.filename,
              status:
                f.status === "added"
                  ? "added"
                  : f.status === "removed"
                    ? "deleted"
                    : f.status === "renamed"
                      ? "renamed"
                      : "modified",
            });
          }
          if (c.commits.length < PER_PAGE && (c.files ?? []).length < PER_PAGE) break;
          if (page === MAX_COMPARE_PAGES) {
            timedOut = true; // GitHub lists 3000 files at most: what is here may not be all
            break;
          }
        }
        return { commits, files, timedOut, sameRef: from === to };
      },

      async *tags(project) {
        const root = await base(project);
        for await (const raw of client.paginate(`${root}/tags`, { per_page: PER_PAGE })) {
          const t = decode(tag, raw, "tag");
          yield { name: t.name, commitId: t.commit.sha };
        }
      },

      getBranch,

      async createBranch(project, name, ref) {
        const root = await base(project);
        const wanted = branchName(name);
        // the default branch exists already; asking for it again can only be a mistake
        if (wanted === (await getProject(project)).defaultBranch) {
          throw invalid("Refusing to create the default branch");
        }
        let from: string;
        try {
          from = decode(
            sha,
            await client.request("GET", `${root}/commits/${segments(ref)}`),
            "commit",
          ).sha;
        } catch (e) {
          if (e instanceof GitlabError && (e.kind === "not_found" || e.kind === "invalid")) {
            throw invalid(`No such ref to branch from: ${ref.slice(0, 100)}`);
          }
          throw e;
        }
        segments(wanted);
        await client.request("POST", `${root}/git/refs`, {
          body: { ref: `refs/heads/${wanted}`, sha: from },
        });
        return getBranch(project, wanted);
      },

      async deleteBranch(project, name) {
        const root = await base(project);
        const wanted = branchName(name);
        if (wanted === (await getProject(project)).defaultBranch) {
          throw invalid("Refusing to delete the default branch");
        }
        // a missing branch is not_found here; GitHub itself would say 422 to the delete
        await client.request("GET", `${root}/branches/${segments(wanted)}`);
        await client.request("DELETE", `${root}/git/refs/heads/${segments(wanted)}`);
      },

      async commitFiles(project, input, actions) {
        const root = await base(project);
        const target = branchName(input.branch);
        // invariant 6, before anything is read or sent. Defence in depth: the default branch must also be protected
        // on GitHub, since the name is looked up just before the write.
        if (target === (await getProject(project)).defaultBranch) {
          throw invalid(
            "Refusing to commit to the default branch: use a branch and a pull request",
          );
        }
        if (actions.length === 0) throw invalid("A commit needs at least one file action");
        segments(target);

        const existing = await tip(root, target);
        let from = existing;
        if (existing) {
          if (input.startBranch !== undefined) {
            throw invalid("startBranch only works for a branch that does not exist yet");
          }
        } else {
          if (input.startBranch === undefined)
            throw invalid("The branch does not exist: give a startBranch");
          from = await tip(root, branchName(input.startBranch));
          if (!from) throw invalid("The startBranch does not exist");
        }
        if (!from) throw invalid("The branch does not exist");

        // GitHub would overwrite or ignore what GitLab refuses, so every action is checked against the base first.
        // shortcut: one request per file; upgrade to one read of the tree for commits of dozens of files.
        const seen = new Set<string>();
        for (const a of actions) {
          if (seen.has(a.path)) throw invalid(`${a.path} appears twice in one commit`);
          seen.add(a.path);
          const here = await kindAt(root, a.path, from.commit);
          if (here === "dir" || here === "other") throw invalid(`${a.path} is not a plain file`);
          if (a.action === "create" && here) throw invalid(`${a.path} exists already`);
          if (a.action !== "create" && !here) throw invalid(`${a.path} does not exist`);
        }

        const made = decode(
          sha,
          await client.request("POST", `${root}/git/trees`, {
            body: {
              base_tree: from.tree,
              tree: actions.map((a) =>
                a.action === "delete"
                  ? { path: a.path, mode: "100644", type: "blob", sha: null }
                  : { path: a.path, mode: "100644", type: "blob", content: a.content },
              ),
            },
          }),
          "tree",
        );
        const commit = decode(
          madeCommit,
          await client.request("POST", `${root}/git/commits`, {
            body: { message: input.message, tree: made.sha, parents: [from.commit] },
          }),
          "commit",
        );
        if (existing) {
          await client.request("PATCH", `${root}/git/refs/heads/${segments(target)}`, {
            body: { sha: commit.sha, force: false },
          });
        } else {
          await client.request("POST", `${root}/git/refs`, {
            body: { ref: `refs/heads/${target}`, sha: commit.sha },
          });
        }
        return { id: commit.sha, title: firstLine(input.message), webUrl: commit.html_url ?? null };
      },
    },
  };
}
