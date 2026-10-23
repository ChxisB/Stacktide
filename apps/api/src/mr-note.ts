import { type CostLimit, SECRET_FINDINGS_RULE } from "@orch/core";
import {
  allCostLimits,
  latestRunOfMergeRequest,
  type MergeRequestNote,
  type RunStack,
  ruleNames,
  saveMergeRequestNote,
  type Tx,
  withMergeRequest,
} from "@orch/db";
import { type Gitlab, GitlabError } from "@orch/gitlab";
import { type CostView, costViewOf } from "./cost-view";
import type { RunDeps } from "./pipeline-runs";
import { type SecretGateView, secretGateOf } from "./secret-gate";

export interface NoteView {
  /** The newest run of the merge request, if it has had one: its commit and where each stack is. */
  run?: { sha: string; stacks: readonly RunStack[] } | undefined;
  /** A line about the latest commit that no run shows: why nothing was planned. Already escaped. */
  notice: string | null;
  /** The project's address in GitLab, for links to jobs. */
  projectUrl: string | undefined;
  /** The repository is GitHub's, whose job pages are at another address (FRG-32). */
  github?: boolean | undefined;
  /** The organization's cost limits as they are now; none shows each estimate without a verdict. */
  limits?: readonly CostLimit[] | undefined;
  /** The organization's secret gate and what it counts for the project now; nothing is said unless it warns or denies. */
  secrets?: SecretGateView | undefined;
}

// Text that came from a repository or a tool is shown in a code span, where GitLab makes no link,
// mention or heading of it; a backtick or a line break could end the span, so they are replaced.
export const inline = (text: string, max = 200) =>
  `\`${text.replace(/[\p{Cc}\p{Cf}`]/gu, " ").slice(0, max)}\``;
