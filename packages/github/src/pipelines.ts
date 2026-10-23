import {
  type Gitlab,
  GitlabError,
  type Job,
  type Pipeline,
  type PipelineStatus,
  type ProjectRef,
} from "@orch/gitlab";
import { z } from "zod";
import type { GithubClient } from "./client";
import { decode } from "./decode";
import { whole } from "./paths";

/** What a finished run or job concluded, in the platform's words. */
const CONCLUDED = new Map<string, PipelineStatus>([
  ["success", "success"],
  ["neutral", "success"],
  ["failure", "failed"],
  ["timed_out", "failed"],
  ["startup_failure", "failed"],
  ["cancelled", "canceled"],
  ["stale", "canceled"],
  ["skipped", "skipped"],
  // a run that waits for someone to allow it (a fork's first run) is where a manual pipeline is
  ["action_required", "manual"],
]);

/**
 * One status from GitHub's two. `conclusion` only means something once the run is `completed`; a word GitHub adds
 * later, or a finished run that names no conclusion, is `unknown` and not a guess.
 * A run `waiting` is held for an environment's reviewers, which is the nearest to GitLab's `manual`.
 */
export function statusOf(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): PipelineStatus {
  switch (status) {
    case "requested":
      return "created";
    case "queued":
      return "pending";
    case "pending":
      return "waiting_for_resource";
    case "waiting":
      return "manual";
    case "in_progress":
      return "running";
    case "completed":
      return CONCLUDED.get(conclusion ?? "") ?? "unknown";
    default:
      return "unknown";
  }
}

const run = z
  .object({
    id: z.number(),
    run_number: z.number(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    // a run of a tag or of an event with no branch has none
    head_branch: z.string().nullish(),
    head_sha: z.string(),
    html_url: z.string(),
  })
  .transform(
    (r): Pipeline => ({
      id: r.id,
      iid: r.run_number,
      status: statusOf(r.status, r.conclusion),
      ref: r.head_branch ?? "",
      sha: r.head_sha,
      webUrl: r.html_url,
    }),
  );

const STARTED = new Set(["in_progress", "completed"]);

const job = z
  .object({
    id: z.number(),
    name: z.string(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    html_url: z.string().nullish(),
    started_at: z.string().nullish(),
    completed_at: z.string().nullish(),
  })
  .transform((j): Job => {
    // GitHub dates a job that is still waiting for a runner; that is not a start
    const startedAt = STARTED.has(j.status ?? "") ? (j.started_at ?? null) : null;
    const finishedAt = j.completed_at ?? null;
    const seconds =
      startedAt && finishedAt
        ? Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000)
        : NaN;
    return {
      id: j.id,
      name: j.name,
      // GitHub has no stages (the `stages` capability is off); a job cannot be allowed to fail, and says no reason
      stage: "",
      status: statusOf(j.status, j.conclusion),
      allowFailure: false,
      failureReason: null,
      webUrl: j.html_url ?? "",
      startedAt,
      finishedAt,
      duration: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
    };
  });

/** What a workflow is started with: the workflow's file, the ref it is read from, its inputs, and the run's name. */
export interface StartRun {
  workflow: string;
  ref: string;
  inputs: Record<string, string>;
  /** What the workflow's `run-name` makes of these inputs; the run is found by it. */
  name: string;
}

/** How long to look for a dispatched run. shortcut: ~15 s by default; GitHub shows a run within seconds, raise it if a host is slow. */
export interface FindTuning {
  attempts?: number;
  delayMs?: number;
}

/** A workflow is a file name in `.github/workflows/`: one path segment, so it cannot leave the URL it goes into. */
const WORKFLOW_FILE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

const listed = z.object({
  workflow_runs: z.array(z.object({ id: z.number(), display_title: z.string().nullish() })),
});

/**
 * Workflow runs as pipelines (FRG-14), and a way to start one (FRG-30). `trigger` and `artifact` are not here: a
 * pipeline is triggered with a generated child pipeline, which GitHub has no way to take (ADR-0019), and artifacts are
 * a later task. A run's id is the pipeline's id; its number in the repository is the `iid`.
 */
export function pipelinesApi(
  client: GithubClient,
  base: (p: ProjectRef) => Promise<string>,
  find: FindTuning = {},
): {
  pipelines: Omit<Gitlab["pipelines"], "trigger" | "artifact">;
  startRun: (project: ProjectRef, input: StartRun) => Promise<Pipeline>;
} {
  const { attempts = 10, delayMs = 1500 } = find;
  const at = async (project: ProjectRef, id: number) => {
    const n = whole(id);
    return `${await base(project)}/actions/runs/${n}`;
  };
  const get = async (project: ProjectRef, id: number) =>
    decode(run, await client.request("GET", await at(project, id)), "workflow run");

  /**
   * A dispatch answers 204 and no run id, so the run is the one that is new after it and has its name. The list is
   * read first to know what was there; a list that cannot be read stops the start, because then a run could not be
   * told from another.
   * shortcut: only the newest 100 dispatched runs are looked at, which is enough unless 100 are dispatched between
   * two looks; upgrade by paging when a workflow is dispatched that often.
   */
  async function startRun(project: ProjectRef, input: StartRun) {
    if (!WORKFLOW_FILE.test(input.workflow)) {
      throw new GitlabError("invalid", `Not a workflow file name: ${input.workflow.slice(0, 100)}`);
    }
    if (!input.ref || !input.name) {
      throw new GitlabError("invalid", "A run is started from a ref and found by a name");
    }
    const root = `${await base(project)}/actions/workflows/${input.workflow}`;
    const look = async () =>
      decode(
        listed,
        await client.request("GET", `${root}/runs`, {
          query: { event: "workflow_dispatch", per_page: 100 },
        }),
        "workflow runs",
      ).workflow_runs;
    const before = new Set((await look()).map((r) => r.id));
    await client.request("POST", `${root}/dispatches`, {
      body: { ref: input.ref, inputs: input.inputs },
    });
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, delayMs));
      const fresh = (await look()).filter(
        (r) => r.display_title === input.name && !before.has(r.id),
      );
      if (fresh.length > 1) {
        throw new GitlabError(
          "conflict",
          `Found more than one new run named "${input.name}"; not choosing between them`,
        );
      }
      if (fresh[0]) return get(project, fresh[0].id);
    }
    // the dispatch was accepted: the run may exist, so this is an unknown outcome, and not a failure to start
    throw new GitlabError(
      "timeout",
      `Dispatched "${input.name}" but no run of that name appeared; GitHub may have started it`,
    );
  }

  return {
    startRun,
    pipelines: {
      get,
      async *jobs(project, id) {
        // `latest`: the jobs of the newest attempt of the run, as a retried GitLab pipeline shows its newest jobs
        for await (const raw of client.paginate(
          `${await at(project, id)}/jobs`,
          { filter: "latest" },
          "jobs",
        )) {
          yield decode(job, raw, "workflow job");
        }
      },
      // GitHub has no child pipelines (the `childPipelines` capability is off)
      async *bridges() {},
      async retry(project, id) {
        await client.request("POST", `${await at(project, id)}/rerun-failed-jobs`);
        return get(project, id);
      },
      async cancel(project, id) {
        await client.request("POST", `${await at(project, id)}/cancel`);
        return get(project, id);
      },
    },
  };
}
