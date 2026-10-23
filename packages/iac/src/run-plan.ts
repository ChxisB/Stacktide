import { z } from "zod";
import { buildPipeline, type GenerateInput, stateModeOf } from "./pipeline-gen";
import type { Stack } from "./scan";
import { TOOLS } from "./stack";

/** The jobs of a stack the plan holds. The manual `import` extra of a DNS zone is left out: it is GitLab's own button. */
export const PLAN_JOBS = ["plan", "estimate", "summary", "apply"] as const;

const job = z.object({
  commands: z.array(z.string()),
  image: z.string(),
  /** The runner tags of the stack's worker pool; none for shared runners. */
  tags: z.array(z.string()),
  /** Variables the job is given: names and references (`$CI_JOB_TOKEN`), never a secret's value. */
  env: z.record(z.string(), z.string()),
  /** Name of an identity token the job asks the runner for, and its audience. */
  idTokens: z.record(z.string(), z.string()),
  allowFailure: z.boolean(),
});

/**
 * What the platform judged of a stack's plan (FRG-29): the counts and the address and actions of each resource, as the
 * plan's summary posted them (`SUMMARY_FILTER`), never a value. An apply on a runner with no saved plan plans again
 * and applies only when the new plan's summary is this one.
 */
export const judgedSchema = z.object({
  add: z.number().int().min(0),
  change: z.number().int().min(0),
  destroy: z.number().int().min(0),
  resources: z.array(z.object({ address: z.string(), actions: z.array(z.string()) })),
});
export type Judged = z.infer<typeof judgedSchema>;

const stack = z.object({
  name: z.string(),
  path: z.string(),
  tool: z.enum(TOOLS),
  version: z.string(),
  environment: z.string().nullable(),
  state: z.enum(["orch", "gitlab", "own", "none"]),
  /** The selected stacks this one waits for (those between them that are not selected are looked through). */
  needs: z.array(z.string()),
  jobs: z.object({
    plan: job.optional(),
    estimate: job.optional(),
    summary: job.optional(),
    apply: job.optional(),
  }),
  /** Only in the plan of an apply on GitHub (`githubRunPlan`): what the apply must find when it plans again. */
  judged: judgedSchema.optional(),
});

/** The plan of a run as data (FRG-17): stacks in dependency levels, each with its commands. */
export const runPlanSchema = z.object({
  action: z.enum(["plan", "apply"]),
  /** Only in the plan of an apply on GitHub: the commit the plan was judged at, which the apply checks out. */
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  levels: z.array(z.array(stack)),
});
export type RunPlan = z.infer<typeof runPlanSchema>;

/** A job as the GitLab generator builds it; only what the plan reads. */
interface GitlabJob {
  image: { name: string };
  tags?: string[];
  variables?: Record<string, string>;
  id_tokens?: Record<string, { aud: string }>;
  allow_failure?: boolean;
  needs: { job: string }[];
  script: string[];
}

/**
 * The plan of a run for a runner that is not GitLab: the levels the stacks run in, and for each stack the commands,
 * image, runner tags, variables and identity tokens of its jobs. It is read off the jobs `generatePipeline` writes,
 * from the same input, so the two cannot differ. Throws the generator's `GenerateError` for a request it refuses.
 */
export function runPlan(input: GenerateInput): RunPlan {
  const { action, jobs, waves } = buildPipeline(input);
  const stacks = new Map<string, Stack>(input.stacks.map((s) => [s.name, s]));
  const levels = waves.map((wave) =>
    wave.map((name) => {
      const s = stacks.get(name) as Stack;
      const found: RunPlan["levels"][number][number]["jobs"] = {};
      for (const kind of PLAN_JOBS) {
        const j = jobs[`${kind}:${name}`] as GitlabJob | undefined;
        if (!j) continue;
        found[kind] = {
          commands: j.script,
          image: j.image.name,
          tags: j.tags ?? [],
          env: j.variables ?? {},
          idTokens: Object.fromEntries(
            Object.entries(j.id_tokens ?? {}).map(([n, t]) => [n, t.aud]),
          ),
          allowFailure: j.allow_failure === true,
        };
      }
      const own = jobs[`${action}:${name}`] as GitlabJob;
      return {
        name,
        path: s.path,
        tool: s.tool,
        version: s.version as string,
        environment: s.environment ?? null,
        state: stateModeOf(s),
        needs: own.needs.map((n) => n.job.slice(action.length + 1)),
        jobs: found,
      };
    }),
  );
  return { action, levels };
}
