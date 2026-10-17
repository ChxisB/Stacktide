import type { Client } from "@orch/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { ProjectPicker } from "./projects";
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
                <td>{ACTION[i.action]}</td>
                <td>{i.changed.map((c) => FIELD[c] ?? c).join(", ")}</td>
                {results && (
                  <td>
                    {i.result === "applied" ? "Done" : i.result === "failed" ? "Failed" : ""}
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
  apply,
  discard,
}: {
  target: Target;
  plan: Run;
  busy: boolean;
  /** An apply is already running on the target (started from elsewhere): the API would refuse this one. */
  locked: boolean;
  apply: () => void;
  discard: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { counts } = plan;
  const todo = writes(counts);
  const { unresolved, missingEnvironments } = plan.skipped;
  return (
    <section className="stack" aria-label={`Plan for ${target.name}`}>
      <h3>Plan</h3>
      <p>
        Nothing has been changed on the target yet. This plan is good until {when(plan.expiresAt)}.
      </p>
      <p>
        {n(counts, "create")} to create, {n(counts, "update")} to change, {n(counts, "delete")} to
        delete.
      </p>
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
        <p>
          Mapped to an environment that no longer exists, and left alone:{" "}
          {missingEnvironments.join(", ")}.
        </p>
      )}
      {todo === 0 && <p>The target already has everything this project would put there.</p>}
      {confirming ? (
        <form
          className="stack card"
          aria-label={`Apply to ${target.name}`}
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <p>
            Apply this plan to <strong>{target.name}</strong>? It creates {n(counts, "create")},
            changes {n(counts, "update")} and deletes {n(counts, "delete")}{" "}
            {todo === 1 ? "variable" : "variables"} on the target.
          </p>
          {n(counts, "delete") > 0 && (
            <p className="error">
              A variable deleted from the target cannot be brought back from here: this project does
              not hold its value.
            </p>
          )}
          <div className="row">
            <button type="submit" className="primary" disabled={busy || locked}>
              {busy ? "Starting…" : "Apply plan"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="row">
          {todo > 0 && (
            <button
              type="button"
              className="primary"
              onClick={() => setConfirming(true)}
              disabled={locked}
            >
              Apply…
            </button>
          )}
          <button type="button" onClick={discard}>
            Discard plan
          </button>
        </div>
      )}
    </section>
  );
}

const DRIFT = { unchecked: "Not checked yet", in_sync: "In sync", drifted: "Drifted" } as const;

function Health({ drift, last }: { drift: Drift; last: Run | null | undefined }) {
  const failed = last?.items.filter((i) => i.result === "failed").length ?? 0;
  return (
    <dl className="facts">
      <dt>Drift</dt>
      <dd>
        <span className="tag">{DRIFT[drift.status]}</span>
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
  target,
  pollMs,
}: {
  orgId: string;
  projectId: string;
  target: Target;
  pollMs: number;
}) {
  const client = useClient();
  const queries = useQueryClient();
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
    });

  const applying = last.data?.status === "applying";
  const failure = drift.error ?? last.error;
  const mapped = Object.entries(target.environmentMapping);
  return (
    <section className="stack card" aria-label={`Sync target ${target.name}`}>
      <h2>{target.name}</h2>
      <p className="muted">
        {TYPE[target.type] ?? target.type}. {POLICY[target.unmanagedPolicy]}{" "}
        {target.autoSync ? "Syncs by itself when a variable changes." : "Syncs when you ask."}
      </p>
      {mapped.length > 0 && (
        <p className="muted">
          Environments: {mapped.map(([slug, scope]) => `${slug} → ${scope}`).join(", ")}
        </p>
      )}
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
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {plan ? (
        <Plan
          target={target}
          plan={plan}
          busy={busy === "apply"}
          locked={applying}
          apply={() => void apply()}
          discard={() => setPlan(undefined)}
        />
      ) : (
        <div className="row">
          <button
            type="button"
            onClick={() => void makePlan()}
            disabled={busy !== undefined || applying}
          >
            {busy === "plan" ? "Planning…" : "Plan sync"}
          </button>
        </div>
      )}
      {last.data?.items.some((i) => i.action !== "noop") && (
        <details open={last.data.items.some((i) => i.result === "failed")}>
          <summary>What the last sync did</summary>
          <Lines items={last.data.items} label={`Last sync of ${target.name}`} results />
        </details>
      )}
    </section>
  );
}

function ProjectSync({
  orgId,
  projectId,
  pollMs,
}: {
  orgId: string;
  projectId: string;
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
    return <p>This project has no sync targets yet.</p>;
  }
  return (
    <>
      {targets.data.map((t) => (
        <TargetCard key={t.id} orgId={orgId} projectId={projectId} target={t} pollMs={pollMs} />
      ))}
    </>
  );
}

/** Where a project's variables are synced to: drift, the last sync, and a plan that is read before it is applied. */
export function SyncPage({ orgId, pollMs = POLL_MS }: { orgId: string; pollMs?: number }) {
  return (
    <ProjectPicker orgId={orgId}>
      {(project) => (
        <ProjectSync key={project.id} orgId={orgId} projectId={project.id} pollMs={pollMs} />
      )}
    </ProjectPicker>
  );
}
