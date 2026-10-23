import { ROOT } from "@orch/core/folders";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Icon } from "./components";
import { Loading, stamp, when } from "./ui";
import {
  type Cell,
  COPIED_MS,
  type Env,
  Form,
  Hidden,
  InFolder,
  readValue,
  SOURCE,
  toClipboard,
  useReveal,
  useWrite,
  variablesAt,
} from "./variable-parts";

function Restore({
  orgId,
  projectId,
  cell,
  env,
  version,
  done,
  cancel,
}: {
  orgId: string;
  projectId: string;
  cell: Cell;
  env: Env;
  version: number;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const client = useClient();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const write = useWrite(
    () =>
      call(() =>
        variablesAt(
          client,
          orgId,
          projectId,
          cell.level,
          env.id,
        )({ varId: cell.id }).restore.post({ version, ...(reason ? { reason } : {}) }),
      ),
    done,
  );
  return (
    <Form
      title={`Restore ${cell.key} to version ${version}`}
      onSubmit={write.go}
      error={write.error}
      pending={write.pending}
      submit="Restore version"
      onCancel={cancel}
    >
      <p>
        This adds a new version with the value version {version} had. The versions after it stay in
        the history.
      </p>
      {cell.level !== "environment" && (
        <p>
          This value belongs to {SOURCE[cell.level]}: restoring it changes it everywhere it is
          passed down.
        </p>
      )}
      <div className="field">
        <label htmlFor={reasonId}>Why (optional)</label>
        <input
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </div>
    </Form>
  );
}

type VersionRow = {
  version: number;
  actorKind: string;
  actorId: string;
  createdAt: string;
  reason?: string | null;
};

/**
 * One version on the timeline: a head (the number, "Current", the time, and Copy, Reveal and Restore as icon buttons at
 * the right), the value box under it (masked until asked for) and who changed it and why.
 */
function Version({
  cell,
  v,
  current,
  revealMs,
  fetchValue,
  copy,
  restore,
}: {
  cell: Cell;
  v: VersionRow;
  current: boolean;
  revealMs: number;
  fetchValue: () => Promise<string>;
  copy: () => void;
  restore: () => void;
}) {
  const reveal = useReveal(fetchValue, revealMs);
  const name = `${cell.key} version ${v.version}`;
  return (
    <li className="tl-item" aria-label={`Version ${v.version}`}>
      <div className="tl-head">
        <strong className="tl-ver">Version {v.version}</strong>
        {current && <span className="tag">Current</span>}
        <span className="tl-time muted">
          <Icon name="clock" />
          <time dateTime={stamp(v.createdAt)}>{when(v.createdAt)}</time>
        </span>
        <span className="tl-actions">
          <button
            type="button"
            className="icon quiet"
            aria-label={`Copy ${name}`}
            title={`Copy ${name}`}
            onClick={copy}
          >
            <Icon name="copy" />
          </button>
          {reveal.shown === undefined ? (
            <button
              type="button"
              className="icon quiet"
              disabled={reveal.busy}
              aria-label={`Reveal ${name}`}
              title={`Reveal ${name}`}
              onClick={reveal.show}
            >
              <Icon name="eye" />
            </button>
          ) : (
            <button
              type="button"
              className="icon quiet"
              aria-label={`Hide ${name}`}
              title={`Hide ${name}`}
              onClick={reveal.hide}
            >
              <Icon name="eye-off" />
            </button>
          )}
          {!current && (
            <button
              type="button"
              className="icon quiet"
              aria-label={`Restore ${cell.key} to version ${v.version}`}
              title={`Restore ${cell.key} to version ${v.version}`}
              onClick={restore}
            >
              <Icon name="restore" />
            </button>
          )}
        </span>
      </div>
      <div className="tl-value">
        {reveal.shown === undefined ? <Hidden /> : <code className="revealed">{reveal.shown}</code>}
        {reveal.error && (
          <span role="alert" className="error">
            {reveal.error}
          </span>
        )}
      </div>
      <p className="tl-by muted">
        Changed by {v.actorKind} {v.actorId.slice(0, 8)}
        {v.reason && <> · {v.reason}</>}
      </p>
    </li>
  );
}

/**
 * The versions of one variable, newest first: who changed it, when and why. The history route carries
 * no value: each version's is hidden until it is revealed or copied, one audited read of that version.
 * Going back adds a new version with the old value, so the history only grows.
 */
export function History({
  orgId,
  projectId,
  cell,
  env,
  folder = ROOT,
  revealMs,
  done,
}: {
  orgId: string;
  projectId: string;
  cell: Cell;
  env: Env;
  /** The folder the variable is in, named at the top. */
  folder?: string;
  revealMs: number;
  done: () => Promise<void>;
}) {
  const client = useClient();
  const [restoring, setRestoring] = useState<number>();
  const [note, setNote] = useState<string>();
  const [refused, setRefused] = useState<string>();
  // the "Copied" note goes by itself
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(undefined), COPIED_MS);
    return () => clearTimeout(timer);
  }, [note]);
  const copy = async (version: number) => {
    setNote(undefined);
    setRefused(undefined);
    const problem = await toClipboard(() =>
      readValue(client, orgId, projectId, cell, env, version),
    );
    if (problem) setRefused(problem);
    else setNote(`Copied the value of ${cell.key} version ${version}`);
  };
  const versions = useQuery({
    queryKey: ["versions", orgId, cell.id],
    // read afresh every time it is opened: a restore made a moment ago must be in the list
    gcTime: 0,
    queryFn: () =>
      allPages((cursor) =>
        variablesAt(
          client,
          orgId,
          projectId,
          cell.level,
          env.id,
        )({ varId: cell.id }).versions.get({
          query: { limit: 100, cursor },
        }),
      ),
  });
  if (restoring !== undefined) {
    return (
      <Restore
        orgId={orgId}
        projectId={projectId}
        cell={cell}
        env={env}
        version={restoring}
        done={done}
        cancel={() => setRestoring(undefined)}
      />
    );
  }
  const current = Math.max(0, ...(versions.data ?? []).map((v) => v.version));
  return (
    <section className="stack card" aria-label={`History of ${cell.key}`}>
      <InFolder folder={folder} />
      <p className="muted">
        A value stays hidden until you reveal or copy it. Each time is recorded in the audit log.
      </p>
      {versions.error ? (
        <ErrorPanel error={versions.error} retry={() => void versions.refetch()} />
      ) : !versions.data ? (
        <Loading what="Loading history" />
      ) : (
        <ol className="timeline" aria-label={`Versions of ${cell.key}`}>
          {versions.data.map((v) => (
            <Version
              key={v.version}
              cell={cell}
              v={v}
              current={v.version === current}
              revealMs={revealMs}
              fetchValue={() => readValue(client, orgId, projectId, cell, env, v.version)}
              copy={() => void copy(v.version)}
              restore={() => setRestoring(v.version)}
            />
          ))}
        </ol>
      )}
      {note && <p role="status">{note}</p>}
      {refused && (
        <p role="alert" className="error">
          {refused}
        </p>
      )}
    </section>
  );
}
