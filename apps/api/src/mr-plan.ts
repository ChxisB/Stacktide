import type { Logger } from "@orch/core";
import {
  attachRunPipeline,
  audit,
  auditedStacks,
  createRun,
  type Db,
  describeError,
  getProject,
  latestRunOfMergeRequest,
  linkedProjects,
  MAX_RUN_STACKS,
  type MergeRequestNote,
  saveMergeRequestNote,
  supersedeRuns,
  type Tx,
  withMergeRequest,
} from "@orch/db";
import { type Gitlab, GitlabError, type MergeRequest } from "@orch/gitlab";
import {
  buildGraph,
  detectChanges,
  GenerateError,
  generatePipeline,
  gitlabSource,
  type PlanInput,
  scanStacks,
  type Tool,
} from "@orch/iac";
import { z } from "zod";
import { inline, writeNote } from "./mr-note";
import { hopeless, type RunDeps } from "./pipeline-runs";
import type { JobContext, JobHandler } from "./worker";

/**
 * The file-type variable a plan pipeline is started with: the generated child pipeline (IAC-4). The
 * project's `.gitlab-ci.yml` runs it with `trigger: include: artifact` (docs/iac.md); nothing is
 * written to the repository.
 */
export const CHILD_PIPELINE = "ORCH_CHILD_PIPELINE";

// Only these events say that the merge request's commits may have changed.
const ACTIONS = new Set(["open", "reopen", "update"]);
// The projects whose merge requests are planned: those the import saw Terraform (or Terragrunt) in.
const PLANNED = new Set(["terraform", "terragrunt"]);
// A run's id is part of the summary path, and it is not known until the run exists: the generator
// checks everything else about the request first, with this in its place.
const NO_RUN = "00000000-0000-0000-0000-000000000000";

export interface MrPlanConfig {
  /** The API as the runners reach it, without a trailing slash. */
  apiUrl: string;
  /** The `aud` of the platform's CI token (`ORCH_CI_AUDIENCE`). */
  audience: string;
  /** An image with `orch`, `curl` and `jq`, for the job that posts a summary. */
  helperImage: string;
  /** Image repository per tool that has no default (Terragrunt). */
  images?: Partial<Record<Tool, string>>;
}

/** What a `gitlab.event` job says of a merge request: only which one changed, never what it holds. */
export const mrEvent = z.looseObject({
  event: z.literal("merge_request"),
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  projectId: z.number().int().positive(),
  iid: z.number().int().positive(),
  action: z.string(),
});

/**
 * The platform's project a merge request event is about, if it is one whose merge requests are
 * planned and applied: linked to GitLab and seen to hold Terraform (or Terragrunt) at the import.
 */
export async function plannedProject(db: Db, organizationId: string, gitlabProjectId: number) {
  const [linked] = await linkedProjects(db, organizationId, [gitlabProjectId]);
  const project = linked && (await getProject(db, organizationId, linked.id));
  return project?.detectedTypes.some((d) => PLANNED.has(d.tag)) ? project : undefined;
}

/** GitLab would not start the pipeline: what a person must fix, not something a retry changes. */
class Refused extends Error {}

interface Turn {
  deps: RunDeps & { config: MrPlanConfig };
  gitlab: Gitlab;
  ctx: JobContext;
  /** Who the audit events are written as: the job, or the person whose command this is. */
  actor: { kind: string; id: string };
  at: { organizationId: string; projectId: string; gitlabProjectId: number };
  iid: number;
}

// A list in the note: each line is repository text or GitLab's, so each is a code span. A notice is
// at most two lists and the column holds 1000 characters: heading + 3 lines of 120 stays near 450.
const list = (heading: string, lines: readonly string[]) =>
  [
    heading,
    "",
    ...lines.slice(0, 3).map((l) => `- ${inline(l, 120)}`),
    ...(lines.length > 3 ? [`- and ${lines.length - 3} more`] : []),
  ].join("\n");

async function onBranch(gitlab: Gitlab, project: number, branch: string, sha: string) {
  try {
    return (await gitlab.repository.getBranch(project, branch)).commitId === sha;
  } catch (error) {
    if (error instanceof GitlabError && error.kind === "not_found") return false;
    throw error;
  }
}

