import { costVerdict, DomainError, type Logger, limitOf } from "@orch/core";
import {
  type AuditEvent,
  allCostLimits,
  allPools,
  attachRunPipeline,
  audit,
  auditedStacks,
  claimedZones,
  consumeApproval,
  type Db,
  describeError,
  getPlanResources,
  latestRunOfMergeRequest,
  listPolicySets,
  MAX_POLICY_SETS,
  moveRunStack,
  pgConstraint,
  planCostOf,
  protectedEnvironments,
  type RunWithStacks,
  ruleNames,
  saveMergeRequestNote,
  type Tx,
  withMergeRequest,
} from "@orch/db";
import { GitlabError } from "@orch/gitlab";
import {
  GenerateError,
  generatePipeline,
  gitlabSource,
  type Judged,
  PLAN_RETENTION_MS,
  type Platform,
  scanStacks,
  setsFor,
  type Tool,
  ZONE,
} from "@orch/iac";
import { approvalRequired } from "./apply-approval";
import { DNS_RULES, zonesOf } from "./dns-gate";
import { startForgeRun } from "./forge-run";
import { inline, refreshNote, writeNote } from "./mr-note";
import {
  CHILD_PIPELINE,
  isGithub,
  type MrPlanConfig,
  mrEvent,
  type PlanClient,
  plannedProject,
  planRequest,
} from "./mr-plan";
import { hopeless, type RunDeps } from "./pipeline-runs";
import { secretGateOf } from "./secret-gate";
import type { JobHandler } from "./worker";

export interface ApplyDeps {
  db: Db;
  log: Logger;
  /** Image repository per tool that has no default (Terragrunt). */
  images?: Partial<Record<Tool, string>> | undefined;
  /** Where the platform is: a stack whose state lives there needs it in its apply job (STATE-5). */
  platform?: Platform | undefined;
  /** The plan workflow's settings, which a pull request's apply on GitHub is built from (FRG-32); left out, it is refused. */
  config?: MrPlanConfig | undefined;
  now?: () => Date;
}

export interface ApplyRequest {
  at: { organizationId: string; projectId: string; gitlabProjectId: number };
  run: RunWithStacks;
  /** The stacks to apply, on `command`; the stacks that are planned when left out. */
  stacks?: readonly string[] | undefined;
  /**
   * `command`: a maintainer asked, so the merge request must be open, approved and mergeable (or
   * merged). `merge`: GitLab merged it, and only the stacks that opted in with `apply_on: merge` go.
   */
  when: "command" | "merge";
  /** Writes the audit event in the transaction that claims the stacks, as whoever asked. */
  audit: (tx: Tx, event: AuditEvent) => Promise<void>;
}

// What a merge on the merge path may still apply: not yet applying, applied or given up on.
const NOT_STARTED = new Set(["queued", "planning", "planned"]);

const refuse = (code: string, message: string, status = 409) =>
  new DomainError(code, status, message);
const quoted = (names: readonly string[]) =>
  `${names
    .slice(0, 5)
    .map((n) => JSON.stringify(n))
    .join(", ")}${names.length > 5 ? " and others" : ""}`;

/**
 * Starts the apply of a run's saved plans (IAC-8): checks that the merge request is where the plans
 * were made and that GitLab's rules let it go, claims each stack (`planned` -> `applying`, the
 * mutex of the project's stack), and starts one pipeline whose jobs fetch each stack's plan
 * artifact and apply it. `stacks` left out means every stack that is planned. Returns the stacks it
 * started; none (merge path only) when no stack of the run opted in to be applied on merge, or all
 * have started already.
 *
 * A stack whose `stack.yml` names a protected environment (GOV-3) also needs an approved change
 * request that names it at the plan job it has now; it is used up by the claim.
 *
 * The claim and the pipeline are one transaction: GitLab refusing the pipeline leaves every stack
 * `planned`, and an approval unused. Everything it refuses is a 409 or 422 `DomainError` whose
 * message is fixed words and the names of stacks (never GitLab's text).
 *
 * shortcut: a failed commit after GitLab started the pipeline leaves it running with no stack
 * claimed (terraform's stale-plan check refuses a second apply of one plan); upgrade by recording
 * the pipeline before starting it.
 */
