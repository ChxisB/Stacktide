import { GitlabError } from "@orch/gitlab";
import type { GithubClient } from "./client";

/**
 * What a fine-grained token can be given, with a read of the repository that only that permission allows. GitHub does
 * not say which a token holds (FRG-3), so each is asked by using it.
 * shortcut: reads only. A token with read but not write passes here, and the first write says no; probing a write means
 * making one. Add a dry-run write per permission only if that proves a real support problem.
 */
export const PERMISSIONS = [
  { id: "contents", label: "Contents", path: "/contents" },
  { id: "pull_requests", label: "Pull requests", path: "/pulls" },
  { id: "actions", label: "Actions", path: "/actions/workflows" },
  { id: "secrets", label: "Secrets", path: "/actions/secrets/public-key" },
  { id: "variables", label: "Variables", path: "/actions/variables" },
  { id: "environments", label: "Environments", path: "/environments" },
  { id: "webhooks", label: "Webhooks", path: "/hooks" },
] as const;
export type PermissionId = (typeof PERMISSIONS)[number]["id"];

export interface PermissionProbe {
  login: string;
  /** The `owner/name` the permissions were tried on; `null` when the token sees no repository. */
  repo: string | null;
  granted: PermissionId[];
  /** GitHub said 403 or 404. */
  refused: PermissionId[];
  /** Not tried, or answered in a way that says nothing about the permission (a server error, an empty repository). */
  unknown: PermissionId[];
}

/**
 * Who the token is and which permissions it holds, on the first repository it can see. A token GitHub rejects is the
 * client's error; a token with no repository answers `unknown` for everything.
 */
export async function probePermissions(client: GithubClient): Promise<PermissionProbe> {
  const me = await client.request<{ login: string }>("GET", "/user");
  const [first] = await client.request<{ full_name: string }[]>("GET", "/user/repos", {
    query: { per_page: 1 },
  });
  const probe: PermissionProbe = {
    login: me.login,
    repo: first?.full_name ?? null,
    granted: [],
    refused: [],
    unknown: [],
  };
  if (!first) {
    probe.unknown = PERMISSIONS.map((p) => p.id);
    return probe;
  }
  for (const p of PERMISSIONS) {
    try {
      await client.request("GET", `/repos/${first.full_name}${p.path}`, { query: { per_page: 1 } });
      probe.granted.push(p.id);
    } catch (e) {
      if (!(e instanceof GitlabError)) throw e;
      (e.kind === "forbidden" || e.kind === "not_found" ? probe.refused : probe.unknown).push(p.id);
    }
  }
  return probe;
}
