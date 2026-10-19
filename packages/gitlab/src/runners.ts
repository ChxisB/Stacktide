import { z } from "zod";
import type { GitlabClient } from "./client";
import { decode } from "./decode";
import { type ProjectRef, projectPath } from "./projects";

const KNOWN = ["online", "offline", "stale", "never_contacted"] as const;
export type RunnerStatus = (typeof KNOWN)[number] | "unknown";

/** A state GitLab adds later reads as `unknown`, which is never counted as online. */
const status = z.union([z.enum(KNOWN), z.string().transform(() => "unknown" as const)]);

// Only these are decoded. The list also carries the runner's address and description, which the platform has no use for.
const runner = z
  .object({
    id: z.number().int(),
    status: status.optional(),
    // GitLab renamed `active` to `paused` (inverted); either may be what a release sends
    paused: z.boolean().optional(),
    active: z.boolean().optional(),
    runner_type: z.string().optional(),
  })
  .transform((r) => ({
    id: r.id,
    online: r.status === "online",
    paused: r.paused ?? (r.active === undefined ? false : !r.active),
    status: r.status ?? ("unknown" as const),
    /** `instance_type`, `group_type` or `project_type`. */
    type: r.runner_type ?? "unknown",
  }));
export type Runner = z.output<typeof runner>;

export function runnersApi(client: GitlabClient) {
  return {
    runners: {
      /**
       * The runners a project can use (its own, its groups' and the instance's) that have **every** tag
       * in `tags`; all of them without it. GitLab shows this to a maintainer of the project and refuses
       * the token otherwise (`forbidden`).
       */
      async *list(project: ProjectRef, o: { tags?: readonly string[] } = {}) {
        const query = o.tags?.length ? { tag_list: o.tags.join(",") } : undefined;
        for await (const raw of client.paginate(`${projectPath(project)}/runners`, query)) {
          yield decode(runner, raw, "runner");
        }
      },
    },
  };
}
