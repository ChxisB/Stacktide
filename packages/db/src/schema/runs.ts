import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";
import { projects } from "./projects";

/**
 * One run of IaC stacks on a commit (IAC-5): which stacks, for which ref and commit, and, when a
 * merge request caused it, which one. What each stack is doing is in `run_stacks`; the run has no
 * state of its own. Nothing here is a secret. `sha` is the commit the plans are made from, so an
 * apply can tell that the branch has moved on.
 */
export const runs = pgTable(
  "runs",
  {
    id: id(),
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    ref: text().notNull(),
    sha: text().notNull(),
    mergeRequestIid: integer(),
    // `plan`: a merge request's plans, which an apply may follow. `drift`: a scheduled plan of the
    // default branch to see whether the infrastructure still matches (POL-1); it is never applied.
    kind: text().notNull().default("plan"),
    ...timestamps(),
  },
  (t) => [
    // for the stacks' composite key: a stack's row cannot name another project than its run's
    unique("runs_scope_key").on(t.id, t.organizationId, t.projectId),
    // newest first: ids are time-ordered
    index("runs_project_idx").on(t.projectId, t.id),
    // CASCADE: a project's runs are its history and go with it.
    foreignKey({
      name: "runs_project_org_fk",
      columns: [t.projectId, t.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete("cascade"),
    check("runs_ref_check", sql`length(${t.ref}) between 1 and 255`),
    // a git object id: SHA-1, or SHA-256 in repositories that use it
    check("runs_sha_check", sql`${t.sha} ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'`),
    check("runs_mr_check", sql`${t.mergeRequestIid} is null or ${t.mergeRequestIid} > 0`),
    check("runs_kind_check", sql`${t.kind} in ('plan', 'drift')`),
    // a drift run belongs to the default branch, not to a merge request
    check("runs_drift_check", sql`${t.kind} <> 'drift' or ${t.mergeRequestIid} is null`),
  ],
);

/**
 * One stack of a run and where it is in the lifecycle of `@orch/core`'s `RUN_STATES`. `stack` is the
 * stack's name when the run was made and is not a foreign key: stacks leave the table when they
 * leave the repository, a run is history. `error` says why a stack failed, in fixed words, never a
 * tool's output (that can hold values).
 */
export const runStacks = pgTable(
  "run_stacks",
  {
    runId: uuid().notNull(),
    // repeated from the run, for the mutex below
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    stack: text().notNull(),
    // The stack's tags in the commit the run was made from: which cost limit (and so what the merge
    // request note and the run show) judges its plan. Names, never values.
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    // False for a stack with no price to estimate (a DNS zone): no cost limit judges its plan.
    costed: boolean().notNull().default(true),
    // A DNS zone's `dns.prune` in the commit the run was made from: whether its plan may delete records it
    // does not list (DNS-7). Null for a stack that is not a zone.
    dnsPrune: boolean(),
    status: text().notNull().default("queued"),
    error: text(),
    // The page of the job a forge holds for a person to approve (GitHub's environment reviewers, FRG-22): set only while
    // the stack is `applying` and the forge says it waits, dropped by every move and when the job goes on. The platform
    // approves nothing; a person follows the link. An http(s) link, checked before it is kept.
    approvalUrl: text(),
    // The GitLab jobs of the stack's plan and of the job that posts its summary, found from the
    // pipeline events: the summary route lets only that job post (IAC-6).
    planJobId: bigint({ mode: "number" }),
    summaryJobId: bigint({ mode: "number" }),
    // What the plan would do: counts, and the `{address, actions}` of at most 500 resources (the
    // route's limit; here only a size); never a value, a plan holds secrets. All set together, by
    // the summary the plan job posts.
    planAdd: integer(),
    planChange: integer(),
    planDestroy: integer(),
    planResources: jsonb(),
    summarizedAt: timestamp({ withTimezone: true }),
    // What the plan would cost per month, as the estimator its job ran said (COST-1): the change the
    // plan makes, the total after it, the currency (never converted) and the tool's name. An estimate,
    // not a bill. All four set together, by the same summary, or none; forgotten with a retried plan job.
    costMonthlyDelta: doublePrecision(),
    costMonthlyTotal: doublePrecision(),
    costCurrency: text(),
    costTool: text(),
    // How many findings the platform's lint of a zone's config made, by severity (DNS-11): both set together, by the
    // same summary, or neither; zero and zero says the lint ran. Counts only: the findings are in the plan job's artifact.
    lintErrors: integer(),
    lintWarnings: integer(),
    // What the policy sets that reach the stack said of its plan (POL-3): `pass`, `warn` or `deny`,
    // with the names of the rules that fired, never what they said (a message may quote the plan).
    // Null: not judged (yet). All set together, by the verdict the plan's summary job posts.
    policyVerdict: text(),
    policyDenied: jsonb(),
    policyWarned: jsonb(),
    policyAt: timestamp({ withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.stack] }),
    foreignKey({
      name: "run_stacks_run_fk",
      columns: [t.runId, t.organizationId, t.projectId],
      foreignColumns: [runs.id, runs.organizationId, runs.projectId],
    }).onDelete("cascade"),
    // The mutex: a stack is applied by one run at a time, whatever the callers do.
    uniqueIndex("run_stacks_one_applying")
      .on(t.projectId, t.stack)
      .where(sql`${t.status} = 'applying'`),
    check("run_stacks_stack_check", sql`${t.stack} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`),
    check(
      "run_stacks_status_check",
      sql`${t.status} in ('queued', 'planning', 'planned', 'applying', 'applied', 'failed', 'discarded', 'canceled')`,
    ),
    check("run_stacks_error_check", sql`length(${t.error}) <= 500`),
    check("run_stacks_approval_url_check", sql`length(${t.approvalUrl}) <= 2000`),
    check(
      "run_stacks_jobs_check",
      sql`coalesce(${t.planJobId}, 1) > 0 and coalesce(${t.summaryJobId}, 1) > 0`,
    ),
    check(
      "run_stacks_policy_check",
      sql`(${t.policyVerdict} is null) = (${t.policyAt} is null)
        and (${t.policyVerdict} is null) = (${t.policyDenied} is null)
        and (${t.policyVerdict} is null) = (${t.policyWarned} is null)
        and (${t.policyVerdict} is null or ${t.policyVerdict} in ('pass', 'warn', 'deny'))
        and coalesce(length(${t.policyDenied}::text), 0) <= 100000
        and coalesce(length(${t.policyWarned}::text), 0) <= 100000`,
    ),
    // NaN and infinity compare above any limit in Postgres, so the bounds refuse them too.
    check(
      "run_stacks_cost_check",
      sql`(${t.costMonthlyDelta} is null) = (${t.costMonthlyTotal} is null)
        and (${t.costMonthlyDelta} is null) = (${t.costCurrency} is null)
        and (${t.costMonthlyDelta} is null) = (${t.costTool} is null)
        and (${t.costMonthlyDelta} is null or (
          ${t.summarizedAt} is not null
          and abs(${t.costMonthlyDelta}) <= 1e12
          and ${t.costMonthlyTotal} between 0 and 1e12
          and ${t.costCurrency} ~ '^[A-Z]{3}$'
          and ${t.costTool} ~ '^[a-z0-9][a-z0-9._-]{0,39}$'))`,
    ),
    check(
      "run_stacks_lint_check",
      sql`(${t.lintErrors} is null) = (${t.lintWarnings} is null)
        and (${t.lintErrors} is null or (
          ${t.summarizedAt} is not null
          and ${t.lintErrors} between 0 and 1000000
          and ${t.lintWarnings} between 0 and 1000000))`,
    ),
    // The size bound is for the text of the stored value, which Bun.sql stores as a JSON string (every quote
    // escaped twice over): 500 addresses of 1024 quote marks come to about 2.3 million characters.
    check(
      "run_stacks_summary_check",
      sql`(${t.planAdd} is null) = (${t.planChange} is null)
        and (${t.planAdd} is null) = (${t.planDestroy} is null)
        and (${t.planAdd} is null) = (${t.planResources} is null)
        and (${t.planAdd} is null) = (${t.summarizedAt} is null)
        and coalesce(least(${t.planAdd}, ${t.planChange}, ${t.planDestroy}), 0) >= 0
        and (${t.planResources} is null or length(${t.planResources}::text) <= 4000000)`,
    ),
  ],
);

/**
 * The GitLab pipelines a run started, by what each does (IAC-6): a pipeline event is matched to its
 * run here, and one for a pipeline not in this table is not a run's. Written once, when the
 * pipeline is triggered (IAC-7, IAC-8), and not changed after that.
 */
export const runPipelines = pgTable(
  "run_pipelines",
  {
    organizationId: uuid().notNull(),
    projectId: uuid().notNull(),
    gitlabPipelineId: bigint({ mode: "number" }).notNull(),
    runId: uuid().notNull(),
    action: text().notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.gitlabPipelineId] }),
    index("run_pipelines_run_idx").on(t.runId),
    foreignKey({
      name: "run_pipelines_run_fk",
      columns: [t.runId, t.organizationId, t.projectId],
      foreignColumns: [runs.id, runs.organizationId, runs.projectId],
    }).onDelete("cascade"),
    check("run_pipelines_action_check", sql`${t.action} in ('plan', 'apply')`),
    check("run_pipelines_pipeline_check", sql`${t.gitlabPipelineId} > 0`),
  ],
);
