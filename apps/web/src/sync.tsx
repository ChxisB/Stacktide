import type { Client } from "@orch/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiError, allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Callout, Card, Dialog, Icon, StatusBadge, type Tone, useToast } from "./components";
import { ProjectPicker } from "./projects";
import { SyncFlow } from "./sync-flow";
import { Loading, when } from "./ui";

// What a sync screen shows of a plan or a run is keys, scopes, actions and the names of the fields
// that differ. The API sends no value (plans hold none), and nothing here asks for one.

type Action = "create" | "update" | "delete" | "noop" | "adopt";
type Stamp = string | Date;

interface Target {
  id: string;
  name: string;
  type: string;
  environmentMapping: Record<string, string>;
  unmanagedPolicy: "ignore" | "adopt" | "prune";
  autoSync: boolean;
}
interface Line {
  key: string;
  scope: string;
  action: Action;
  changed: string[];
  result?: "applied" | "failed" | null;
  error?: string | null;
}
interface Run {
  id: string;
  status: "planned" | "applying" | "applied" | "failed";
  error: string | null;
  expiresAt: Stamp;
  updatedAt: Stamp;
  counts: Partial<Record<Action, number>>;
  skipped: {
    unresolved: { key: string; scope: string; code: string }[];
    missingEnvironments: string[];
  };
  items: Line[];
}
interface Drift {
  status: "unchecked" | "in_sync" | "drifted";
  counts: Record<string, number>;
  checkedAt: Stamp | null;
}

/** How often a run that is being applied is looked at again. */
export const POLL_MS = 1_000;

const ACTION: Record<Action, string> = {
  create: "Create",
  update: "Change",
  delete: "Delete from the target",
  noop: "Same",
  adopt: "Only on the target (left as it is)",
};
const FIELD: Record<string, string> = {
  value: "the value",
  secret: "masked or not",
  file: "file or text",
};
const POLICY = {
  ignore: "Variables only on the target are left alone.",
  adopt: "Variables only on the target are listed and left alone.",
  prune: "Variables only on the target are deleted.",
} as const;
const TYPE: Record<string, string> = { "gitlab-variables": "GitLab CI/CD variables" };
// a plan that can never be applied again: plan again
const SPENT = new Set(["plan_stale", "plan_expired", "plan_not_applicable"]);

const targetAt = (client: Client, orgId: string, projectId: string, targetId: string) =>
  client.organizations({ orgId }).projects({ projectId })["sync-targets"]({ targetId });

// A plus, a tilde and a minus for what a plan does; the words beside them stay the only text.
const MARK: Partial<Record<Action, string>> = {
  create: "M9 4.5v9M4.5 9h9",
  update: "M3.5 9.6c1.5-3 3.5-3 5.5-.5s4 2.5 5.5-.5",
  delete: "M4.5 9h9",
};
function Op({ action }: { action: Action }) {
  const d = MARK[action];
  return d ? (
    <svg className={`op op-${action}`} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  ) : null;
}

const TO: Record<"create" | "update" | "delete", string> = {
  create: "create",
  update: "change",
  delete: "delete",
};

const scopeText = (scope: string) => (scope === "*" ? "All environments" : scope);
const n = (counts: Partial<Record<string, number>>, action: string) => counts[action] ?? 0;
const writes = (counts: Partial<Record<string, number>>) =>
  n(counts, "create") + n(counts, "update") + n(counts, "delete");

