import type { Client } from "@orch/api-client";
import type { RunState } from "@orch/core";
import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Card, Chips, Named, StatusBadge } from "./components";
import { Deployments } from "./deployments";
import { type FlowJob, type FlowLane, JobFlow } from "./job-flow";
import { webUrl } from "./pipeline-parts";
import { lacks, ProjectPicker, useProjects } from "./projects";
import { href } from "./router";
import { RunGraph } from "./run-graph";
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
const toneOf = (r: Run) => statusOf(r.status)[1];
const going = (r: Run) => toneOf(r) === "active";
/** The filter chips: all, or one kind of news. */
const FILTERS = [
  { key: "all", label: "All" },
  { key: "bad", label: "Failed" },
  { key: "active", label: "Running" },
  { key: "ok", label: "Passed" },
  { key: "quiet", label: "Other" },
];
/** The runs GitLab can run again: the API refuses any other. */
const retryable = (r: Run) => r.status === "failed" || r.status === "canceled";

const at = (client: Client, orgId: string, projectId: string) =>
  client.organizations({ orgId }).projects({ projectId })["pipeline-runs"];

const message = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");

/** GitLab's failure reasons are codes such as `script_failure`; this reads one as words. */
const reasonIn = (code: string | null) => {
  const words = code?.replaceAll("_", " ");
  return words && words.charAt(0).toUpperCase() + words.slice(1);
};

