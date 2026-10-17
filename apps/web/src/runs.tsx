import type { Client } from "@orch/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { webUrl } from "./pipeline-parts";
import { ProjectPicker } from "./projects";
import { href } from "./router";
import { Loading, stamp, when } from "./ui";

/** How often the runs are looked at again while one of them is still going. */
export const POLL_MS = 5_000;
/** The most branches the API answers with; a project with more shows its most recent. */
const MAX_BRANCHES = 50;

export interface Run {
  id: string;
  iid: number;
  status: string;
  ref: string;
  sha: string;
  webUrl: string;
  failureReason: string | null;
  failedJob: string | null;
  observedAt: string | Date;
}

type Tone = "ok" | "bad" | "active" | "quiet";
/** GitLab's pipeline statuses in words, and what kind of news each is. */
const STATUS: Record<string, [label: string, tone: Tone]> = {
  success: ["Passed", "ok"],
  failed: ["Failed", "bad"],
  running: ["Running", "active"],
  pending: ["Pending", "active"],
  created: ["Created", "active"],
  preparing: ["Preparing", "active"],
  waiting_for_resource: ["Waiting for a resource", "active"],
  scheduled: ["Scheduled", "active"],
  canceling: ["Canceling", "active"],
  canceled: ["Canceled", "quiet"],
  skipped: ["Skipped", "quiet"],
  manual: ["Waiting for a manual step", "quiet"],
};
// a status this version does not know is shown in its own words, as a quiet one
const statusOf = (status: string): [string, Tone] =>
  STATUS[status] ?? [status.replaceAll("_", " "), "quiet"];
const going = (r: Run) => statusOf(r.status)[1] === "active";
/** The runs GitLab can run again: the API refuses any other. */
const retryable = (r: Run) => r.status === "failed" || r.status === "canceled";

const at = (client: Client, orgId: string, projectId: string) =>
  client.organizations({ orgId }).projects({ projectId })["pipeline-runs"];

const message = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");

function Why({ run }: { run: Run }) {
  if (run.status !== "failed") return null;
  // GitLab's failure reasons are codes such as `script_failure`
  const code = run.failureReason?.replaceAll("_", " ");
  const reason = code && code.charAt(0).toUpperCase() + code.slice(1);
  if (!reason && !run.failedJob) return <span className="muted">GitLab gave no reason</span>;
  return (
    <>
      {reason ?? "Job"}
      {run.failedJob && (
        <>
          {reason ? " in job " : " "}
          <code>{run.failedJob}</code>
        </>
      )}
    </>
  );
}

function Runs({ orgId, projectId, pollMs }: { orgId: string; projectId: string; pollMs: number }) {
  const client = useClient();
  const queries = useQueryClient();
  const key = ["pipeline-runs", orgId, projectId];
  const latest = useQuery({
    queryKey: key,
    queryFn: async (): Promise<Run[]> =>
      (
        await call(() =>
          at(client, orgId, projectId).latest.get({ query: { limit: MAX_BRANCHES } }),
        )
      ).runs,
    refetchInterval: (q) => (q.state.data?.some(going) ? pollMs : false),
  });
  const [retrying, setRetrying] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  const retry = async (run: Run) => {
    setRetrying(run.id);
    setError(undefined);
    setDone(undefined);
    try {
      const now = await call(() => at(client, orgId, projectId)({ runId: run.id }).retry.post());
      await queries.invalidateQueries({ queryKey: key });
      setDone(
        `Retried the pipeline on ${run.ref}. GitLab says it is now ${statusOf(now.status)[0].toLowerCase()}.`,
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setRetrying(undefined);
    }
  };

  const runs = latest.data;
  if (!runs) {
    return latest.error ? (
      <ErrorPanel error={latest.error} retry={() => void latest.refetch()} />
    ) : (
      <Loading what="Loading pipelines" />
    );
  }
  if (runs.length === 0) {
    return (
      <p>
        No pipeline has run for this project yet. Runs appear here once GitLab reports one. To set a
        pipeline up, use the <a href={href("pipeline")}>Pipeline page</a>.
      </p>
    );
  }
  return (
    <div className="stack">
      <p className="muted">The newest pipeline of each branch.</p>
      {/* a failed look again keeps the runs that were loaded */}
      {latest.error && (
        <p role="alert" className="error">
          Could not look again: {message(latest.error)}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {done && <p role="status">{done}</p>}
      <table>
        <caption className="visually-hidden">Latest pipeline of each branch</caption>
        <thead>
          <tr>
            <th scope="col">Branch</th>
            <th scope="col">Status</th>
            <th scope="col">Commit</th>
            <th scope="col">Why it failed</th>
            <th scope="col">Last checked</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const [label, tone] = statusOf(r.status);
            const link = webUrl(r.webUrl);
            return (
              <tr key={r.id}>
                <th scope="row">
                  <code>{r.ref}</code>
                </th>
                <td>
                  <span className={`tag status-${tone}`}>{label}</span>
                </td>
                <td>
                  <code>{r.sha.slice(0, 8)}</code>
                </td>
                <td>
                  <Why run={r} />
                </td>
                <td>
                  <time dateTime={stamp(r.observedAt)}>{when(r.observedAt)}</time>
                </td>
                <td>
                  <div className="row">
                    {link && (
                      <a href={link} target="_blank" rel="noreferrer">
                        Open pipeline #{r.iid}
                      </a>
                    )}
                    {retryable(r) && (
                      <button
                        type="button"
                        disabled={retrying !== undefined}
                        onClick={() => void retry(r)}
                      >
                        {retrying === r.id ? "Retrying…" : `Retry ${r.ref}`}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {runs.length >= MAX_BRANCHES && (
        <p className="muted">
          At most {MAX_BRANCHES} branches are shown, the ones with the newest pipelines.
        </p>
      )}
    </div>
  );
}

/** What a project's pipelines are doing: the newest one of each branch, why a failed one failed, and a retry. */
export function RunsPage({ orgId, pollMs = POLL_MS }: { orgId: string; pollMs?: number }) {
  return (
    <ProjectPicker orgId={orgId}>
      {(project) => <Runs key={project.id} orgId={orgId} projectId={project.id} pollMs={pollMs} />}
    </ProjectPicker>
  );
}
