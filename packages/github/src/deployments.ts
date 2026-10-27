import type { Deployment, DeploymentStatus, GitlabEnvironment, ProjectRef } from "@orch/gitlab";
import { z } from "zod";
import type { GithubClient } from "./client";
import { decode } from "./decode";
import { whole } from "./paths";

const STATUSES = new Map<string, DeploymentStatus>([
  ["queued", "created"],
  ["pending", "created"],
  ["in_progress", "running"],
  ["success", "success"],
  // GitHub marks an earlier success `inactive` when a later one replaces it: it did succeed
  ["inactive", "success"],
  ["failure", "failed"],
  ["error", "failed"],
]);
/** The states a deployment is finished in; `inactive` is one, but not the moment it finished. */
const FINISHED = new Set(["success", "inactive", "failure", "error"]);

/** One status from GitHub's state. A deployment nothing has reported on is `created`; a word GitHub adds later is `unknown`. */
export const deploymentStatusOf = (state: string | undefined): DeploymentStatus =>
  state === undefined ? "created" : (STATUSES.get(state) ?? "unknown");

// Only these are decoded. GitHub also sends the creator, the payload and the description: the platform keeps none of them.
const deployment = z.object({
  id: z.number(),
  sha: z.string(),
  ref: z.string(),
  environment: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
const status = z.object({
  state: z.string(),
  log_url: z.string().nullish(),
  created_at: z.string(),
});

const web = (url: string | null | undefined) =>
  /^https?:\/\//.test(url ?? "") ? (url ?? null) : null;

const environment = z.object({ id: z.number(), name: z.string() });

/**
 * GitHub's deployments as the platform's (CLD-10, ADR-0025), and its environments. A deployment is a request to
 * deploy and its state is the newest of its statuses, so reading one is two requests. The id is GitHub's, kept where
 * GitLab's goes (`deployments.gitlab_deployment_id`, as `projects.gitlab_project_id` keeps a repository id).
 * - `iid`: GitHub has none, so the id.
 * - `jobId` and `pipelineId`: not told, so null; `pipelineUrl` is the status's `log_url` when it is a web address.
 * - `finishedAt`: when the status that finished it was posted, never when a later one replaced it.
 * shortcut: `list` reads only the `environment` option, newest first as GitHub sends them, and asks for each
 * deployment's statuses one at a time; a refresh reads at most 100, so that is at most 200 requests. Batch with
 * GraphQL if a refresh is ever slow.
 */
export function deploymentsApi(client: GithubClient, base: (p: ProjectRef) => Promise<string>) {
  async function read(at: string, raw: unknown): Promise<Deployment> {
    const d = decode(deployment, raw, "deployment");
    const statuses = decode(
      z.array(status),
      await client.request("GET", `${at}/${d.id}/statuses`, { query: { per_page: 100 } }),
      "deployment statuses",
    );
    // newest first
    const latest = statuses[0];
    const finished =
      latest && FINISHED.has(latest.state)
        ? (statuses.find((s) => FINISHED.has(s.state) && s.state !== "inactive") ?? latest)
        : undefined;
    return {
      id: d.id,
      iid: d.id,
      ref: d.ref,
      sha: d.sha,
      status: deploymentStatusOf(latest?.state),
      environment: d.environment,
      jobId: null,
      pipelineId: null,
      pipelineUrl: web((finished ?? latest)?.log_url),
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      finishedAt: finished?.created_at ?? null,
    };
  }

  return {
    deployments: {
      async *list(project: ProjectRef, o: { environment?: string } = {}) {
        const at = `${await base(project)}/deployments`;
        for await (const raw of client.paginate(at, { environment: o.environment })) {
          yield await read(at, raw);
        }
      },
      async get(project: ProjectRef, id: number) {
        const at = `${await base(project)}/deployments`;
        return read(at, await client.request("GET", `${at}/${whole(id)}`));
      },
    },
    environments: {
      async *list(project: ProjectRef): AsyncGenerator<GitlabEnvironment, void, undefined> {
        for await (const raw of client.paginate(
          `${await base(project)}/environments`,
          {},
          "environments",
        )) {
          const e = decode(environment, raw, "environment");
          // GitHub has no stopped state to read here; its name is its slug
          yield { id: e.id, name: e.name, slug: e.name, state: "available" };
        }
      },
    },
  };
}