export async function applyRun(
  deps: ApplyDeps,
  gitlab: PlanClient,
  req: ApplyRequest,
): Promise<string[]> {
  const { at, run } = req;
  // On GitHub the apply is a dispatch of a fixed workflow behind the environment's reviewers, from a stored plan (FRG-32)
  const github = isGithub(gitlab) ? gitlab : undefined;
  const forge = github ? "GitHub" : "GitLab";
  const noun = github ? "pull request" : "merge request";
  const now = (deps.now ?? (() => new Date()))();
  const byName = new Map(run.stacks.map((s) => [s.stack, s]));
  const unknown = (req.stacks ?? []).filter((n) => !byName.has(n));
  if (unknown.length > 0) {
    throw refuse("unknown_stack", `This run has no stack named ${quoted(unknown)}`, 422);
  }
  if (run.kind === "drift") {
    throw refuse("drift_run", "A drift check only plans: it is never applied");
  }
  const iid = run.mergeRequestIid;
  if (iid === null) {
    throw refuse(
      "no_merge_request",
      "This run has no merge request: only a merge request's plans are applied",
    );
  }

  const read = () => scanStacks(gitlabSource(gitlab, at.gitlabProjectId, run.sha));
  // sorted, so that two requests claim the stacks in the same order and never wait for each other
  const choose = (scanned: Awaited<ReturnType<typeof read>>) =>
    [
      ...new Set(
        req.when === "merge"
          ? run.stacks
              .filter(
                (s) =>
                  scanned.stacks.find((x) => x.name === s.stack)?.applyOn === "merge" &&
                  NOT_STARTED.has(s.status),
              )
              .map((s) => s.stack)
          : (req.stacks ?? run.stacks.filter((s) => s.status === "planned").map((s) => s.stack)),
      ),
    ].sort();
  // A merge that no stack opted in to has nothing to refuse or tell (so this is asked before the
  // merge request is): the command path asks the merge request first, as its plans may be unreadable.
  let scan: Awaited<ReturnType<typeof read>> | undefined;
  let selected: string[] | undefined;
  if (req.when === "merge") {
    scan = await read();
    selected = choose(scan);
    if (selected.length === 0) return [];
  }

  const mr = await gitlab.mergeRequests.get(at.gitlabProjectId, iid);
  // checked first: whatever else is true, the plans are not of this code
  if (mr.sha !== run.sha) {
    throw refuse("stale_plan", `The ${noun} has changed since this run planned it; plan it again`);
  }
  let ref: string;
  if (mr.state === "merged") {
    // a merge into another branch is not what the project deploys from
    const { defaultBranch } = await gitlab.projects.get(at.gitlabProjectId);
    if (defaultBranch === null || mr.targetBranch !== defaultBranch) {
      throw refuse(
        "not_default_branch",
        `The ${noun} was not merged into the project's default branch`,
      );
    }
    ref = mr.targetBranch;
  } else if (mr.state === "opened") {
    if (req.when === "merge") throw refuse("not_merged", `The ${noun} is not merged`);
    if (!(await gitlab.mergeRequests.approvals(at.gitlabProjectId, iid)).approved) {
      throw refuse("not_approved", `The ${noun} is not approved`);
    }
    if (mr.mergeStatus !== "mergeable") {
      throw refuse("not_mergeable", `${forge} does not say the ${noun} can be merged`);
    }
    ref = run.ref;
  } else {
    throw refuse("not_open", `The ${noun} is closed`);
  }

  scan ??= await read();
  const scanned = new Map(scan.stacks.map((s) => [s.name, s]));
  selected ??= choose(scan);
  if (selected.length === 0) throw refuse("not_planned", "No stack of this run is planned");

  // Secret findings (SCAN-6): the organization's gate, read now, judges the project's open default-branch findings.
  const secrets = await secretGateOf(deps.db, at);
  if (secrets.denied.length > 0) {
    throw refuse(
      "secret_findings_open",
      `${secrets.open} secret ${secrets.open === 1 ? "finding is" : "findings are"} open on the default branch (${quoted(secrets.denied)}); revoke ${secrets.open === 1 ? "it" : "them"} at the source and dismiss ${secrets.open === 1 ? "it" : "them"}`,
    );
  }

  // Protected environments (GOV-3): the stacks that declare one need leave for their current plan.
  // shortcut: a stack that declares no environment is not guarded, and a merge request can remove the declaration; GitLab's own merge approvals are the other check
  const protectedSlugs = new Set(
    await protectedEnvironments(
      deps.db,
      at.organizationId,
      at.projectId,
      selected.flatMap((name) => scanned.get(name)?.environment ?? []),
    ),
  );
  const guardedPlans: Record<string, number> = {};

  // Policy (POL-3): the sets the stacks are judged by now, to tell a stack that is not judged from
  // one whose verdict has not come (or was dropped with its plan job): that one waits.
  const sets = await listPolicySets(deps.db, at.organizationId, { limit: MAX_POLICY_SETS });
  // Cost limits (COST-3): the ones in force now, so a lowered limit holds a plan that was inside the old one.
  const limits = await allCostLimits(deps.db, at.organizationId);
  const planJobs: Record<string, number> = {};
  for (const name of selected) {
    const s = byName.get(name);
    if (!s) continue;
    if (s.status !== "planned") {
      throw refuse(
        "not_planned",
        NOT_STARTED.has(s.status)
          ? `Stack ${quoted([name])} has not finished planning`
          : `Stack ${quoted([name])} is ${s.status}, not planned`,
      );
    }
    if (s.planJobId === null) {
      throw refuse("no_plan", `No plan job is recorded for stack ${quoted([name])}`);
    }
    // the plan's artifact lives a week from when its job ended; the stack became planned just after
    if (s.updatedAt.getTime() + PLAN_RETENTION_MS <= now.getTime()) {
      throw refuse(
        "plan_expired",
        `The plan of stack ${quoted([name])} is too old to apply; plan it again`,
      );
    }
    if (s.policyVerdict === "deny") {
      throw refuse(
        "policy_denied",
        `The policy denies the plan of stack ${quoted([name])}: ${quoted(ruleNames(s.policyDenied))}`,
      );
    }
    if (s.policyVerdict === null && setsFor(scanned.get(name)?.tags ?? [], sets).length > 0) {
      throw refuse(
        "policy_pending",
        `The policy has not judged the plan of stack ${quoted([name])}; plan it again`,
      );
    }
    // A zone is judged by the claims as they stand now (DNS-7): one released since its plan was judged stops
    // that plan, and a zone whose summary never came was never judged at all.
    if (s.dnsPrune !== null || scanned.get(name)?.tool === "dnscontrol") {
      if (s.policyVerdict === null) {
        throw refuse(
          "policy_pending",
          `The policy has not judged the plan of stack ${quoted([name])}; plan it again`,
        );
      }
      const zones = zonesOf(
        await getPlanResources(deps.db, at.organizationId, at.projectId, run.id, name),
      ).filter((z) => ZONE.test(z));
      const claimed = await claimedZones(
        deps.db,
        { organizationId: at.organizationId, projectId: at.projectId, stack: name },
        zones,
      );
      const loose = zones.filter((z) => !claimed.has(z));
      if (loose.length > 0) {
        throw refuse(
          "policy_denied",
          `The policy denies the plan of stack ${quoted([name])}: ${quoted(loose.slice(0, 5).map((z) => `${DNS_RULES.unclaimed}:${z}`))}`,
        );
      }
    }
    // No limit: the estimate is information. A limit and no estimate denies (the estimator never ran or crashed).
    // shortcut: the stack's tags are the repository's, so a branch can drop a tag to fall back to the organization's own limit (or none); see docs/cost-gates.md
    const cost = costVerdict(limitOf(limits, scanned.get(name)), planCostOf(s));
    if (cost.denied.length > 0) {
      throw refuse(
        "cost_denied",
        `The cost limit denies the plan of stack ${quoted([name])}: ${quoted(cost.denied)}`,
      );
    }
    for (const dep of scanned.get(name)?.dependsOn ?? []) {
      const d = byName.get(dep);
      if (d && d.status !== "applied" && !selected.includes(dep)) {
        throw refuse(
          "dependency_not_applied",
          `Stack ${quoted([name])} depends on ${quoted([dep])}, which is not applied`,
        );
      }
    }
    planJobs[name] = s.planJobId;
    const environment = scanned.get(name)?.environment;
    if (environment !== undefined && protectedSlugs.has(environment)) {
      guardedPlans[name] = s.planJobId;
    }
  }

  // as the pools are now: a pool changed since the plan moves the apply with it (docs/worker-pools.md)
  const pools = await allPools(deps.db, at.organizationId);
  let yaml = "";
  let input: Parameters<typeof startForgeRun>[1]["input"] | undefined;
  try {
    if (github) {
      if (!deps.config) {
        throw refuse(
          "not_set_up",
          "Pull requests are not applied on this installation: it is not set up for it",
          422,
        );
      }
      // what the platform judged of each stack's plan, which the apply compares its own plan with (FRG-29)
      const judged: Record<string, Judged> = {};
      for (const name of selected) {
        const s = byName.get(name);
        // a stack with no summary has no entry, and the run plan refuses it by name
        if (s?.planAdd == null || s.planChange == null || s.planDestroy == null) continue;
        judged[name] = {
          add: s.planAdd,
          change: s.planChange,
          destroy: s.planDestroy,
          resources: (
            await getPlanResources(deps.db, at.organizationId, at.projectId, run.id, name)
          ).map((r) => ({ address: r.address, actions: [...r.actions] })),
        };
      }
      input = {
        ...planRequest(deps.config, at, scan.stacks, selected, run.id, [], [], pools),
        action: "apply",
        sha: run.sha,
        judged,
      };
    } else {
      yaml = generatePipeline({
        action: "apply",
        stacks: scan.stacks,
        select: selected,
        planJobs,
        pools,
        ...(deps.images ? { images: deps.images } : {}),
        ...(deps.platform ? { platform: deps.platform } : {}),
      });
    }
  } catch (error) {
    if (!(error instanceof GenerateError)) throw error;
    throw refuse(
      "cannot_generate",
      `The pipeline could not be generated: ${error.problems.slice(0, 3).join("; ")}`,
      422,
    );
  }

  const pipelineId = await deps.db.transaction(async (tx) => {
    const guarded = Object.keys(guardedPlans);
    const approval =
      guarded.length === 0
        ? undefined
        : await consumeApproval(
            tx,
            { organizationId: at.organizationId, projectId: at.projectId },
            { kind: "iac_apply", runId: run.id, stacks: guardedPlans },
          );
    if (guarded.length > 0 && !approval) {
      throw approvalRequired(`Stack ${quoted(guarded)}`, [...protectedSlugs]);
    }
    for (const name of selected) {
      let moved: Awaited<ReturnType<typeof moveRunStack>>;
      try {
        moved = await moveRunStack(
          tx,
          at.organizationId,
          at.projectId,
          run.id,
          name,
          "planned",
          "applying",
        );
      } catch (error) {
        if (pgConstraint(error) === "run_stacks_one_applying") {
          throw refuse("apply_in_progress", `Another run is applying stack ${quoted([name])}`);
        }
        throw error;
      }
      // another request moved it first
      if (!moved) {
        throw refuse(
          "not_planned",
          `Stack ${quoted([name])} is no longer planned; its apply may have started`,
        );
      }
    }
    // On GitHub the gate and the stored plan are part of the start; a refusal rolls the claim back with them
    const starting =
      github && input
        ? startForgeRun(
            { db: tx, forge: github },
            {
              organizationId: at.organizationId,
              projectId: at.projectId,
              project: at.gitlabProjectId,
              runId: run.id,
              ref,
              input,
            },
          )
        : gitlab.pipelines.trigger(at.gitlabProjectId, ref, [
            { key: CHILD_PIPELINE, value: yaml, type: "file" },
          ]);
    const pipeline = await starting.catch((error) => {
      if (
        error instanceof GitlabError &&
        (error.kind === "invalid" ||
          error.kind === "forbidden" ||
          (github !== undefined && error.kind === "not_found"))
      ) {
        throw refuse(
          github ? "github_refused" : "gitlab_refused",
          `${forge} would not start the apply ${github ? "workflow" : "pipeline"}`,
          422,
        );
      }
      throw error;
    });
    // A push that landed since the read above: the pipeline would run the code of the new commit
    // beside the old plans. (A merged request runs on the target branch, which moves on its own.)
    if (mr.state === "opened" && pipeline.sha !== run.sha) {
      await gitlab.pipelines.cancel(at.gitlabProjectId, pipeline.id).catch((error) => {
        deps.log.warn("could not stop an apply pipeline of a stale plan", {
          pipeline: pipeline.id,
          error: describeError(error),
        });
      });
      throw refuse("stale_plan", `The ${noun} changed while the pipeline started; plan it again`);
    }
    await attachRunPipeline(tx, {
      organizationId: at.organizationId,
      projectId: at.projectId,
      runId: run.id,
      gitlabPipelineId: pipeline.id,
      action: "apply",
    });
    await req.audit(tx, {
      action: "run.apply",
      resourceType: "run",
      resourceId: run.id,
      organizationId: at.organizationId,
      projectId: at.projectId,
      metadata: {
        ref,
        sha: run.sha,
        mergeRequestIid: iid,
        when: req.when,
        pipelineId: pipeline.id,
        // what a merged request's pipeline ran: the target branch, which moves on its own
        pipelineSha: pipeline.sha,
        ...(approval && { changeRequestId: approval.id }),
        ...auditedStacks(selected),
      },
    });
    return pipeline.id;
  });
  deps.log.info("apply started", { run: run.id, pipeline: pipelineId, stacks: selected.length });

  // The apply has started whatever happens to the note.
  try {
    await refreshNote({ db: deps.db }, at, iid, gitlab, run.id);
  } catch (error) {
    deps.log.warn("could not update the merge request note", { error: describeError(error) });
  }
  return selected;
}

