import { z } from "zod";
import type { GitlabClient } from "./client";
import { decode } from "./decode";

/** Numeric id or full path (`group/sub/repo`). */
export type ProjectRef = number | string;

export const projectPath = (p: ProjectRef) => `/projects/${encodeURIComponent(String(p))}`;

const project = z
  .object({
    id: z.number(),
    name: z.string(),
    path_with_namespace: z.string(),
    // Null for an empty repository.
    default_branch: z.string().nullish(),
    web_url: z.string(),
    archived: z.boolean().optional(),
    visibility: z.string().optional(),
  })
  .transform((p) => ({
    id: p.id,
    name: p.name,
    path: p.path_with_namespace,
    defaultBranch: p.default_branch ?? null,
    webUrl: p.web_url,
    archived: p.archived ?? false,
    visibility: p.visibility ?? "private",
  }));
export type Project = z.output<typeof project>;

const group = z
  .object({ id: z.number(), name: z.string(), full_path: z.string(), web_url: z.string() })
  .transform((g) => ({ id: g.id, name: g.name, path: g.full_path, webUrl: g.web_url }));
export type Group = z.output<typeof group>;

export interface ListProjectsOptions {
  search?: string;
  /** Only projects the token is a member of. Default true. */
  membership?: boolean;
  archived?: boolean;
  /** Only projects with a larger id: where to pick up a listing that was cut short. */
  idAfter?: number;
}

export function projectsApi(client: GitlabClient) {
  return {
    projects: {
      /** Stable id order (keyset pagination) so an import can be resumed or repeated. */
      async *list(o: ListProjectsOptions = {}) {
        const query = {
          pagination: "keyset",
          order_by: "id",
          sort: "asc",
          membership: o.membership ?? true,
          search: o.search,
          archived: o.archived,
          id_after: o.idAfter,
        };
        for await (const raw of client.paginate("/projects", query)) {
          yield decode(project, raw, "project");
        }
      },
      async get(ref: ProjectRef) {
        return decode(project, await client.request("GET", projectPath(ref)), "project");
      },
    },
    groups: {
      async *list() {
        for await (const raw of client.paginate("/groups", { order_by: "id", sort: "asc" })) {
          yield decode(group, raw, "group");
        }
      },
      async get(ref: number | string) {
        const path = `/groups/${encodeURIComponent(String(ref))}`;
        return decode(group, await client.request("GET", path), "group");
      },
    },
  };
}
