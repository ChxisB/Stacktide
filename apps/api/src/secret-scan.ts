import { type Logger, MAX_REPORT_BYTES, parseSecretReport } from "@orch/core";
import { resolveMissing, upsertFindings } from "@orch/db";
import type { Gitlab } from "@orch/gitlab";
import type { RunAt, RunDeps } from "./pipeline-runs";

/** GitLab's secret-detection template names its job and its report so. */
export const SECRET_DETECTION_JOB = "secret_detection";
export const SECRET_REPORT_FILE = "gl-secret-detection-report.json";

/** What `secret_findings.ref` holds; a longer ref is a pipeline the table would refuse. */
const MAX_REF = 255;

/**
 * After a finished pipeline: reads the report of its secret-detection job and records the findings
 * (SCAN-3). Only the report's place and rule are kept (`parseSecretReport`'s allowlist) and only
 * counts and reasons are logged, never anything from the report. A report that is not there, is too
 * large, or is not a report is dropped (a retry would read the same). A GitLab failure throws: the
 * handler drops what no retry could serve (as PIPE-8 does) and the queue retries the rest.
 * Findings missing from the report are resolved only after a complete scan with every entry read,
 * and only for the default branch (`resolveMissing`).
 *
 * shortcut: one more jobs listing for every finished pipeline of a linked project, and reports of
 * two pipelines of one branch handled out of order can show the older one until the next scan; upgrade
 * if either matters.
 */
export async function ingestSecretFindings(
  deps: RunDeps,
  at: RunAt,
  gitlab: Gitlab,
  pipeline: { id: number; ref: string },
  log: Logger,
) {
  if (pipeline.ref.length === 0 || pipeline.ref.length > MAX_REF) return;
  let scanJob: number | undefined;
  for await (const j of gitlab.pipelines.jobs(at.gitlabProjectId, pipeline.id)) {
    if (j.name === SECRET_DETECTION_JOB && (j.status === "success" || j.status === "failed")) {
      scanJob = j.id;
      break;
    }
  }
  if (scanJob === undefined) return;
  const artifact = await gitlab.pipelines.artifact(
    at.gitlabProjectId,
    scanJob,
    SECRET_REPORT_FILE,
    MAX_REPORT_BYTES,
  );
  if (artifact.status === "missing") return log.debug("secret report not found");
  if (artifact.status === "too_large") return log.warn("secret report too large, not read");
  const report = parseSecretReport(artifact.text);
  if (!report.ok) return log.warn("secret report dropped", { reason: report.reason });

  const scope = { organizationId: at.organizationId, projectId: at.projectId };
  await upsertFindings(deps.db, { ...scope, ref: pipeline.ref, findings: report.findings });
  // an entry that could not be read may be a finding already known: absence proves nothing then
  const resolved =
    report.complete && report.skipped === 0
      ? await resolveMissing(deps.db, {
          ...scope,
          ref: pipeline.ref,
          seen: report.findings.map((f) => f.fingerprint),
        })
      : 0;
  log.debug("secret findings recorded", {
    findings: report.findings.length,
    skipped: report.skipped,
    complete: report.complete,
    resolved,
  });
}