/** Stops pipelines and the child pipelines they started. Best effort: a plan only reads. */
async function stop(gitlab: Gitlab, project: number, pipelines: readonly number[], log: Logger) {
  for (const id of pipelines) {
    const all = [id];
    try {
      for await (const bridge of gitlab.pipelines.bridges(project, id)) {
        if (bridge.downstreamPipelineId !== null) all.push(bridge.downstreamPipelineId);
      }
    } catch (error) {
      log.warn("could not list the child pipelines of a stale pipeline", {
        pipeline: id,
        error: describeError(error),
      });
    }
    for (const pipeline of all) {
      try {
        await gitlab.pipelines.cancel(project, pipeline);
      } catch (error) {
        log.warn("could not stop a stale pipeline", { pipeline, error: describeError(error) });
      }
    }
  }
}

/**
 * Plans the merge request's newest commit when no run has: the stacks it changes and those that
 * depend on them, in a run, a pipeline and one note. Everything is read from GitLab inside the
 * merge request's lock, so an event that lost the race plans what is there now. Returns the plan
 * pipelines of the runs this one replaced, to stop once the change is stored.
 */
async function plan(c: Turn, tx: Tx, row: MergeRequestNote): Promise<number[]> {
  const { gitlab, at, iid } = c;
  const mr = await gitlab.mergeRequests.get(at.gitlabProjectId, iid);
  if (mr.state !== "opened" || mr.sha === null) return [];
  const { sha } = mr;
  const last = await latestRunOfMergeRequest(tx, at.organizationId, at.projectId, iid);
  if (last?.sha === sha) return [];

  const finish = async (notes: readonly string[]) => {
    const notice = notes.length > 0 ? notes.join("\n\n") : null;
    await saveMergeRequestNote(tx, row, { notice });
    await writeNote(tx, { ...row, notice }, gitlab, at.gitlabProjectId);
  };
  // A commit of a fork is not one of this project's branches, and a plan runs in this project's CI
  // with its credentials: the author of the commit would control what runs.
  if (!(await onBranch(gitlab, at.gitlabProjectId, mr.sourceBranch, sha))) {
    await finish([
      "Not planned: the source branch is not in this project at this commit (a merge request from a fork is not planned).",
    ]);
    return [];
  }

  const { actor } = c;
  const stale = await supersedeRuns(tx, at.organizationId, at.projectId, iid, sha);
  for (const runId of stale.runs) {
    await audit(
      tx,
      { actor },
      {
        action: "run.supersede",
        resourceType: "run",
        resourceId: runId,
        organizationId: at.organizationId,
        projectId: at.projectId,
        metadata: { mergeRequestIid: iid, sha },
      },
    );
  }
  await finish(await start(c, tx, mr, sha));
  return stale.pipelines;
}

