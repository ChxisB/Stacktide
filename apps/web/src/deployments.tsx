import type { Client } from "@orch/api-client";
import { statsLine } from "@orch/core/deployment-stats";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Callout, Card, Dialog, StatusBadge, type Tone, useToast } from "./components";
import { Asks, asksKey, requestsAt, useAsks } from "./deployment-asks";
import { webUrl } from "./pipeline-parts";
import { FORGES, type Forge } from "./projects";
import { Loading, stamp, when } from "./ui";
import { useWrite } from "./variable-parts";

/** A deployment as the API answers: ids, a sha, a status and times, never a person or a commit's words. */
interface Build {
  id: string;
  environment: string;
  sha: string;
  ref: string;
  status: string;
  pipelineId: number | null;
  finishedAt: string | null;
  observedAt: string;
}

/** GitLab's deployment statuses in words, and what kind of news each is. */
const STATUS: Record<string, [label: string, tone: Tone]> = {
  success: ["Deployed", "ok"],
  failed: ["Failed", "bad"],
  running: ["Deploying", "active"],
  created: ["Created", "active"],
  blocked: ["Waiting for approval", "quiet"],
  canceled: ["Canceled", "quiet"],
  skipped: ["Skipped", "quiet"],
};
// a status this version does not know is shown in its own words, as a quiet one
const statusOf = (status: string): [string, Tone] =>
  STATUS[status] ?? [status.replaceAll("_", " "), "quiet"];

/** How far back the numbers under each box look. */
const STATS_DAYS = 30;

const at = (client: Client, orgId: string, projectId: string) =>
  client.organizations({ orgId }).projects({ projectId }).deployments;

/** The run of a GitLab pipeline the platform knows, for its web address; none when it has not heard of it. */
function PipelineLink({
  orgId,
  projectId,
  pipelineId,
}: {
  orgId: string;
  projectId: string;
  pipelineId: number | null;
}) {
  const client = useClient();
  const run = useQuery({
    queryKey: ["deployment-pipeline", orgId, projectId, pipelineId],
    enabled: pipelineId !== null,
    queryFn: async () =>
      (
        await call(() =>
          client
            .organizations({ orgId })
            .projects({ projectId })
            ["pipeline-runs"].get({ query: { pipelineId: pipelineId ?? 0, limit: 1 } }),
        )
      ).runs[0],
  });
  const link = run.data && webUrl(run.data.webUrl);
  return link && run.data ? (
    <a href={link} target="_blank" rel="noreferrer">
      Pipeline #{run.data.iid}
    </a>
  ) : null;
}

