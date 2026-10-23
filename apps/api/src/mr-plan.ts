import { type CostLimit, IAC_TAGS, isCosted, type Logger, limitOf } from "@orch/core";
import {
  allCostLimits,
  allPools,
  attachRunPipeline,
  audit,
  auditedStacks,
  createRun,
  type Db,
  describeError,
  getProject,
  latestRunOfMergeRequest,
  linkedProjects,
  listPolicySets,
  MAX_POLICY_SETS,
  MAX_RUN_STACKS,
  type MergeRequestNote,
  saveMergeRequestNote,
  supersedeRuns,
  type Tx,
  withMergeRequest,
} from "@orch/db";
import type { Forge } from "@orch/forge";
import { type Gitlab, GitlabError, type MergeRequest } from "@orch/gitlab";
import {
  buildGraph,
  detectChanges,
  GenerateError,
  generatePipeline,
  githubRunPlan,
  gitlabSource,
  type PlanInput,
  type PolicySet,
  type PoolRef,
  STACK_WORKFLOW_FILE,
  scanStacks,
  type Tool,
} from "@orch/iac";
import { z } from "zod";
import { startForgeRun } from "./forge-run";
import { inline, writeNote } from "./mr-note";
import { type EventDeps, hopeless, type RunDeps } from "./pipeline-runs";
import type { JobContext, JobHandler } from "./worker";

/**
 * The file-type variable a plan pipeline is started with: the generated child pipeline (IAC-4). The
 * project's `.gitlab-ci.yml` runs it with `trigger: include: artifact` (docs/iac.md); nothing is
 * written to the repository.
 */
export const CHILD_PIPELINE = "ORCH_CHILD_PIPELINE";

// Only these events say that the merge request's commits may have changed.
const ACTIONS = new Set(["open", "reopen", "update"]);
// GitHub's names for them (the other pull request actions change nothing a plan reads).
const GITHUB_ACTIONS: Readonly<Record<string, string | undefined>> = {
  opened: "open",
  reopened: "reopen",
  synchronize: "update",
};

/** What a plan reads and cancels on: GitLab's client, or a forge that is GitLab-shaped (GitHub, FRG-32). */
export type PlanClient = Omit<Gitlab, "groups">;
/** A forge that runs a fixed workflow, started by a dispatch, instead of a generated pipeline. */
export const isGithub = (client: PlanClient): client is Forge =>
  "kind" in client && client.kind === "github";
// A run's id is part of the summary path, and it is not known until the run exists: the generator
// checks everything else about the request first, with this in its place.
export const NO_RUN = "00000000-0000-0000-0000-000000000000";

