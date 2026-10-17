import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Loading } from "./ui";
import { type Cell, type Env, Form, SOURCE, useWrite, variablesAt } from "./variable-parts";

// The typed client turns an ISO timestamp into a Date although the type says string: take either.
const stamp = (at: string | Date) => new Date(at).toISOString();
const when = (at: string | Date) => `${stamp(at).slice(0, 16).replace("T", " ")} UTC`;

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

/**
 * The versions of one variable, newest first: who changed it, when and why, never a value (the
 * history route carries none). Going back adds a new version with the old value, so the history
 * only grows.
 */
export function History({
  orgId,
  projectId,
  cell,
  env,
  done,
  close,
}: {
  orgId: string;
  projectId: string;
  cell: Cell;
  env: Env;
  done: () => Promise<void>;
  close: () => void;
}) {
  const client = useClient();
  const [restoring, setRestoring] = useState<number>();
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
      <h2>History of {cell.key}</h2>
      <p className="muted">Values are not shown here, only who changed it and when.</p>
      {versions.error ? (
        <ErrorPanel error={versions.error} retry={() => void versions.refetch()} />
      ) : !versions.data ? (
        <Loading what="Loading history" />
      ) : (
        <table>
          <caption className="visually-hidden">Versions of {cell.key}</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Changed by</th>
              <th scope="col">When</th>
              <th scope="col">Why</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.data.map((v) => (
              <tr key={v.version}>
                <th scope="row">{v.version}</th>
                <td>
                  {v.actorKind} {v.actorId.slice(0, 8)}
                </td>
                <td>
                  <time dateTime={stamp(v.createdAt)}>{when(v.createdAt)}</time>
                </td>
                <td>{v.reason ?? ""}</td>
                <td>
                  {v.version === current ? (
                    <span className="tag">Current</span>
                  ) : (
                    <button
                      type="button"
                      className="small"
                      aria-label={`Restore ${cell.key} to version ${v.version}`}
                      onClick={() => setRestoring(v.version)}
                    >
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row">
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
    </section>
  );
}
