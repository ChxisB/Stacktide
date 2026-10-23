import type { Gitlab, ListProjectsOptions, ProjectRef } from "@orch/gitlab";
import { z } from "zod";
import type { GithubClient } from "./client";
import { decode } from "./decode";
import { fullName, repositoryId } from "./paths";

const repository = z
  .object({
    id: z.number(),
    name: z.string(),
    full_name: z.string(),
    // An empty repository still names its default branch on GitHub.
    default_branch: z.string().nullish(),
    html_url: z.string(),
    archived: z.boolean().optional(),
    visibility: z.string().optional(),
    private: z.boolean().optional(),
  })
  .transform((r) => ({
    id: r.id,
    name: r.name,
    path: r.full_name,
    defaultBranch: r.default_branch ?? null,
    webUrl: r.html_url,
    archived: r.archived ?? false,
    // what it does not say is taken as private
    visibility: r.visibility ?? (r.private === false ? "public" : "private"),
  }));

export type RepositoryView = z.output<typeof repository>;

export function projectsApi(client: GithubClient): Pick<Gitlab, "projects"> {
  return {
    projects: {
      /**
       * Id order, as the import needs it. `membership: false` (every visible project) has no GitHub counterpart:
       * these are always the repositories the token reaches.
       * shortcut: GitHub cannot sort or search that list, so all of it is read and sorted here; upgrade if a token
       * reaches thousands of repositories.
       */
      async *list(o: ListProjectsOptions = {}) {
        const all: z.output<typeof repository>[] = [];
        for await (const raw of client.paginate("/user/repos", { per_page: 100 })) {
          all.push(decode(repository, raw, "repository"));
        }
        all.sort((a, b) => a.id - b.id);
        const needle = o.search?.toLowerCase();
        for (const p of all) {
          if (o.idAfter !== undefined && p.id <= o.idAfter) continue;
          if (o.archived !== undefined && p.archived !== o.archived) continue;
          if (needle && !p.path.toLowerCase().includes(needle)) continue;
          yield p;
        }
      },
      async get(ref) {
        const path = typeof ref === "number" ? repositoryId(ref) : `/repos/${fullName(ref)}`;
        return decode(repository, await client.request("GET", path), "repository");
      },
    },
  };
}

/**
 * Where a repository's routes are: `/repos/owner/name`. A number is asked for its name first (one more request),
 * because only the name form is known to serve every route.
 */
export function repoBase(client: GithubClient) {
  return async (ref: ProjectRef): Promise<string> => {
    if (typeof ref === "string") return `/repos/${fullName(ref)}`;
    const named = decode(
      z.object({ full_name: z.string() }),
      await client.request("GET", repositoryId(ref)),
      "repository",
    );
    return `/repos/${fullName(named.full_name)}`;
  };
}