/** Makes the run and starts its pipeline; returns what the note should say besides the table. */
async function start(c: Turn, tx: Tx, mr: MergeRequest, sha: string): Promise<string[]> {
  const { deps, gitlab, at, iid } = c;
  const notes: string[] = [];
  const scan = await scanStacks(gitlabSource(gitlab, at.gitlabProjectId, sha));
  const errors = scan.problems.filter((p) => p.severity === "error");
  // a stack the merge request broke is not in the scan: saying "no stack is affected" would be false
  if (errors.length > 0) {
    notes.push(
      list(
        "Stack files with errors were left out:",
        errors.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)),
      ),
    );
  }
  const { changed } = await detectChanges(
    gitlab,
    at.gitlabProjectId,
    mr.targetBranch,
    sha,
    scan.stacks,
  );
  const built = buildGraph(scan.stacks.map((s) => ({ name: s.name, dependsOn: s.dependsOn })));
  if (!built.ok) {
    notes.push(
      list(
        "The stacks' dependencies cannot be planned:",
        built.errors.map((e) => e.message),
      ),
    );
    return notes;
  }
  const affected = built.graph.affected(changed);
  // shortcut: a commit that affects no stack makes no run, so every later update event of the merge
  // request scans it again; upgrade by storing the commit the notice is about.
  if (affected.length === 0) {
    if (errors.length === 0) notes.push("No stack is affected by this commit.");
    return notes;
  }
  if (affected.length > MAX_RUN_STACKS) {
    notes.push(`${affected.length} stacks are affected; a run plans at most ${MAX_RUN_STACKS}.`);
    return notes;
  }

  const { config } = deps;
  const request = (runId: string): PlanInput => ({
    action: "plan",
    audience: config.audience,
    apiUrl: config.apiUrl,
    summaryPath: `/organizations/${at.organizationId}/projects/${at.projectId}/runs/${runId}/plan-summary`,
    helperImage: config.helperImage,
    stacks: scan.stacks,
    select: affected,
    ...(config.images ? { images: config.images } : {}),
  });
  try {
    generatePipeline(request(NO_RUN));
  } catch (error) {
    if (!(error instanceof GenerateError)) throw error;
    notes.push(list("The pipeline could not be generated:", error.problems));
    return notes;
  }

  try {
    // A savepoint: a pipeline GitLab refuses leaves no run behind, and the rest of the turn stays.
    await tx.transaction(async (sp) => {
      const run = await createRun(sp, {
        organizationId: at.organizationId,
        projectId: at.projectId,
        ref: mr.sourceBranch,
        sha,
        mergeRequestIid: iid,
        stacks: affected,
      });
      await audit(
        sp,
        { actor: c.actor },
        {
          action: "run.create",
          resourceType: "run",
          resourceId: run.id,
          organizationId: at.organizationId,
          projectId: at.projectId,
          metadata: { ref: run.ref, sha, mergeRequestIid: iid, ...auditedStacks(affected) },
        },
      );
      let pipeline: { id: number };
      try {
        pipeline = await gitlab.pipelines.trigger(at.gitlabProjectId, mr.sourceBranch, [
          { key: CHILD_PIPELINE, value: generatePipeline(request(run.id)), type: "file" },
        ]);
      } catch (error) {
        if (error instanceof GitlabError && error.kind === "invalid") {
          throw new Refused(error.message);
        }
        throw error;
      }
      await attachRunPipeline(sp, {
        organizationId: at.organizationId,
        projectId: at.projectId,
        runId: run.id,
        gitlabPipelineId: pipeline.id,
        action: "plan",
      });
    });
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    notes.push(list("GitLab could not start the pipeline:", [error.message]));
  }
  return notes;
}

/**
 * Plans the merge request's newest commit if no run has (see `plan`) and stops the pipelines of the
 * runs that replaced. The audit events are the job's unless `actor` says whose command it is.
 */
export async function planMergeRequest(
  deps: RunDeps & { config: MrPlanConfig },
  gitlab: Gitlab,
  ctx: JobContext,
  at: Turn["at"],
  iid: number,
  actor: Turn["actor"] = { kind: "job", id: ctx.id },
) {
  const turn: Turn = { deps, gitlab, ctx, actor, at, iid };
  const stale = await withMergeRequest(deps.db, at.organizationId, at.projectId, iid, (tx, row) =>
    plan(turn, tx, row),
  );
  await stop(gitlab, at.gitlabProjectId, stale, ctx.log);
}

/**
 * The `gitlab.event` consumer for merge requests (IAC-7). An event only says that a merge request
 * changed, so the job reads the merge request from GitLab, and plans its head commit if no run has:
 * a repeated or late event reads the same thing and finds the run made. Events other than opening,
 * reopening and updating are ignored, so are those of projects that are not linked or were not
 * seen to hold Terraform; one that no retry could serve (the merge request is gone, GitLab refuses
 * the token) is dropped, and any other failure fails the job so that the queue retries it.
 *
 * Plans only what the platform's own projects hold: a merge request from a fork is refused, since
 * its author would control what runs with the project's credentials.
 */
export const mrPlanHandler =
  (deps: RunDeps & { config: MrPlanConfig }): JobHandler =>
  async (ctx) => {
    const parsed = mrEvent.safeParse(ctx.payload);
    if (!parsed.success || !ACTIONS.has(parsed.data.action)) return;
    const e = parsed.data;
    const project = await plannedProject(deps.db, e.organizationId, e.projectId);
    if (!project) return;
    const at = {
      organizationId: e.organizationId,
      projectId: project.id,
      gitlabProjectId: e.projectId,
    };
    try {
      const gitlab = await deps.gitlab(e.organizationId, e.connectionId);
      await planMergeRequest(deps, gitlab, ctx, at, e.iid);
    } catch (error) {
      // a 404 may be the merge request, or the repository or branch it reads
      const why = hopeless(error, "the merge request or its repository");
      if (!why) throw error;
      ctx.log.warn("merge request event dropped", { reason: why, connection: e.connectionId });
    }
  };