/** The lines that do something (or went wrong); the ones that already match are only counted. */
function Lines({ items, label, results }: { items: Line[]; label: string; results?: boolean }) {
  const shown = items.filter((i) => i.action !== "noop");
  const same = items.length - shown.length;
  return (
    <>
      {shown.length > 0 && (
        <table>
          <caption className="visually-hidden">{label}</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Applies to</th>
              <th scope="col">What happens</th>
              <th scope="col">What differs</th>
              {results && <th scope="col">Result</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={`${i.scope}\u0000${i.key}`}>
                <th scope="row">
                  <code>{i.key}</code>
                </th>
                <td>{scopeText(i.scope)}</td>
                <td>
                  <Op action={i.action} />
                  {ACTION[i.action]}
                </td>
                <td>{i.changed.map((c) => FIELD[c] ?? c).join(", ")}</td>
                {results && (
                  <td>
                    {i.result === "applied" ? (
                      <StatusBadge tone="ok">Done</StatusBadge>
                    ) : i.result === "failed" ? (
                      <StatusBadge tone="bad">Failed</StatusBadge>
                    ) : (
                      ""
                    )}
                    {i.error ? `: ${i.error}` : ""}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {same > 0 && (
        <p className="muted">
          {same} {same === 1 ? "variable already matches" : "variables already match"}.
        </p>
      )}
    </>
  );
}

function Plan({
  target,
  plan,
  busy,
  locked,
  error,
  clearError,
  apply,
  discard,
}: {
  target: Target;
  plan: Run;
  busy: boolean;
  /** An apply is already running on the target (started from elsewhere): the API would refuse this one. */
  locked: boolean;
  /** Why the apply was refused, said in the dialog it was asked from. */
  error?: string;
  clearError: () => void;
  apply: () => void;
  discard: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { counts } = plan;
  const todo = writes(counts);
  const deletes = n(counts, "delete");
  const { unresolved, missingEnvironments } = plan.skipped;
  return (
    <section className="stack" aria-label={`Plan for ${target.name}`}>
      <h3>Plan</h3>
      <p className="muted">
        Nothing has been changed on the target yet. This plan is good until {when(plan.expiresAt)}.
      </p>
      <div className="sync-counts">
        {(["create", "update", "delete"] as const).map((a) => (
          <span key={a} className="sync-count">
            <Op action={a} />
            {n(counts, a)} to {TO[a]}
          </span>
        ))}
      </div>
      {deletes > 0 && (
        <Callout tone="bad">
          {deletes === 1
            ? "1 variable would be deleted from the target. This project does not hold its value, so it cannot be brought back from here."
            : `${deletes} variables would be deleted from the target. This project does not hold their values, so they cannot be brought back from here.`}
        </Callout>
      )}
      <Lines items={plan.items} label={`What would change on ${target.name}`} />
      {unresolved.length > 0 && (
        <>
          <h4>Left out</h4>
          <ul>
            {unresolved.map((u) => (
              <li key={`${u.scope}\u0000${u.key}`}>
                <code>{u.key}</code> ({scopeText(u.scope)}): {u.code.replaceAll("_", " ")}
              </li>
            ))}
          </ul>
        </>
      )}
      {missingEnvironments.length > 0 && (
        <Callout tone="info">
          Mapped to an environment that no longer exists, and left alone:{" "}
          {missingEnvironments.join(", ")}.
        </Callout>
      )}
      {todo === 0 && <p>The target already has everything this project would put there.</p>}
      <div className="row">
        {todo > 0 && (
          <button
            type="button"
            className="primary"
            onClick={() => {
              clearError();
              setConfirming(true);
            }}
            disabled={locked}
          >
            Apply…
          </button>
        )}
        <button type="button" onClick={discard}>
          Discard plan
        </button>
      </div>
      {confirming && (
        <Dialog
          title={`Apply this plan to ${target.name}?`}
          sub={`It creates ${n(counts, "create")}, changes ${n(counts, "update")} and deletes ${deletes} ${
            deletes === 1 ? "variable" : "variables"
          } on the target.`}
          confirm={busy ? "Starting…" : "Apply plan"}
          destructive={deletes > 0}
          busy={busy}
          disabled={locked}
          error={error}
          onConfirm={apply}
          close={() => setConfirming(false)}
        >
          {deletes > 0 && (
            <Callout tone="warn">
              A variable deleted from the target cannot be brought back from here: this project does
              not hold its value.
            </Callout>
          )}
        </Dialog>
      )}
    </section>
  );
}

/** What the last sync did: shut unless a line failed, and the person's own choice holds until the next run. */
function LastSync({ run, name }: { run: Run; name: string }) {
  const [choice, setChoice] = useState<boolean>();
  const open = choice ?? run.items.some((i) => i.result === "failed");
  const panel = useId();
  return (
    <div>
      <button
        type="button"
        className="quiet small"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setChoice(!open)}
      >
        <span className="chev">
          <Icon name="down" />
        </span>
        What the last sync did
      </button>
      <div id={panel} hidden={!open}>
        <Lines items={run.items} label={`Last sync of ${name}`} results />
      </div>
    </div>
  );
}

const DRIFT = { unchecked: "Not checked yet", in_sync: "In sync", drifted: "Drifted" } as const;
const DRIFT_TONE: Record<Drift["status"], Tone> = {
  unchecked: "quiet",
  in_sync: "ok",
  drifted: "warn",
};

function Health({ drift, last }: { drift: Drift; last: Run | null | undefined }) {
  const failed = last?.items.filter((i) => i.result === "failed").length ?? 0;
  return (
    <dl className="facts">
      <dt>Drift</dt>
      <dd>
        <StatusBadge tone={DRIFT_TONE[drift.status]}>{DRIFT[drift.status]}</StatusBadge>
        {drift.checkedAt && <> checked {when(drift.checkedAt)}</>}
        {drift.status === "drifted" && (
          <>
            {" "}
            ({n(drift.counts, "create")} to create, {n(drift.counts, "update")} to change,{" "}
            {n(drift.counts, "delete")} to delete)
          </>
        )}
      </dd>
      <dt>Last sync</dt>
      <dd>
        {!last && "Never synced from here."}
        {last?.status === "applying" && "Syncing now…"}
        {last?.status === "applied" && <>Applied {when(last.updatedAt)}.</>}
        {last?.status === "failed" && (
          <>
            Failed {when(last.updatedAt)}
            {last.error ? `: ${last.error}` : ""}
            {failed > 0 && ` (${failed} ${failed === 1 ? "variable" : "variables"} failed)`}.
          </>
        )}
      </dd>
    </dl>
  );
}

function TargetCard({
  orgId,
  projectId,
  projectName,
  target,
  pollMs,
}: {
  orgId: string;
  projectId: string;
  projectName: string;
  target: Target;
  pollMs: number;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
  const at = () => targetAt(client, orgId, projectId, target.id);
  const drift = useQuery({
    queryKey: ["sync-drift", orgId, target.id],
    queryFn: (): Promise<Drift> => call(() => at().drift.get()),
  });
  const last = useQuery({
    queryKey: ["sync-last", orgId, target.id],
    queryFn: async (): Promise<Run | null> => (await call(() => at()["last-run"].get())).run,
    // an apply is a job: look again until it has finished
    refetchInterval: (q) => (q.state.data?.status === "applying" ? pollMs : false),
  });
  const [plan, setPlan] = useState<Run>();
  const [busy, setBusy] = useState<"plan" | "apply">();
  const [error, setError] = useState<string>();

  const run = async (kind: "plan" | "apply", send: () => Promise<void>) => {
    setBusy(kind);
    setError(undefined);
    try {
      await send();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
      if (e instanceof ApiError && e.code && SPENT.has(e.code)) setPlan(undefined);
    } finally {
      setBusy(undefined);
    }
  };
  const makePlan = () => run("plan", async () => setPlan(await call(() => at().plan.post())));
  const apply = () =>
    run("apply", async () => {
      if (!plan) return;
      await call(() => at().apply.post({ planId: plan.id }));
      // the plan stays (and the buttons stay held) until the screen knows a run is going
      await queries.invalidateQueries({ queryKey: ["sync-last", orgId, target.id] });
      setPlan(undefined);
      toast(`Sync started on ${target.name}.`);
    });

  const applying = last.data?.status === "applying";
  const failure = drift.error ?? last.error;
  return (
    <Card
      label={`Sync target ${target.name}`}
      title={target.name}
      sub={`${TYPE[target.type] ?? target.type}. ${
        target.autoSync ? "Syncs by itself when a variable changes." : "Syncs when you ask."
      }`}
      actions={
        !plan && (
          <button
            type="button"
            onClick={() => void makePlan()}
            disabled={busy !== undefined || applying}
          >
            {busy === "plan" ? "Planning…" : "Plan sync"}
          </button>
        )
      }
    >
      <Callout tone={target.unmanagedPolicy === "prune" ? "warn" : "info"}>
        {POLICY[target.unmanagedPolicy]}
      </Callout>
      <SyncFlow
        project={projectName}
        target={{ name: target.name, type: TYPE[target.type] ?? target.type }}
        mapping={target.environmentMapping}
        lines={plan?.items}
      />
      {failure ? (
        <ErrorPanel
          error={failure}
          retry={() => {
            void drift.refetch();
            void last.refetch();
          }}
        />
      ) : !drift.data || last.data === undefined ? (
        <Loading what="Loading sync status" />
      ) : (
        <Health drift={drift.data} last={last.data} />
      )}
      {error && !plan && <Callout tone="bad">{error}</Callout>}
      {plan && (
        <Plan
          target={target}
          plan={plan}
          busy={busy === "apply"}
          locked={applying}
          error={error}
          clearError={() => setError(undefined)}
          apply={() => void apply()}
          discard={() => setPlan(undefined)}
        />
      )}
      {last.data?.items.some((i) => i.action !== "noop") && (
        <LastSync key={last.data.id} run={last.data} name={target.name} />
      )}
    </Card>
  );
}

function ProjectSync({
  orgId,
  projectId,
  projectName,
  pollMs,
}: {
  orgId: string;
  projectId: string;
  projectName: string;
  pollMs: number;
}) {
  const client = useClient();
  const targets = useQuery({
    queryKey: ["sync-targets", orgId, projectId],
    queryFn: () =>
      allPages<Target>((cursor) =>
        client
          .organizations({ orgId })
          .projects({ projectId })
          ["sync-targets"].get({ query: { limit: 100, cursor } }),
      ),
  });
  if (targets.error)
    return <ErrorPanel error={targets.error} retry={() => void targets.refetch()} />;
  if (!targets.data) return <Loading what="Loading sync targets" />;
  if (targets.data.length === 0) {
    return (
      <Card title="Sync targets">
        <p>This project has no sync targets yet.</p>
      </Card>
    );
  }
  return (
    <>
      {targets.data.map((t) => (
        <TargetCard
          key={t.id}
          orgId={orgId}
          projectId={projectId}
          projectName={projectName}
          target={t}
          pollMs={pollMs}
        />
      ))}
    </>
  );
}

/** Where a project's variables are synced to: drift, the last sync, and a plan that is read before it is applied. */
export function SyncPage({ orgId, pollMs = POLL_MS }: { orgId: string; pollMs?: number }) {
  return (
    <ProjectPicker orgId={orgId}>
      {(project) => (
        <ProjectSync
          key={project.id}
          orgId={orgId}
          projectId={project.id}
          projectName={project.name}
          pollMs={pollMs}
        />
      )}
    </ProjectPicker>
  );
}