function BuildLine({
  orgId,
  projectId,
  build,
}: {
  orgId: string;
  projectId: string;
  build: Build;
}) {
  const [label, tone] = statusOf(build.status);
  return (
    <span className="row middle">
      <StatusBadge tone={tone}>{label}</StatusBadge>
      <code>{build.sha.slice(0, 8)}</code>
      <code>{build.ref}</code>
      <time dateTime={stamp(build.finishedAt ?? build.observedAt)}>
        {when(build.finishedAt ?? build.observedAt)}
      </time>
      <PipelineLink orgId={orgId} projectId={projectId} pipelineId={build.pipelineId} />
    </span>
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");

type Kind = "promote" | "rollback";
/** What the box of an environment needs to offer a promotion or a rollback. */
interface Where {
  id: string;
  name: string;
  slug: string;
  protected: boolean;
  current: Build | null;
  rollbackTo: string | null;
}
/** The API's answer to a promotion or a rollback, a dry run or not: the plan, and the pipeline when one was started. */
interface Answer {
  plan: { from: { sha: string } | null; to: string; previous: string | null; protected: boolean };
  pipeline: { id: number; webUrl: string } | null;
}
const short = (sha: string) => sha.slice(0, 8);

/**
 * Promote or Roll back one environment, in a dialog (DEP-14). It asks the API for the dry run first and
 * shows what that says; Confirm waits for it, and a refusal is shown in the API's words instead of it.
 * A dry run is an API call that writes an audit row, so a choice of another build asks again, and nothing
 * is asked twice for the same one.
 * shortcut: the builds offered are the newest hundred deployments that succeeded, so one older than that
 * can only be promoted by `orch deploy promote --sha`; page the list when that bites.
 */
function DeployDialog({
  kind,
  orgId,
  projectId,
  env,
  before,
  close,
  started,
  asked,
}: {
  kind: Kind;
  orgId: string;
  projectId: string;
  env: Where;
  /** The build deployed to the environment before this one: the one a promotion offers first. */
  before: Build | null;
  close: () => void;
  started: (answer: Answer) => Promise<void>;
  /** A request for approval was made for this build. */
  asked: (sha: string) => Promise<void>;
}) {
  const client = useClient();
  const promote = kind === "promote";
  const builds = useQuery({
    queryKey: ["deployment-builds", orgId, projectId],
    enabled: promote,
    queryFn: () =>
      call(() => at(client, orgId, projectId).get({ query: { status: "success", limit: 100 } })),
  });
  const history = builds.data?.deployments ?? [];
  // newest first, each build once, and not the one that is already there (the API refuses that)
  const options = [...new Set(history.map((d) => d.sha))].filter((sha) => sha !== env.current?.sha);
  const [picked, setPicked] = useState<string>();
  const sha = !promote
    ? undefined
    : (picked ?? (before && options.includes(before.sha) ? before.sha : options[0]));
  const ask = (dryRun: boolean): Promise<Answer> => {
    const api = at(client, orgId, projectId);
    return promote
      ? call(() => api.promote.post({ environment: env.slug, sha: sha ?? "", dryRun }))
      : call(() => api.rollback.post({ environment: env.slug, dryRun }));
  };
  const plan = useQuery({
    queryKey: ["deployment-plan", kind, orgId, projectId, env.slug, sha ?? null],
    enabled: !promote || sha !== undefined,
    queryFn: () => ask(true),
    // a look is a dry run, which is audited: ask once for each choice, and not again for a focus
    retry: false,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const answer = plan.data;
  // a protected environment is entered with an approval (DEP-18): without one for this build, the button asks
  const guarded = answer?.plan.protected === true;
  const asks = useAsks(orgId, projectId, env.id, env.protected);
  const held = asks.data?.filter((a) => a.sha === answer?.plan.to) ?? [];
  const waiting = held.some((a) => a.status === "open");
  const asking = guarded && !held.some((a) => a.status === "approved");
  const result = useRef<Answer | undefined>(undefined);
  const write = useWrite(
    async () => {
      if (asking && answer)
        await call(() =>
          requestsAt(client, orgId, projectId, env.id).post({
            kind: "deploy",
            sha: answer.plan.to,
          }),
        );
      else result.current = await ask(false);
    },
    async () => {
      if (asking && answer) await asked(answer.plan.to);
      else if (result.current) await started(result.current);
    },
  );
  const label = (build: string) => {
    const d = history.find((x) => x.sha === build);
    return d ? `${short(build)} · ${d.ref} · ${when(d.finishedAt ?? d.observedAt)}` : short(build);
  };
  return (
    <Dialog
      title={promote ? `Promote to ${env.name}` : `Roll back ${env.name}`}
      confirm={
        asking
          ? waiting
            ? "Waiting for approval"
            : "Ask for approval"
          : promote
            ? "Start deployment"
            : "Start rollback"
      }
      busy={write.pending}
      disabled={!answer || (guarded && !asks.data) || (asking && waiting)}
      error={write.error ?? (plan.error ? message(plan.error) : undefined)}
      onConfirm={() => void write.go()}
      close={close}
    >
      {promote && options.length > 0 && (
        <label>
          Build to deploy
          <select value={sha ?? ""} onChange={(e) => setPicked(e.target.value)}>
            {options.map((o) => (
              <option key={o} value={o}>
                {label(o)}
              </option>
            ))}
          </select>
        </label>
      )}
      {promote && builds.data && options.length === 0 && (
        <p>No other build has been deployed successfully in this project yet.</p>
      )}
      {!answer && plan.isFetching && <Loading what="Checking what this would do" />}
      {answer && (
        <>
          <div className="deploy-plan">
            <div>
              <span className="muted">Now deployed</span>
              {answer.plan.from ? <code>{short(answer.plan.from.sha)}</code> : "nothing"}
            </div>
            <div>
              <span className="muted">{promote ? "Going there" : "Going back to"}</span>
              <code>{short(answer.plan.to)}</code>
            </div>
          </div>
          {answer.plan.previous && (
            <p className="muted">
              If a health check is set up and it fails, <code>{short(answer.plan.previous)}</code>{" "}
              is put back.
            </p>
          )}
          {!promote && (
            <p className="muted">
              Data changes are not undone: a database migration that ran stays run.
            </p>
          )}
          {guarded && (
            <Callout tone="info" title={`${env.name} is protected:`}>
              {!asking
                ? "an approval for this build is ready, and starting uses it up."
                : waiting
                  ? "an approval for this build has been asked for, and waits for someone other than the person who asked."
                  : "starting needs an approval from someone other than you. Ask for it here; once it is approved, start it."}
            </Callout>
          )}
        </>
      )}
    </Dialog>
  );
}

/**
 * What is deployed where (DEP-7): a box for each environment of the project with the build that is
 * there and, when it differs, the last attempt. Refresh is offered to everyone who sees the card, as
 * Retry is on the pipelines: the API is the gate, and a refusal is shown in its words, because the
 * page cannot know a person's role in one project.
 */
export function Deployments({
  orgId,
  projectId,
  pollMs,
  forge = "gitlab",
}: {
  orgId: string;
  projectId: string;
  pollMs: number;
  /** The forge the project is on, which names who says what is deployed. */
  forge?: Forge;
}) {
  const client = useClient();
  const { name: forgeName } = FORGES[forge];
  const queries = useQueryClient();
  const key = ["deployments", orgId, projectId];
  const where = useQuery({
    queryKey: key,
    queryFn: () => call(() => at(client, orgId, projectId).environments.get()),
    // one is being deployed: look again until it has finished
    refetchInterval: (q) =>
      q.state.data?.environments.some(
        (e) => e.lastAttempt && statusOf(e.lastAttempt.status)[1] === "active",
      )
        ? pollMs
        : false,
  });
  // under `key`, so what invalidates the boxes (Refresh, a started deployment) reads the numbers again too
  const numbers = useQuery({
    queryKey: [...key, "stats", STATS_DAYS],
    queryFn: () =>
      call(() => at(client, orgId, projectId).stats.get({ query: { days: STATS_DAYS } })),
  });
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();
  const [open, setOpen] = useState<{ kind: Kind; slug: string }>();

  const refresh = async () => {
    setRefreshing(true);
    setError(undefined);
    toast(); // the news of the last look goes before this one's is known
    try {
      const { recorded } = await call(() => at(client, orgId, projectId).refresh.post());
      await queries.invalidateQueries({ queryKey: key });
      toast(`Read ${forgeName}'s newest deployments: ${recorded} new or changed.`);
    } catch (e) {
      setError(message(e));
    } finally {
      setRefreshing(false);
    }
  };

  // what a person is told once the deployment has started: the box changes when the forge reports it
  const started = async (answer: Answer) => {
    const link = answer.pipeline && webUrl(answer.pipeline.webUrl);
    const rollback = open?.kind === "rollback";
    setOpen(undefined);
    setError(undefined);
    toast(
      <>
        Started {rollback ? "rolling back to" : "the deployment of"}{" "}
        <code>{short(answer.plan.to)}</code>
        {rollback ? "" : " to"} {open?.slug}
        {link && (
          <>
            :{" "}
            <a href={link} target="_blank" rel="noreferrer">
              open the {forge === "github" ? "run" : "pipeline"}
            </a>
          </>
        )}
        . It shows in its box when {forgeName} reports it.
      </>,
    );
    await queries.invalidateQueries({ queryKey: key });
    // the approval a protected environment used is spent
    await queries.invalidateQueries({ queryKey: asksKey(orgId, projectId) });
  };

  // what a person is told once the request for approval is made: it waits in the box of the environment
  const asked = async (sha: string) => {
    const slug = open?.slug;
    setOpen(undefined);
    setError(undefined);
    toast(
      <>
        Asked for approval to deploy <code>{short(sha)}</code> to {slug}. Someone other than you
        approves it in its box; then Promote or Roll back starts it.
      </>,
    );
    await queries.invalidateQueries({ queryKey: asksKey(orgId, projectId) });
  };

  const data = where.data;
  if (!data) {
    return where.error ? (
      <ErrorPanel error={where.error} retry={() => void where.refetch()} />
    ) : (
      <Loading what="Loading deployments" />
    );
  }
  const none = data.environments.length === 0 && data.unmatched.length === 0;
  const index = open ? data.environments.findIndex((e) => e.slug === open.slug) : -1;
  const target = data.environments[index];
  return (
    <Card
      title="Deployments"
      sub={`What ${forgeName} says is deployed to each environment.`}
      actions={
        <button type="button" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      {/* a failed look again keeps what was loaded */}
      {where.error && (
        <p role="alert" className="error">
          Could not look again: {message(where.error)}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {numbers.error && (
        <p className="muted">Could not read the numbers: {message(numbers.error)}</p>
      )}
      {none && (
        <p>
          No deployment has been recorded for this project yet. They appear when {forgeName} reports
          one:{" "}
          {forge === "github" ? (
            <>
              a workflow job that names an environment is one, as the <code>cloud-run</code> and{" "}
              <code>ecs</code> templates' are
            </>
          ) : (
            <>
              add the <code>docker-deploy</code> template on the Pipeline page, and tick "Deployment
              events" on the project's webhook
            </>
          )}
          . Refresh reads {forgeName} now.
        </p>
      )}
      {data.environments.length > 0 && (
        <ul className="deploy-boxes">
          {data.environments.map((e) => (
            <li key={e.id} className="deploy-box">
              <div className="row middle">
                <h3 className="deploy-name">{e.name}</h3>
                {e.protected && <span className="tag">Protected</span>}
              </div>
              {e.current ? (
                <BuildLine orgId={orgId} projectId={projectId} build={e.current} />
              ) : (
                <p className="muted">Nothing has been deployed here yet.</p>
              )}
              {numbers.data && (
                <p className="muted" title={`The last ${numbers.data.days} days`}>
                  {statsLine(numbers.data.environments.find((n) => n.environment === e.slug))}
                </p>
              )}
              <div className="row middle">
                <button
                  type="button"
                  aria-label={`Promote to ${e.name}`}
                  onClick={() => setOpen({ kind: "promote", slug: e.slug })}
                >
                  Promote
                </button>
                {e.rollbackTo && (
                  <button
                    type="button"
                    aria-label={`Roll back ${e.name}`}
                    onClick={() => setOpen({ kind: "rollback", slug: e.slug })}
                  >
                    Roll back
                  </button>
                )}
              </div>
              {e.protected && <Asks orgId={orgId} projectId={projectId} env={e} />}
              {e.lastAttempt && e.lastAttempt.id !== e.current?.id && (
                <div className="deploy-last">
                  <span className="muted">Last attempt</span>
                  <BuildLine orgId={orgId} projectId={projectId} build={e.lastAttempt} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && target && (
        <DeployDialog
          key={`${open.kind}:${open.slug}`}
          kind={open.kind}
          orgId={orgId}
          projectId={projectId}
          env={target}
          before={data.environments[index - 1]?.current ?? null}
          close={() => setOpen(undefined)}
          started={started}
          asked={asked}
        />
      )}
      {data.unmatched.length > 0 && (
        <p className="muted">
          {forgeName} has deployments to{" "}
          {data.unmatched.map((name, i) => (
            <span key={name}>
              {i > 0 && ", "}
              <code>{name}</code>
            </span>
          ))}
          , which are not environments of this project here.
        </p>
      )}
    </Card>
  );
}