/**
 * The `gitlab.event` consumer that applies on merge (IAC-8): when GitLab reports a merge request
 * merged, applies the stacks of its newest run that opted in with `apply_on: merge`. Needs no
 * person: the repository's opt-in and GitLab's own rules for merging are the authority, and the
 * audit event is the job's. What it refuses it says in the merge request's note (a merge request
 * that no run covers, or a project not seen to hold Terraform, is ignored); a merge request GitLab
 * no longer has, or a token it refuses, drops the job, and any other failure fails it for a retry.
 * A repeated event finds the stacks applying and does nothing.
 */
export const mrApplyHandler =
  (
    deps: RunDeps & {
      images?: Partial<Record<Tool, string>> | undefined;
      platform?: Platform | undefined;
    },
  ): JobHandler =>
  async (ctx) => {
    const parsed = mrEvent.safeParse(ctx.payload);
    if (!parsed.success || parsed.data.action !== "merge") return;
    const e = parsed.data;
    const project = await plannedProject(deps.db, e.organizationId, e.projectId);
    if (!project) return;
    const at = {
      organizationId: e.organizationId,
      projectId: project.id,
      gitlabProjectId: e.projectId,
    };
    const run = await latestRunOfMergeRequest(deps.db, at.organizationId, at.projectId, e.iid);
    if (!run) return;
    try {
      const gitlab = await deps.gitlab(e.organizationId, e.connectionId);
      try {
        await applyRun(
          { db: deps.db, log: ctx.log, images: deps.images, platform: deps.platform },
          gitlab,
          {
            at,
            run,
            when: "merge",
            audit: (tx, event) => audit(tx, { actor: { kind: "job", id: ctx.id } }, event),
          },
        );
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        ctx.log.warn("not applied on merge", { code: error.code });
        const notice = `Not applied on merge: ${inline(error.message)}`;
        await withMergeRequest(deps.db, at.organizationId, at.projectId, e.iid, async (tx, row) => {
          await saveMergeRequestNote(tx, row, { notice });
          await writeNote(tx, { ...row, notice }, gitlab, at.gitlabProjectId);
        });
      }
    } catch (error) {
      const why = hopeless(error, "the merge request or its repository");
      if (!why) throw error;
      ctx.log.warn("merge event dropped", { reason: why, connection: e.connectionId });
    }
  };