function Why({ run }: { run: Run }) {
  if (run.status !== "failed") return null;
  const reason = reasonIn(run.failureReason);
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

const jobsOf = (client: Client, orgId: string, projectId: string, runId: string) =>
  call(() => at(client, orgId, projectId)({ runId }).jobs.get());
type JobList = Awaited<ReturnType<typeof jobsOf>>;

/** Seconds as a person says them: `5s`, `1m 12s`, `1h 2m`. */
const took = (seconds: number) => {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** A job as the drawing shows it: its state, time and reason in words. */
const flowJob = (j: JobList["jobs"][number]): FlowJob => {
  // a job allowed to fail did not fail the pipeline: not news of the same kind
  const [label, tone] =
    j.status === "failed" && j.allowFailure
      ? (["Failed, allowed", "quiet"] as const)
      : statusOf(j.status);
  return {
    id: j.id,
    name: j.name,
    stage: j.stage,
    status: j.status,
    label,
    tone,
    took: j.duration === null ? null : took(j.duration),
    reason: reasonIn(j.failureReason) || null,
    url: j.webUrl,
  };
};

type Trigger = JobList["triggers"][number];

/** What a trigger started, in words, when the drawing cannot show it as a lane; none when it did or started nothing. */
const noteOf = (t: Trigger, shown: ReadonlySet<number>) => {
  const d = t.downstream;
  if (!d) return null;
  if (d.gone) return "Pipeline no longer on GitLab";
  if (!d.sameProject) return `Pipeline in another project: ${statusOf(d.status)[0].toLowerCase()}`;
  return shown.has(d.pipelineId) ? null : "Child pipeline not shown";
};

/** A trigger whose pipeline is still going, which keeps the panel looking again after its own run has ended. */
const startedGoing = (t: Trigger) =>
  t.downstream !== null && statusOf(t.downstream.status)[1] === "active";

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/**
 * The jobs of GitLab's pipeline `pipelineId` in another project of the viewer's (NOD-11), or null when that
 * project has no run of it recorded. GitLab's numbers are only unique within one GitLab, so a run that is
 * from another address than `from` (the viewing run's) is not taken for it.
 */
async function otherJobs(
  client: Client,
  orgId: string,
  projectId: string,
  pipelineId: number,
  from: string,
) {
  const { runs } = await call(() =>
    at(client, orgId, projectId).get({ query: { pipelineId, limit: 1 } }),
  );
  const found = runs[0];
  if (!found || !sameOrigin(found.webUrl, from)) return null;
  return jobsOf(client, orgId, projectId, found.id);
}

/**
 * The jobs of one pipeline (FLW-9), read live from GitLab, only while its row is open (the panel is not
 * mounted otherwise). It looks again while the pipeline is going; the status is in the key so a pipeline
 * that ends is read once more and its jobs show how they ended. No log is shown.
 */
function Jobs({
  orgId,
  projectId,
  run,
  pollMs,
}: {
  orgId: string;
  projectId: string;
  run: Run;
  pollMs: number;
}) {
  const client = useClient();
  const jobs = useQuery({
    queryKey: ["pipeline-jobs", orgId, projectId, run.id, run.status],
    queryFn: () => jobsOf(client, orgId, projectId, run.id),
    placeholderData: keepPreviousData,
    refetchInterval: (q) =>
      going(run) || q.state.data?.triggers?.some(startedGoing) ? pollMs : false,
  });
  const data = jobs.data;
  const projects = useProjects(orgId);
  // a pipeline of another project is read only in a project of the viewer's own list, found by GitLab's number
  // (never by a missing one: a project made by hand has no number either)
  const reach = (data?.triggers ?? []).flatMap((t) => {
    const d = t.downstream;
    const project =
      d &&
      !d.sameProject &&
      d.projectId !== null &&
      projects.data?.find((p) => p.gitlabProjectId === d.projectId);
    return d && project ? [{ t, d, project }] : [];
  });
  const lookups = useQueries({
    queries: reach.map(({ d, project }) => ({
      queryKey: ["pipeline-other", orgId, project.id, d.pipelineId, d.status],
      queryFn: () => otherJobs(client, orgId, project.id, d.pipelineId, run.webUrl),
      placeholderData: keepPreviousData,
      refetchInterval: statusOf(d.status)[1] === "active" ? pollMs : false,
    })),
  });
  if (!data) {
    return jobs.error ? (
      <ErrorPanel error={jobs.error} retry={() => void jobs.refetch()} />
    ) : (
      <Loading what="Loading jobs" />
    );
  }
  // an API from before triggers were drawn sends neither
  const triggers = data.triggers ?? [];
  const children = data.children ?? [];
  const shown = new Set(children.map((c) => c.pipelineId));
  // why what a trigger started in another project is not drawn, in words; none while it is still being read
  const unseen = (t: Trigger) => {
    const d = t.downstream;
    if (!d || d.sameProject || d.gone || !projects.data) return null;
    const slot = reach.findIndex((r) => r.t === t);
    if (slot < 0) return "Not set up here";
    const found = lookups[slot];
    if (found?.error) return "Could not read its jobs";
    return found?.data === null ? "Not recorded yet" : null;
  };
  const triggerJob = (t: Trigger): FlowJob => {
    const [label, tone] = statusOf(t.status);
    return {
      id: t.id,
      name: t.name,
      stage: t.stage,
      status: t.status,
      label,
      tone,
      took: null,
      reason: null,
      url: t.webUrl,
      kind: "trigger",
      note: noteOf(t, shown),
      unseen: unseen(t),
    };
  };
  const lanes: FlowLane[] = [
    ...triggers.flatMap((t) => {
      const c = children.find((x) => x.pipelineId === t.downstream?.pipelineId);
      return c
        ? [
            {
              id: `c${c.pipelineId}`,
              from: t.id,
              title: `Child pipeline #${c.pipelineId}`,
              jobs: c.jobs.map(flowJob),
            },
          ]
        : [];
    }),
    ...reach.flatMap(({ t, d, project }, i) => {
      const other = lookups[i]?.data;
      return other
        ? [
            {
              id: `p${d.pipelineId}`,
              from: t.id,
              title: `${project.name} #${d.pipelineId}`,
              jobs: other.jobs.map(flowJob),
            },
          ]
        : [];
    }),
  ];
  return (
    <div className="jobs-panel">
      {jobs.error && (
        <p role="alert" className="error">
          Could not look again: {message(jobs.error)}
        </p>
      )}
      {data.jobs.length === 0 && triggers.length === 0 && (
        <p className="muted">GitLab lists no jobs for this pipeline.</p>
      )}
      <JobFlow jobs={[...data.jobs.map(flowJob), ...triggers.map(triggerJob)]} lanes={lanes} />
      {data.truncated && (
        <p className="muted">
          Showing {count(data.jobs.length, "job")}. GitLab has more for this pipeline.
        </p>
      )}
      {data.triggersTruncated && (
        <p className="muted">
          Showing {count(triggers.length, "trigger")}. GitLab has more for this pipeline.
        </p>
      )}
      {children
        .filter((c) => c.truncated)
        .map((c) => (
          <p key={c.pipelineId} className="muted">
            Child pipeline #{c.pipelineId}: showing {count(c.jobs.length, "job")}. GitLab has more.
          </p>
        ))}
      {reach.map(({ d, project }, i) =>
        lookups[i]?.data?.truncated ? (
          <p key={d.pipelineId} className="muted">
            {project.name} #{d.pipelineId}: showing{" "}
            {count(lookups[i]?.data?.jobs.length ?? 0, "job")}. GitLab has more.
          </p>
        ) : null,
      )}
    </div>
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
  const [show, setShow] = useState("all");
  // the rows whose jobs are open, by run id
  const [opened, setOpened] = useState<string[]>([]);
  const toggle = (id: string) =>
    setOpened((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

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
  const shown = runs.filter((r) => show === "all" || toneOf(r) === show);
  return (
    <Card title="Latest pipelines" sub="The newest pipeline of each branch.">
      <Chips
        label="Filter by result"
        items={FILTERS.map((f) => ({
          ...f,
          n: f.key === "all" ? runs.length : runs.filter((r) => toneOf(r) === f.key).length,
        }))}
        value={show}
        pick={setShow}
      />
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
      {shown.length === 0 ? (
        <p className="muted">No branch has a pipeline in that state.</p>
      ) : (
        <div className="scroll jobs-host">
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
              {shown.map((r) => {
                const [label, tone] = statusOf(r.status);
                const link = webUrl(r.webUrl);
                const isOpen = opened.includes(r.id);
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <th scope="row">
                        <code>{r.ref}</code>
                      </th>
                      <td>
                        <StatusBadge tone={tone}>{label}</StatusBadge>
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
                        <div className="row actions">
                          {link && (
                            <a href={link} target="_blank" rel="noreferrer">
                              Open pipeline #{r.iid}
                            </a>
                          )}
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-controls={isOpen ? `jobs-${r.id}` : undefined}
                            onClick={() => toggle(r.id)}
                          >
                            <Named word="Jobs" name={r.ref} />
                          </button>
                          {retryable(r) && (
                            <button
                              type="button"
                              disabled={retrying !== undefined}
                              onClick={() => void retry(r)}
                            >
                              {retrying === r.id ? (
                                "Retrying…"
                              ) : (
                                <Named word="Retry" name={r.ref} />
                              )}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} id={`jobs-${r.id}`}>
                          <Jobs orgId={orgId} projectId={projectId} run={r} pollMs={pollMs} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {runs.length >= MAX_BRANCHES && (
        <p className="muted">
          At most {MAX_BRANCHES} branches are shown, the ones with the newest pipelines.
        </p>
      )}
    </Card>
  );
}

/** The most plans the page asks for: the newest. */
const MAX_PLANS = 20;
interface PlanStack {
  name: string;
  status: string;
  /** The stacks of the plan this one waits for, and its column (FLW-1). */
  dependsOn: string[];
  wave: number;
  error: string | null;
  dns: { prune: boolean; lint: { errors: number; warnings: number } | null } | null;
  policy: { verdict: string; denied: string[]; warned: string[] } | null;
}
interface Plan {
  id: string;
  ref: string;
  mergeRequestIid: number | null;
  kind: string;
  createdAt: string | Date;
  stacks: PlanStack[];
}
/** Where a stack of a plan is, in words, and what kind of news that is; a state core adds is a type error here, not a frozen row. */
const PLAN_STATE: Record<RunState, [label: string, tone: Tone]> = {
  queued: ["Queued", "active"],
  planning: ["Planning", "active"],
  planned: ["Planned", "quiet"],
  applying: ["Applying", "active"],
  applied: ["Applied", "ok"],
  failed: ["Failed", "bad"],
  discarded: ["Discarded", "quiet"],
  canceled: ["Canceled", "quiet"],
};
const planStateOf = (status: string): [string, Tone] =>
  PLAN_STATE[status as RunState] ?? [status, "quiet"];
const going_ = (p: Plan) => p.stacks.some((s) => planStateOf(s.status)[1] === "active");
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The names of the rules that fired: what the platform's rules are called, never what a plan said. */
function Rules({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <span>
      {label}:{" "}
      {names.map((n, i) => (
        <span key={n}>
          {i > 0 && ", "}
          <code>{n}</code>
        </span>
      ))}
    </span>
  );
}

function PlanStackItem({ stack }: { stack: PlanStack }) {
  const [label, tone] = planStateOf(stack.status);
  const lint = stack.dns?.lint;
  return (
    <li>
      <span className="row">
        <code>{stack.name}</code>
        {stack.dns && <span className="tag">DNS zone</span>}
        <StatusBadge tone={tone}>{label}</StatusBadge>
      </span>
      {stack.error && <span className="muted">{stack.error}</span>}
      {lint && (
        <span className="muted">
          {lint.errors === 0 && lint.warnings === 0
            ? "Lint found nothing"
            : `Lint: ${count(lint.errors, "error")}, ${count(lint.warnings, "warning")}`}
        </span>
      )}
      <span className="error">
        <Rules label="Denied" names={stack.policy?.denied ?? []} />
      </span>
      <Rules label="Warnings" names={stack.policy?.warned ?? []} />
    </li>
  );
}

/** More stacks than this and the order is listed, not drawn: a picture of that many is not one to read. */
const MAX_GRAPH = 60;

/** The order a plan's stacks go in, drawn only once asked for (FLW-3); the registry is the default branch's, not the plan's commit. */
function Order({ stacks }: { stacks: PlanStack[] }) {
  const [open, setOpen] = useState(false);
  if (!stacks.some((s) => s.dependsOn.length > 0)) return null;
  if (stacks.length > MAX_GRAPH) {
    return (
      <p className="muted">The order is not drawn for a plan of more than {MAX_GRAPH} stacks.</p>
    );
  }
  return (
    <details className="plan-order" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Show order</summary>
      {open && (
        <>
          <RunGraph
            stacks={stacks.map((s) => {
              const [label, tone] = planStateOf(s.status);
              return { ...s, label, tone, dns: s.dns !== null };
            })}
          />
          <p className="muted">As registered on the default branch.</p>
        </>
      )}
    </details>
  );
}

/** The plans of a project (DNS-16): which stacks each made, where each is, a DNS zone as one, and why a plan was denied. */
function Plans({ orgId, projectId, pollMs }: { orgId: string; projectId: string; pollMs: number }) {
  const client = useClient();
  const plans = useQuery({
    queryKey: ["plans", orgId, projectId],
    queryFn: async (): Promise<Plan[]> =>
      (
        await call(() =>
          client
            .organizations({ orgId })
            .projects({ projectId })
            .runs.get({ query: { limit: MAX_PLANS } }),
        )
      ).items,
    refetchInterval: (q) => (q.state.data?.some(going_) ? pollMs : false),
  });
  if (!plans.data) {
    return plans.error ? (
      <ErrorPanel error={plans.error} retry={() => void plans.refetch()} />
    ) : (
      <Loading what="Loading plans" />
    );
  }
  if (plans.data.length === 0) {
    return (
      <p>
        No plan has been made for this project yet. Plans appear here once a merge request asks for
        one.
      </p>
    );
  }
  return (
    <Card title="Plan runs" sub="The newest plans of the project's stacks.">
      <table>
        <caption className="visually-hidden">Plan runs</caption>
        <thead>
          <tr>
            <th scope="col">Branch</th>
            <th scope="col">Stacks</th>
            <th scope="col">Made</th>
          </tr>
        </thead>
        <tbody>
          {plans.data.map((p) => (
            <tr key={p.id}>
              <th scope="row">
                <code>{p.ref}</code>{" "}
                <span className="muted">
                  {p.kind === "drift"
                    ? "Drift check"
                    : p.mergeRequestIid && `MR !${p.mergeRequestIid}`}
                </span>
              </th>
              <td>
                <ul className="plan-stacks">
                  {p.stacks.map((s) => (
                    <PlanStackItem key={s.name} stack={s} />
                  ))}
                </ul>
                <Order stacks={p.stacks} />
              </td>
              <td>
                <time dateTime={stamp(p.createdAt)}>{when(p.createdAt)}</time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** What a project's pipelines are doing: the newest one of each branch, why a failed one failed, and a retry; then what is deployed where, and its plans. */
export function RunsPage({ orgId, pollMs = POLL_MS }: { orgId: string; pollMs?: number }) {
  return (
    <ProjectPicker orgId={orgId}>
      {(project) => (
        <>
          <Runs key={project.id} orgId={orgId} projectId={project.id} pollMs={pollMs} />
          {lacks(project, "deployments") ? (
            <Card title="Deployments">
              <p className="muted">{lacks(project, "deployments")}</p>
            </Card>
          ) : (
            <Deployments
              key={`deployments-${project.id}`}
              orgId={orgId}
              projectId={project.id}
              pollMs={pollMs}
            />
          )}
          <Plans key={`plans-${project.id}`} orgId={orgId} projectId={project.id} pollMs={pollMs} />
        </>
      )}
    </ProjectPicker>
  );
}
