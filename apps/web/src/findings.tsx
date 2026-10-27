import type { Client } from "@orch/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import {
  Callout,
  Card,
  Chips,
  Dialog,
  Empty,
  Named,
  StatusBadge,
  type Tone,
  useToast,
} from "./components";
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

type View = "open" | "dismissed" | "resolved" | "all";
const VIEWS: { key: View; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "dismissed", label: "Dismissed" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];
// what an empty list says, in the words of the list it is
const EMPTY: Record<View, [title: string, text: string]> = {
  open: ["No open findings", "Nothing in this project needs revoking right now."],
  dismissed: [
    "No dismissed findings",
    "A finding you dismiss is listed here with who dismissed it and why.",
  ],
  resolved: ["No resolved findings", "Findings marked resolved are listed here."],
  all: ["No findings", "Nothing has been found in this project."],
};

const STATUS: Record<string, [label: string, tone: Tone]> = {
  open: ["Open", "manual"],
  dismissed: ["Dismissed", "quiet"],
  resolved: ["Resolved", "ok"],
};
const SEVERITY: Record<string, Tone> = { critical: "bad", high: "bad", medium: "warn" };
const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const where = (f: Finding) => (f.line === null ? f.path : `${f.path}:${f.line}`);
/** A path that may break after any slash, and nowhere else, when its column is narrow; its text is unchanged. */
function Path({ text }: { text: string }) {
  let seen = "";
  return text.split(/(?<=\/)/).map((part) => {
    seen += part;
    return (
      <Fragment key={seen}>
        {part}
        {part.endsWith("/") && <wbr />}
      </Fragment>
    );
  });
}
const message = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");

const at = (client: Client, orgId: string, projectId: string) =>
  client.organizations({ orgId }).projects({ projectId }).findings;

/** The one question a dismissal asks: why. The secret is not made safe by it, and the dialog says so. */
function Dismissing(props: {
  finding: Finding;
  busy: boolean;
  error?: string;
  dismiss: (reason: string) => void;
  close: () => void;
}) {
  const { finding: f } = props;
  const [reason, setReason] = useState("");
  const id = useId();
  return (
    <Dialog
      title="Dismiss this finding"
      sub={`${where(f)} matched ${f.rule} on ${f.ref}.`}
      confirm="Dismiss finding"
      busy={props.busy}
      disabled={reason.trim() === ""}
      error={props.error}
      onConfirm={() => props.dismiss(reason.trim())}
      close={props.close}
    >
      <Callout tone="warn">The secret is still valid until it is revoked at its source.</Callout>
      <div className="field">
        <label htmlFor={id}>Reason</label>
        <input
          id={id}
          value={reason}
          maxLength={1000}
          autoComplete="off"
          aria-describedby={`${id}-hint`}
          onChange={(e) => setReason(e.target.value)}
        />
        <span className="hint" id={`${id}-hint`}>
          Shown beside the finding, so the next person knows why.
        </span>
      </div>
    </Dialog>
  );
}

function Findings({ orgId, projectId, name }: { orgId: string; projectId: string; name: string }) {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
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
  // the finding itself, not its id: if it moves lists meanwhile, the dialog still says what it was asked about
  const [dismissing, setDismissing] = useState<Finding>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const act = async (request: () => Promise<unknown>, said: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await request();
      setDismissing(undefined);
      toast(said);
    } catch (e) {
      setError(message(e));
    } finally {
      // a finding that moved meanwhile is on its new list after this, whichever way the call went
      await queries.invalidateQueries({ queryKey: ["findings", orgId, projectId] });
      setBusy(false);
    }
  };
  const dismiss = (f: Finding, reason: string) =>
    void act(
      () => call(() => at(client, orgId, projectId)({ findingId: f.id }).dismiss.post({ reason })),
      `Dismissed ${where(f)}. The secret is still valid until it is revoked at its source.`,
    );
  const reopen = (f: Finding) =>
    void act(
      () => call(() => at(client, orgId, projectId)({ findingId: f.id }).reopen.post()),
      `Reopened ${where(f)}.`,
    );

  const rows = list.data;
  const [emptyTitle, emptyText] = EMPTY[view];
  return (
    <div className="stack wide">
      <Card
        title="Findings"
        sub={
          rows
            ? `${rows.length} ${view === "all" ? "" : `${view} `}${rows.length === 1 ? "finding" : "findings"} in ${name}.`
            : `Secret findings in ${name}.`
        }
      >
        <Chips
          label="Show findings"
          items={VIEWS}
          value={view}
          pick={(key) => setView(key as View)}
        />
        {rows && rows.length > 0 && (
          <Callout tone="warn">
            A finding is a secret that was in your repository: revoke it at the source. Dismissing
            it only stops it being counted, and does not make it safe.
          </Callout>
        )}
        {error && !dismissing && <Callout tone="bad">{error}</Callout>}
        {!rows ? (
          list.error ? (
            <ErrorPanel error={list.error} retry={() => void list.refetch()} />
          ) : (
            <Loading what="Loading findings" />
          )
        ) : rows.length === 0 ? (
          <Empty title={emptyTitle} text={emptyText} />
        ) : (
          <>
            {list.error && (
              <Callout tone="bad">Could not look again: {message(list.error)}</Callout>
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
                      <th scope="row" className="where">
                        <code>
                          <Path text={where(f)} />
                        </code>
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
                          <>
                            <div className="note muted">
                              by <code>{f.dismissedBy}</code>
                              {f.dismissedAt && (
                                <>
                                  {" "}
                                  on{" "}
                                  <time dateTime={stamp(f.dismissedAt)}>{when(f.dismissedAt)}</time>
                                </>
                              )}
                            </div>
                            <div className="note-reason">{f.dismissedReason}</div>
                          </>
                        )}
                      </td>
                      <td className="row-actions">
                        {f.status === "open" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setError(undefined);
                              setDismissing(f);
                            }}
                          >
                            <Named word="Dismiss" name={where(f)} />
                          </button>
                        )}
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
          </>
        )}
      </Card>
      {dismissing && (
        <Dismissing
          finding={dismissing}
          busy={busy}
          error={error}
          dismiss={(reason) => dismiss(dismissing, reason)}
          close={() => {
            setError(undefined);
            setDismissing(undefined);
          }}
        />
      )}
    </div>
  );
}

/** The secret findings of a project's scans (SCAN-7): where each is, why one was dismissed, and triage for those who may. */
export function FindingsPage({ orgId }: { orgId: string }) {
  return (
    <ProjectPicker orgId={orgId}>
      {(project) => (
        <Findings key={project.id} orgId={orgId} projectId={project.id} name={project.name} />
      )}
    </ProjectPicker>
  );
}
