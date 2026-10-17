import { z } from "zod";
import type { GitlabClient } from "./client";
import { decode } from "./decode";
import { type ProjectRef, projectPath } from "./projects";

const KNOWN = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "success",
  "failed",
  "canceling",
  "canceled",
  "skipped",
  "manual",
  "scheduled",
] as const;
export type PipelineStatus = (typeof KNOWN)[number] | "unknown";

/** A status GitLab adds later reads as `unknown` instead of failing the whole response. */
const status = z.union([z.enum(KNOWN), z.string().transform(() => "unknown" as const)]);

/**
 * `success`, `failed`, `canceled` and `skipped` no longer change on their own. `manual`,
 * `scheduled` and `unknown` are not final: a poller needs its own deadline.
 */
export const isFinished = (s: PipelineStatus) =>
  s === "success" || s === "failed" || s === "canceled" || s === "skipped";

const pipeline = z
  .object({
    id: z.number(),
    iid: z.number(),
    status,
    ref: z.string(),
    sha: z.string(),
    web_url: z.string(),
  })
  .transform((p) => ({
    id: p.id,
    iid: p.iid,
    status: p.status,
    ref: p.ref,
    sha: p.sha,
    webUrl: p.web_url,
  }));
export type Pipeline = z.output<typeof pipeline>;

const job = z
  .object({
    id: z.number(),
    name: z.string(),
    stage: z.string(),
    status,
    allow_failure: z.boolean().optional(),
    // GitLab's own word (`script_failure`, `runner_system_failure`...), only on a failed job
    failure_reason: z.string().nullish(),
    web_url: z.string(),
  })
  .transform((j) => ({
    id: j.id,
    name: j.name,
    stage: j.stage,
    status: j.status,
    allowFailure: j.allow_failure ?? false,
    failureReason: j.failure_reason ?? null,
    webUrl: j.web_url,
  }));
export type Job = z.output<typeof job>;

const lint = z
  .object({
    valid: z.boolean(),
    errors: z.array(z.string()).default([]),
    warnings: z.array(z.string()).default([]),
    merged_yaml: z.string().nullish(),
  })
  .transform((l) => ({
    valid: l.valid,
    errors: l.errors,
    warnings: l.warnings,
    /** The config with `include`s and `extends` resolved; null when invalid. */
    mergedYaml: l.merged_yaml ?? null,
  }));
export type LintResult = z.output<typeof lint>;

export interface PipelineVariable {
  key: string;
  /** A secret: sent to GitLab, never logged, scrubbed from errors (values under 4 characters excepted). */
  value: string;
  type?: "env_var" | "file";
}

export function pipelinesApi(client: GitlabClient) {
  const pipe = (p: ProjectRef, id: number) => `${projectPath(p)}/pipelines/${id}`;
  return {
    pipelines: {
      /** Starts a pipeline on `ref` (API source). Variables apply to this pipeline only. */
      async trigger(project: ProjectRef, ref: string, variables: PipelineVariable[] = []) {
        const raw = await client.request("POST", `${projectPath(project)}/pipeline`, {
          body: {
            ref,
            variables: variables.map((v) => ({
              key: v.key,
              value: v.value,
              variable_type: v.type ?? "env_var",
            })),
          },
          redact: variables.map((v) => v.value),
        });
        return decode(pipeline, raw, "pipeline");
      },
      async get(project: ProjectRef, id: number) {
        return decode(pipeline, await client.request("GET", pipe(project, id)), "pipeline");
      },
      async *jobs(project: ProjectRef, id: number) {
        for await (const raw of client.paginate(`${pipe(project, id)}/jobs`)) {
          yield decode(job, raw, "job");
        }
      },
      async retry(project: ProjectRef, id: number) {
        const raw = await client.request("POST", `${pipe(project, id)}/retry`);
        return decode(pipeline, raw, "pipeline");
      },
      async cancel(project: ProjectRef, id: number) {
        const raw = await client.request("POST", `${pipe(project, id)}/cancel`);
        return decode(pipeline, raw, "pipeline");
      },
    },
    ci: {
      /**
       * Checks CI config text against the project. Invalid config is a normal result
       * (`valid: false` with `errors`), not an exception. `dryRun` simulates pipeline creation
       * on `ref` instead of only checking syntax.
       */
      async lint(project: ProjectRef, content: string, o: { dryRun?: boolean; ref?: string } = {}) {
        const raw = await client.request("POST", `${projectPath(project)}/ci/lint`, {
          body: { content, dry_run: o.dryRun, ref: o.ref },
        });
        return decode(lint, raw, "lint result");
      },
    },
  };
}
