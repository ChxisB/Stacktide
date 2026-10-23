import type { Client } from "@orch/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Card, Named, StatusBadge, type Tone } from "./components";
import { ProjectPicker } from "./projects";
import { Loading, stamp, when } from "./ui";

export interface Finding {
  id: string;
  rule: string;
  path: string;
  line: number | null;
  severity: string;
  ref: string;
  status: string;
  dismissedBy: string | null;
  dismissedReason: string | null;
  dismissedAt: string | Date | null;
}

const VIEWS = [
  ["open", "Open"],
  ["dismissed", "Dismissed"],
  ["resolved", "Resolved"],
  ["all", "All"],
] as const;
type View = (typeof VIEWS)[number][0];

const STATUS: Record<string, [label: string, tone: Tone]> = {
  open: ["Open", "manual"],
  dismissed: ["Dismissed", "quiet"],
  resolved: ["Resolved", "ok"],
};
const SEVERITY: Record<string, Tone> = { critical: "bad", high: "bad", medium: "warn" };
const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const where = (f: Finding) => (f.line === null ? f.path : `${f.path}:${f.line}`);
const message = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");

const at = (client: Client, orgId: string, projectId: string) =>
  client.organizations({ orgId }).projects({ projectId }).findings;

function Findings({ orgId, projectId }: { orgId: string; projectId: string }) {
  const client = useClient();
  const queries = useQueryClient();
  const [view, setView] = useState<View>("open");
  const list = useQuery({
    queryKey: ["findings", orgId, projectId, view],
    queryFn: (): Promise<Finding[]> =>
      allPages((cursor) =>
        at(client, orgId, projectId).get({
          query: {
            limit: 100,
            ...(cursor ? { cursor } : {}),
            ...(view === "all" ? {} : { status: view }),
          },
        }),
      ),
  });
  const [dismissing, setDismissing] = useState<string>();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  const act = async (request: () => Promise<unknown>, said: string) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      await request();
      setDismissing(undefined);
      setReason("");
      setDone(said);
    } catch (e) {
      setError(message(e));
    } finally {
      // a finding that moved meanwhile is on its new list after this, whichever way the call went
      await queries.invalidateQueries({ queryKey: ["findings", orgId, projectId] });
      setBusy(false);
    }
  };
  const dismiss = (f: Finding, e: FormEvent) => {
    e.preventDefault();
    void act(
      () =>
        call(() =>
          at(client, orgId, projectId)({ findingId: f.id }).dismiss.post({ reason: reason.trim() }),
        ),
      `Dismissed ${where(f)}. The secret is still valid until it is revoked at its source.`,
    );
  };
  const reopen = (f: Finding) =>
    void act(
      () => call(() => at(client, orgId, projectId)({ findingId: f.id }).reopen.post()),
      `Reopened ${where(f)}.`,
    );

  const rows = list.data;
  return (
    <div className="stack wide">
      <label>
        Show
        <select value={view} onChange={(e) => setView(e.target.value as View)}>
          {VIEWS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {done && <p role="status">{done}</p>}
      {!rows ? (
        list.error ? (
          <ErrorPanel error={list.error} retry={() => void list.refetch()} />
        ) : (
          <Loading what="Loading findings" />
        )
      ) : rows.length === 0 ? (
        <p>No {view === "all" ? "" : `${view} `}findings for this project.</p>
      ) : (
        <Card title="Findings">
          <p className="warn">
            A finding is a secret that was in your repository: revoke it at the source. Dismissing
            it only stops it being counted, and does not make it safe.
          </p>
          {list.error && (
            <p role="alert" className="error">
              Could not look again: {message(list.error)}
            </p>
          )}
          <table>
            <caption className="visually-hidden">Secret findings</caption>
            <thead>
              <tr>
                <th scope="col">Where</th>
                <th scope="col">Rule</th>
                <th scope="col">Severity</th>
                <th scope="col">Branch</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const [label, tone] = STATUS[f.status] ?? [f.status, "quiet"];
                return (
                  <tr key={f.id}>
                    <th scope="row">
                      <code>{where(f)}</code>
                    </th>
                    <td>
                      <code>{f.rule}</code>
                    </td>
                    <td>
                      <StatusBadge tone={SEVERITY[f.severity] ?? "quiet"}>
                        {capital(f.severity)}
                      </StatusBadge>
                    </td>
                    <td>
                      <code>{f.ref}</code>
                    </td>
                    <td>
                      <StatusBadge tone={tone}>{label}</StatusBadge>
                      {f.status === "dismissed" && (
                        <span className="muted">
                          {" "}
                          by <code>{f.dismissedBy}</code>
                          {f.dismissedAt && (
                            <>
                              {" "}
                              on <time dateTime={stamp(f.dismissedAt)}>{when(f.dismissedAt)}</time>
                            </>
                          )}
                          : {f.dismissedReason}
                        </span>
                      )}
                    </td>
                    <td>
                      {f.status === "open" &&
                        (dismissing === f.id ? (
                          <form className="row" onSubmit={(e) => dismiss(f, e)}>
                            <label>
                              Reason
                              <input
                                value={reason}
                                maxLength={1000}
                                onChange={(e) => setReason(e.target.value)}
                              />
                            </label>
                            <button type="submit" disabled={busy || reason.trim() === ""}>
                              Dismiss finding
                            </button>
                            <button type="button" onClick={() => setDismissing(undefined)}>
                              Cancel
                            </button>
                          </form>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setDismissing(f.id);
                              setReason("");
                            }}
                          >
                            <Named word="Dismiss" name={where(f)} />
                          </button>
                        ))}
                      {f.status === "dismissed" && (
                        <button type="button" disabled={busy} onClick={() => reopen(f)}>
                          <Named word="Reopen" name={where(f)} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

/** The secret findings of a project's scans (SCAN-7): where each is, why one was dismissed, and triage for those who may. */
export function FindingsPage({ orgId }: { orgId: string }) {
  return (
    <ProjectPicker orgId={orgId}>
      {(project) => <Findings key={project.id} orgId={orgId} projectId={project.id} />}
    </ProjectPicker>
  );
}