// Table cells: no character that markdown reads, and no line break.
const plain = (text: string, max: number) =>
  text.replace(/[\p{Cc}\p{Cf}<>[\]()`*_|@\\]/gu, "").slice(0, max);

const SAFE_URL = /^https?:\/\/[^\s()<>[\]`]+$/;
const dash = "–";

// The rules that denied or warned, by name and never by message; a few, then how many more.
const ruleList = (names: readonly string[]) =>
  names.length === 0
    ? ""
    : `(${names
        .slice(0, 3)
        .map((n) => inline(n, 80))
        .join(", ")}${names.length > 3 ? `, and ${names.length - 3} more` : ""})`;

// What the policy said of a stack: its verdict and the names of the rules, never their messages.
const policyLine = (s: RunStack) =>
  [
    plain(s.policyVerdict ?? "", 10),
    ruleList([...ruleNames(s.policyDenied), ...ruleNames(s.policyWarned)]),
  ]
    .filter(Boolean)
    .join(" ");

// What a plan is estimated to cost and what the limit makes of it: figures and rule names, never a resource.
const noun = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The counts of a zone's lint (DNS-11): per severity, or "no findings" when it ran and found none. */
function lintLine(errors: number, warnings: number): string {
  const counts = [
    ...(errors > 0 ? [noun(errors, "error")] : []),
    ...(warnings > 0 ? [noun(warnings, "warning")] : []),
  ];
  return counts.length > 0 ? counts.join(", ") : "no findings";
}

function costLine(stack: string, { estimate: e, limit, verdict, rules }: CostView): string {
  // cents, unless that would round away what a comparison turned on (100.004 is over a limit of 100)
  const money = (n: number, currency: string) =>
    `${Number(n.toFixed(2)) === n ? n.toFixed(2) : String(n)} ${plain(currency, 3)}`;
  const figures = e
    ? `${e.monthlyDelta < 0 ? "-" : "+"}${money(Math.abs(e.monthlyDelta), e.currency)} a month, total ${money(e.monthlyTotal, e.currency)} (estimate by ${inline(e.tool, 30)})`
    : "no estimate";
  const judged = limit
    ? `limit ${money(limit.maxMonthlyDelta, limit.currency)}: ${verdict}${rules.length > 0 ? ` ${ruleList(rules)}` : ""}`
    : "no limit";
  return `- \`${plain(stack, 63)}\`: ${figures}; ${judged}`;
}

/**
 * The note on a merge request: one table, a row per stack of the newest run, with its state, the
 * counts of its plan and a link to its plan job, then what the policy and the cost limits made of
 * it. Counts only: no address of a resource and no plan (a plan holds secrets); whoever may see the
 * plan opens the job.
 */
export function renderNote({
  run,
  notice,
  projectUrl,
  github,
  limits = [],
  secrets,
}: NoteView): string {
  const base = projectUrl?.replace(/\/+$/, "");
  const out = ["**orch plan**"];
  if (run) {
    out.push(
      "",
      `Commit \`${plain(run.sha, 64)}\``,
      "",
      "| Stack | Status | Add | Change | Destroy | Plan |",
      "| --- | --- | ---: | ---: | ---: | --- |",
    );
    for (const s of run.stacks) {
      const counts =
        s.planAdd === null ? [dash, dash, dash] : [s.planAdd, s.planChange, s.planDestroy];
      const link =
        s.planJobId !== null && base !== undefined && SAFE_URL.test(base)
          ? // shortcut: GitHub sends /runs/<job id> on to the job's page (not confirmed against GitHub); upgrade by
            // keeping the workflow run's id with the job
            `[job](${base}${github ? "/runs/" : "/-/jobs/"}${s.planJobId})`
          : dash;
      const status = `${plain(s.status, 20)}${s.error === null ? "" : ` (${plain(s.error, 100)})`}`;
      out.push(`| \`${plain(s.stack, 63)}\` | ${status} | ${counts.join(" | ")} | ${link} |`);
    }
  }
  // an apply GitHub holds for the environment's reviewers: a person approves it there, the platform never does
  const held =
    run?.stacks.filter((s) => s.approvalUrl !== null && SAFE_URL.test(s.approvalUrl)) ?? [];
  if (held.length > 0) {
    out.push("", "Approval:", "");
    for (const s of held) {
      out.push(
        `- \`${plain(s.stack, 63)}\`: waiting for approval in GitHub ([open the job](${s.approvalUrl}))`,
      );
    }
  }
  const judged = run?.stacks.filter((s) => s.policyVerdict !== null) ?? [];
  if (judged.length > 0) {
    out.push("", "Policy:", "");
    for (const s of judged) out.push(`- \`${plain(s.stack, 63)}\`: ${policyLine(s)}`);
  }
  // only a zone has a lint: the counts of any other stack's row are not the platform's to show
  const linted =
    run?.stacks.filter(
      (s) => s.dnsPrune !== null && s.lintErrors !== null && s.lintWarnings !== null,
    ) ?? [];
  if (linted.length > 0) {
    out.push("", "DNS lint:", "");
    for (const s of linted)
      out.push(`- \`${plain(s.stack, 63)}\`: ${lintLine(s.lintErrors ?? 0, s.lintWarnings ?? 0)}`);
  }
  const costs = run?.stacks.flatMap((s) => {
    const view = costViewOf(s, limits);
    return view ? [costLine(s.stack, view)] : [];
  });
  if (costs && costs.length > 0) out.push("", "Cost (estimate):", "", ...costs);
  if (secrets && secrets.open > 0 && secrets.gate !== "off") {
    out.push(
      "",
      `Secrets: ${secrets.open} open ${secrets.open === 1 ? "finding" : "findings"} on the default branch (\`${SECRET_FINDINGS_RULE}\`, ${secrets.gate}). ${
        secrets.gate === "deny"
          ? "Applies are held until they are revoked at the source and dismissed."
          : "Revoke them at the source."
      }`,
    );
  }
  if (notice) out.push("", notice);
  out.push(
    "",
    "<sub>Counts only: the plan itself stays in the job. This note is updated, not added to.</sub>",
  );
  return out.join("\n");
}

/** What the note needs of a forge: a GitLab client and a `Forge` both fit. */
export type NoteForge = Pick<Gitlab, "projects" | "mergeRequests">;

/** Updates the note, or makes it when there is none or someone deleted it; returns its id. */
export async function upsertNote(
  gitlab: NoteForge,
  project: number,
  iid: number,
  noteId: number | null,
  body: string,
): Promise<number> {
  if (noteId !== null) {
    try {
      await gitlab.mergeRequests.updateNote(project, iid, noteId, body);
      return noteId;
    } catch (error) {
      if (!(error instanceof GitlabError && error.kind === "not_found")) throw error;
    }
  }
  return (await gitlab.mergeRequests.createNote(project, iid, body)).id;
}

/**
 * Writes the merge request's note from the database as it is now. Call it holding the merge
 * request's row (`withMergeRequest`). With `only`, writes nothing unless that run is the newest
 * (an event of a run a newer commit replaced has nothing to add), and nothing when there is
 * neither a run nor a notice to show.
 */
export async function writeNote(
  tx: Tx,
  row: MergeRequestNote,
  gitlab: NoteForge,
  gitlabProjectId: number,
  only?: string,
): Promise<void> {
  const run = await latestRunOfMergeRequest(
    tx,
    row.organizationId,
    row.projectId,
    row.mergeRequestIid,
  );
  if (only !== undefined && run?.id !== only) return;
  if (!run && !row.notice) return;
  const { webUrl } = await gitlab.projects.get(gitlabProjectId);
  const limits = await allCostLimits(tx, row.organizationId);
  const secrets = await secretGateOf(tx, row);
  const github = "kind" in gitlab && gitlab.kind === "github";
  const body = renderNote({ run, notice: row.notice, projectUrl: webUrl, github, limits, secrets });
  const noteId = await upsertNote(gitlab, gitlabProjectId, row.mergeRequestIid, row.noteId, body);
  if (noteId !== row.noteId) await saveMergeRequestNote(tx, row, { noteId });
}

/** `writeNote` for a caller that does not hold the row yet. */
export const refreshNote = (
  deps: Pick<RunDeps, "db">,
  at: { organizationId: string; projectId: string; gitlabProjectId: number },
  iid: number,
  gitlab: NoteForge,
  only?: string,
) =>
  withMergeRequest(deps.db, at.organizationId, at.projectId, iid, (tx, row) =>
    writeNote(tx, row, gitlab, at.gitlabProjectId, only),
  );
