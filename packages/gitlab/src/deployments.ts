import { z } from "zod";
import type { GitlabClient } from "./client";
import { decode } from "./decode";
import { type ProjectRef, projectPath } from "./projects";

const KNOWN = [
  "created",
  "running",
  "success",
  "failed",
  "canceled",
  "skipped",
  "blocked",
] as const;
export type DeploymentStatus = (typeof KNOWN)[number] | "unknown";

/** A status GitLab adds later reads as `unknown` instead of failing the whole response. */
const status = z.union([z.enum(KNOWN), z.string().transform(() => "unknown" as const)]);

// Only these are decoded. GitLab also sends the user, the commit and the approvals: the platform keeps none of them.
const deployment = z
  .object({
    id: z.number(),
    iid: z.number(),
    ref: z.string(),
    sha: z.string(),
    status,
    created_at: z.string(),
    updated_at: z.string(),
    // sent by newer GitLab; the job's own finish time stands in for older ones
    finished_at: z.string().nullish(),
    environment: z.object({ name: z.string() }),
    // an API-made deployment has no job behind it
    deployable: z
      .object({
        id: z.number(),
        finished_at: z.string().nullish(),
        pipeline: z.object({ id: z.number(), web_url: z.string().nullish() }).nullish(),
      })
      .nullish(),
  })
  .transform((d) => ({
    id: d.id,
    iid: d.iid,
    ref: d.ref,
    sha: d.sha,
    status: d.status,
    /** GitLab's environment name: the platform environment's slug. */
    environment: d.environment.name,
    jobId: d.deployable?.id ?? null,
    pipelineId: d.deployable?.pipeline?.id ?? null,
    // an address to put in a message: only a web one, whatever else GitLab (or a proxy in front of it) sent
    pipelineUrl: /^https?:\/\//.test(d.deployable?.pipeline?.web_url ?? "")
      ? (d.deployable?.pipeline?.web_url ?? null)
      : null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    finishedAt: d.finished_at ?? d.deployable?.finished_at ?? null,
  }));
export type Deployment = z.output<typeof deployment>;

const environment = z
  .object({
    id: z.number(),
    name: z.string(),
    slug: z.string(),
    state: z.union([
      z.enum(["available", "stopping", "stopped"]),
      z.string().transform(() => "unknown" as const),
    ]),
  })
  .transform((e) => ({ id: e.id, name: e.name, slug: e.slug, state: e.state }));
export type GitlabEnvironment = z.output<typeof environment>;

export interface ListDeploymentsOptions {
  /** One environment, by GitLab's name. */
  environment?: string;
  status?: DeploymentStatus;
  orderBy?: "id" | "iid" | "created_at" | "updated_at" | "finished_at" | "ref";
  sort?: "asc" | "desc";
}

export function deploymentsApi(client: GitlabClient) {
  return {
    deployments: {
      /** A project's deployments, as many pages as there are (stop early to read fewer). */
      async *list(project: ProjectRef, o: ListDeploymentsOptions = {}) {
        const query = {
          environment: o.environment,
          status: o.status,
          order_by: o.orderBy,
          sort: o.sort,
        };
        for await (const raw of client.paginate(`${projectPath(project)}/deployments`, query)) {
          yield decode(deployment, raw, "deployment");
        }
      },
      async get(project: ProjectRef, id: number) {
        const raw = await client.request("GET", `${projectPath(project)}/deployments/${id}`);
        return decode(deployment, raw, "deployment");
      },
    },
    environments: {
      async *list(project: ProjectRef) {
        for await (const raw of client.paginate(`${projectPath(project)}/environments`)) {
          yield decode(environment, raw, "environment");
        }
      },
    },
  };
}
