import { IAC_TAGS } from "@orch/core";
import {
  attachRunPipeline,
  audit,
  auditedStacks,
  createRun,
  type Db,
  databaseTime,
  getProject,
  listConnections,
  lockStackDrift,
  MAX_RUN_STACKS,
  markDriftRequested,
  queueStackDriftChecks,
} from "@orch/db";
import type { Gitlab } from "@orch/gitlab";
import { GenerateError, generatePipeline, gitlabSource, scanStacks } from "@orch/iac";
import { z } from "zod";
import { type MrPlanConfig, NO_RUN, planRequest, Refused, triggerPlan } from "./mr-plan";
import { hopeless, type RunDeps } from "./pipeline-runs";
import type { JobHandler } from "./worker";

/** Ids only: the check reads the repository when it runs. */
const payloadSchema = z.object({ organizationId: z.uuid(), projectId: z.uuid() });

// The schedule ticks less often than a cadence of hours can be met to the minute, so a stack is due
// a little before its period is up: a tick that comes early is not wasted for a whole extra tick.
const SLACK_MS = 5 * 60_000;
// shortcut: only the first 20 connections of an organization are tried; upgrade with a mapping from
// projects to the connection that imported them.
const CONNECTIONS = 20;

/** The schedule's job: asks for a check of every project with stacks (see `queueStackDriftChecks`). */
export const stackDriftTickHandler =
  (deps: { db: Db }): JobHandler =>
  async (ctx) => {
    const queued = await queueStackDriftChecks(deps.db);
    ctx.log.info("stack drift checks queued", { count: queued });
  };

/**
 * A client of the first connection of the organization that reaches the project, and the commit its
 * default branch is at. The platform does not record which connection a project came through, so
 * each is tried; one that GitLab refuses or that cannot see the project is passed over.
 */
async function reach(deps: RunDeps, organizationId: string, project: number, branch: string) {
  for (const c of await listConnections(deps.db, organizationId, { limit: CONNECTIONS })) {
    if (c.type !== "gitlab") continue;
    try {
      const gitlab: Gitlab = await deps.gitlab(organizationId, c.id);
      return { gitlab, sha: (await gitlab.repository.getBranch(project, branch)).commitId };
    } catch (error) {
      if (!hopeless(error)) throw error;
    }
  }
  return undefined;
}

/**
 * The `stack.drift` job (POL-1): plans the stacks of one project that are due, on the head of its
 * default branch, as a run of kind `drift` whose pipeline plans and never applies. A stack is due
 * when its `drift_every` is up since a check of it was last asked for (less five minutes), or it has
 * never been; what a check finds is recorded when its summary arrives (the plan-summary route). At
 * most a run's worth are asked for at once (the ones that have waited longest), the rest at the next
 * tick. Stack files with errors are
 * left out, but a stack graph that cannot be built plans nothing, as for a merge request. A pipeline
 * GitLab refuses (a default branch whose `.gitlab-ci.yml` lacks the parent snippet) leaves no run,
 * and is not tried again before the stack's period is up. A project no connection reaches is skipped
 * until the next tick; any other failure fails the job so the queue retries it. Checks of one
 * project take turns, so a late tick cannot start a second run of the same stacks.
 */
export const stackDriftCheckHandler =
  (deps: RunDeps & { config: MrPlanConfig }): JobHandler =>
  async (ctx) => {
    const ids = payloadSchema.parse(ctx.payload);
    const { db } = deps;
    const project = await getProject(db, ids.organizationId, ids.projectId);
    const gitlabProjectId = project?.gitlabProjectId;
    if (!project || gitlabProjectId == null) return;
    if (!project.detectedTypes.some((d) => IAC_TAGS.includes(d.tag))) return;

    const found = await reach(deps, project.organizationId, gitlabProjectId, project.defaultBranch);
    if (!found) {
      ctx.log.warn("no connection reaches the project", { project: project.id });
      return;
    }
    const { gitlab, sha } = found;
    const scan = await scanStacks(gitlabSource(gitlab, gitlabProjectId, sha));
    const scheduled = scan.stacks.flatMap((s) =>
      s.driftEverySeconds === undefined
        ? []
        : [{ name: s.name, every: s.driftEverySeconds * 1000 }],
    );
    if (scheduled.length === 0) return;
    const now = await (deps.now ?? (() => databaseTime(db)))();
    const at = { organizationId: project.organizationId, projectId: project.id };
    const actor = { kind: "job", id: ctx.id };

    await db.transaction(async (tx) => {
      const rows = await lockStackDrift(tx, at.organizationId, at.projectId);
      if (!rows) return;
      const asked = new Map(rows.map((r) => [r.stack, r.requestedAt.getTime()]));
      // the stacks that have waited longest go first (never asked: first), so that when more are due
      // than a run holds, the same ones are not chosen at every tick
      const due = scheduled
        .filter((s) => {
          const last = asked.get(s.name);
          return last === undefined || now.getTime() - last >= s.every - SLACK_MS;
        })
        .sort(
          (a, b) =>
            (asked.get(a.name) ?? 0) - (asked.get(b.name) ?? 0) || (a.name < b.name ? -1 : 1),
        )
        .slice(0, MAX_RUN_STACKS)
        .map((s) => s.name)
        .sort();
      if (due.length === 0) return;

      const request = (runId: string) => planRequest(deps.config, at, scan.stacks, due, runId);
      try {
        generatePipeline(request(NO_RUN));
      } catch (error) {
        if (!(error instanceof GenerateError)) throw error;
        ctx.log.warn("the drift pipeline cannot be generated", {
          project: project.id,
          problems: error.problems.slice(0, 3),
        });
        return;
      }
      // asked for even if GitLab refuses the pipeline: a broken default branch is tried once a period
      for (const stack of due) await markDriftRequested(tx, { ...at, stack }, now);
      try {
        // A savepoint: a pipeline GitLab refuses leaves no run behind.
        await tx.transaction(async (sp) => {
          const run = await createRun(sp, {
            ...at,
            ref: project.defaultBranch,
            sha,
            kind: "drift",
            stacks: due,
          });
          await audit(
            sp,
            { actor },
            {
              action: "run.create",
              resourceType: "run",
              resourceId: run.id,
              ...at,
              metadata: { ref: run.ref, sha, kind: "drift", ...auditedStacks(due) },
            },
          );
          const pipeline = await triggerPlan(
            gitlab,
            gitlabProjectId,
            project.defaultBranch,
            generatePipeline(request(run.id)),
          );
          await attachRunPipeline(sp, {
            ...at,
            runId: run.id,
            gitlabPipelineId: pipeline.id,
            action: "plan",
          });
        });
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        ctx.log.warn("GitLab could not start the drift pipeline", {
          project: project.id,
          reason: error.message.slice(0, 200),
        });
      }
    });
  };