export interface MrPlanConfig {
  /** The API as the runners reach it, without a trailing slash. */
  apiUrl: string;
  /** The `aud` of the platform's CI token (`ORCH_CI_AUDIENCE`). */
  audience: string;
  /** An image with `orch`, `curl` and `jq`, for the job that posts a summary. */
  helperImage: string;
  /** An image with those and `conftest`, for the summary job of a stack that policy judges (POL-3). */
  policyImage?: string | undefined;
  /**
   * An image with `infracost` and `jq`, for the estimate job of a stack a cost limit reaches (COST-4).
   * Without it no stack is estimated, and a stack under a limit has no estimate to judge: the platform
   * denies its apply and the merge request says why.
   */
  costImage?: string | undefined;
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

/** What a `pull_request` job says (FRG-21): which pull request changed and where its branch is, never what it holds. */
export const githubPullEvent = z.looseObject({
  event: z.literal("pull_request"),
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  projectId: z.number().int().positive(),
  iid: z.number().int().positive(),
  action: z.string(),
  headRepositoryId: z.number().int().positive().optional(),
});

/**
 * The platform's project a merge request event is about, if it is one whose merge requests are
 * planned and applied: linked to GitLab and seen to hold Terraform (or Terragrunt) at the import.
 * A GitHub repository is found by its connection too, since its number can be a GitLab project's.
 */
export async function plannedProject(
  db: Db,
  organizationId: string,
  gitlabProjectId: number,
  connectionId?: string,
) {
  const [linked] = await linkedProjects(db, organizationId, [gitlabProjectId], connectionId);
  const project = linked && (await getProject(db, organizationId, linked.id));
  return project?.detectedTypes.some((d) => IAC_TAGS.includes(d.tag)) ? project : undefined;
}

/** GitLab would not start the pipeline: what a person must fix, not something a retry changes. */
export class Refused extends Error {}

/** The plan pipeline of the `select`ed stacks as the run `runId` (see `NO_RUN`) is to report on it. */
export const planRequest = (
  config: MrPlanConfig,
  at: { organizationId: string; projectId: string },
  stacks: PlanInput["stacks"],
  select: readonly string[],
  runId: string,
  /** The organization's policy sets; a drift check passes none (POL-3 judges merge request plans). */
  policy: readonly PolicySet[],
  /** The organization's cost limits: the stacks one reaches are estimated (COST-4); a drift check passes none. */
  limits: readonly CostLimit[],
  /** The organization's worker pools: a stack's jobs ask for its pool's runners (POOL-3). Required: leaving them out would run every stack on shared runners. */
  pools: readonly PoolRef[],
): PlanInput => {
  const run = `/organizations/${at.organizationId}/projects/${at.projectId}/runs/${runId}`;
  // an estimate is made only where a limit will judge it: the rest cost nothing and send nothing to the pricing service
  const costed = config.costImage
    ? stacks.filter((s) => select.includes(s.name) && limitOf(limits, s)).map((s) => s.name)
    : [];
  return {
    action: "plan",
    audience: config.audience,
    apiUrl: config.apiUrl,
    summaryPath: `${run}/plan-summary`,
    helperImage: config.helperImage,
    stacks,
    select,
    pools,
    ...(config.images ? { images: config.images } : {}),
    ...(policy.length > 0
      ? { policy: { sets: policy, image: config.policyImage, path: `${run}/policy-verdict` } }
      : {}),
    ...(config.costImage && costed.length > 0
      ? { cost: { image: config.costImage, stacks: costed } }
      : {}),
  };
};

/** Starts a pipeline on `ref` that runs the generated child pipeline; `Refused` when GitLab will not. */
export async function triggerPlan(
  gitlab: Pick<Gitlab, "pipelines">,
  project: number,
  ref: string,
  yaml: string,
) {
  try {
    return await gitlab.pipelines.trigger(project, ref, [
      { key: CHILD_PIPELINE, value: yaml, type: "file" },
    ]);
  } catch (error) {
    if (error instanceof GitlabError && error.kind === "invalid") throw new Refused(error.message);
    throw error;
  }
}

/**
 * Keeps the plan of a run and dispatches its workflow (FRG-30); `Refused` when GitHub will not start it. GitHub's own
 * words are not repeated: they can hold anything the repository's file or a person typed.
 */
async function dispatchPlan(forge: Forge, tx: Tx, run: Parameters<typeof startForgeRun>[1]) {
  try {
    return await startForgeRun({ db: tx, forge }, run);
  } catch (error) {
    if (error instanceof GitlabError && (error.kind === "invalid" || error.kind === "not_found")) {
      throw new Refused(
        `GitHub could not start the workflow ${STACK_WORKFLOW_FILE}: it refused the dispatch. Check that the file is on this branch and can be started by hand.`,
      );
    }
    throw error;
  }
}

interface Turn {
  deps: RunDeps & { config: MrPlanConfig };
  gitlab: PlanClient;
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

async function onBranch(gitlab: PlanClient, project: number, branch: string, sha: string) {
  try {
    return (await gitlab.repository.getBranch(project, branch)).commitId === sha;
  } catch (error) {
    if (error instanceof GitlabError && error.kind === "not_found") return false;
    throw error;
  }
}

/** Stops pipelines and the child pipelines they started. Best effort: a plan only reads. */
async function stop(
  gitlab: PlanClient,
  project: number,
  pipelines: readonly number[],
  log: Logger,
) {
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
    const noun = isGithub(gitlab) ? "pull request" : "merge request";
    await finish([
      `Not planned: the source branch is not in this project at this commit (a ${noun} from a fork is not planned).`,
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

  // all of the organization's sets (there are at most MAX_POLICY_SETS), read in the merge request's lock
  const sets = await listPolicySets(tx, at.organizationId, { limit: MAX_POLICY_SETS });
  const limits = await allCostLimits(tx, at.organizationId);
  const pools = await allPools(tx, at.organizationId);
  const request = (runId: string) =>
    planRequest(deps.config, at, scan.stacks, affected, runId, sets, limits, pools);
  const github = isGithub(gitlab) ? gitlab : undefined;
  try {
    // GitHub runs a fixed workflow from the stored plan; what it cannot run is refused here, as the generator refuses
    if (github) githubRunPlan(request(NO_RUN));
    else generatePipeline(request(NO_RUN));
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
        // what judges the plan under a cost limit, in this commit (see `run_stacks.tags`)
        tags: Object.fromEntries(scan.stacks.map((s) => [s.name, s.tags])),
        uncosted: scan.stacks.filter((s) => !isCosted(s.tool)).map((s) => s.name),
        // a zone's `dns.prune` in this commit: what its plan may delete (DNS-7)
        dnsPrune: Object.fromEntries(
          scan.stacks
            .filter((s) => s.tool === "dnscontrol")
            .map((s) => [s.name, s.dnsPrune ?? false]),
        ),
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
      const pipeline = github
        ? await dispatchPlan(github, sp, {
            organizationId: at.organizationId,
            projectId: at.projectId,
            project: at.gitlabProjectId,
            runId: run.id,
            ref: mr.sourceBranch,
            input: request(run.id),
          })
        : await triggerPlan(
            gitlab,
            at.gitlabProjectId,
            mr.sourceBranch,
            generatePipeline(request(run.id)),
          );
      await attachRunPipeline(sp, {
        organizationId: at.organizationId,
        projectId: at.projectId,
        runId: run.id,
        gitlabPipelineId: pipeline.id,
        action: "plan",
      });
    });
    // a limit with nothing to estimate with denies the apply: say why, where the author looks
    const unestimated = deps.config.costImage
      ? []
      : scan.stacks.filter((s) => affected.includes(s.name) && limitOf(limits, s));
    if (unestimated.length > 0) {
      notes.push(
        list(
          "A cost limit reaches these stacks, but the worker has no cost image (ORCH_COST_IMAGE): they have no estimate and cannot be applied.",
          unestimated.map((s) => s.name),
        ),
      );
    }
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    notes.push(
      github ? error.message : list("GitLab could not start the pipeline:", [error.message]),
    );
  }
  return notes;
}

/**
 * Plans the merge request's newest commit if no run has (see `plan`) and stops the pipelines of the
 * runs that replaced. The audit events are the job's unless `actor` says whose command it is.
 */
export async function planMergeRequest(
  deps: RunDeps & { config: MrPlanConfig },
  gitlab: PlanClient,
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
 * The `gitlab.event` consumer for merge requests (IAC-7) and, for GitHub, for pull requests (FRG-32). An event only
 * says that a merge request changed, so the job reads the merge request from the forge, and plans its head commit if
 * no run has: a repeated or late event reads the same thing and finds the run made. Events other than opening,
 * reopening and updating (GitHub: opened, reopened, synchronize) are ignored, so are those of projects that are not
 * linked or were not seen to hold Terraform; one that no retry could serve (the merge request is gone, the forge
 * refuses the token) is dropped, and any other failure fails the job so that the queue retries it.
 *
 * Plans only what the platform's own projects hold: a merge request from a fork is refused, since
 * its author would control what runs with the project's credentials.
 */
export const mrPlanHandler =
  (deps: EventDeps & { config: MrPlanConfig }): JobHandler =>
  async (ctx) => {
    const github = githubPullEvent.safeParse(ctx.payload);
    const parsed = github.success ? github : mrEvent.safeParse(ctx.payload);
    if (!parsed.success) return;
    const e = parsed.data;
    if (!ACTIONS.has((github.success ? GITHUB_ACTIONS[e.action] : e.action) ?? "")) return;
    // shortcut: a fork's pull request is dropped with a log line and no note, so a stranger's pull request cannot make the
    // platform comment; a person sees it is not planned by there being no table. Upgrade by a note once the repository's
    // collaborators are the only ones who can cause one.
    if (github.success && github.data.headRepositoryId !== e.projectId) {
      ctx.log.info("pull request from a fork is not planned", { connection: e.connectionId });
      return;
    }
    const open = github.success ? deps.forge : deps.gitlab;
    if (!open) {
      ctx.log.warn("merge request event dropped", { reason: "no way to open the connection" });
      return;
    }
    const project = await plannedProject(
      deps.db,
      e.organizationId,
      e.projectId,
      github.success ? e.connectionId : undefined,
    );
    if (!project) return;
    const at = {
      organizationId: e.organizationId,
      projectId: project.id,
      gitlabProjectId: e.projectId,
    };
    try {
      const client = await open(e.organizationId, e.connectionId);
      await planMergeRequest(deps, client, ctx, at, e.iid);
    } catch (error) {
      // a 404 may be the merge request, or the repository or branch it reads
      const why = hopeless(
        error,
        "the merge request or its repository",
        github.success ? "GitHub" : "GitLab",
      );
      if (!why) throw error;
      ctx.log.warn("merge request event dropped", { reason: why, connection: e.connectionId });
    }
  };
