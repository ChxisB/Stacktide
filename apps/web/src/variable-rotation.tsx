import { ROOT } from "@orch/core/folders";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Loading, stamp, when } from "./ui";
import { type Cell, type Env, Form, InFolder, useWrite, variablesAt } from "./variable-parts";

const SKIPPED: Record<string, string> = {
  claim_lost: "a worker was rotating it at the same moment and finished first",
  variable_gone: "the variable is gone",
  protection_changed: "the environment's protection changed meanwhile",
};

/**
 * How one secret rotates: the provider, the schedule and the last result, switching it off and on, and
 * "rotate now" after a confirmation. A rotation is set up from the command line (`orch rotation set`),
 * since its settings are provider-specific. The API keeps the settings and the credentials it makes to
 * itself, so nothing here can show a value; a new value is read with Reveal like any other.
 */
export function Rotation({
  orgId,
  projectId,
  cell,
  env,
  folder = ROOT,
  changed,
}: {
  orgId: string;
  projectId: string;
  cell: Cell;
  env: Env;
  /** The folder the variable is in, named at the top. */
  folder?: string;
  /** A rotation changed the value: the grid reloads, so no old revealed value sits beside the new one. */
  changed: () => Promise<void>;
}) {
  const client = useClient();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string>();
  const at = () => variablesAt(client, orgId, projectId, cell.level, env.id)({ varId: cell.id });
  const status = useQuery({
    queryKey: ["rotation", orgId, cell.id],
    // read afresh every time it is opened: a worker may have rotated it since
    gcTime: 0,
    queryFn: async () => {
      try {
        return await call(() => at().rotation.get());
      } catch (e) {
        // no rotation is set: an answer, not a failure
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
  const reread = async () => {
    await status.refetch();
  };
  const current = status.data;
  // `PUT` replaces the whole setting; the config is left out, so the stored one stays
  const toggle = useWrite(
    () =>
      current
        ? call(() =>
            at().rotation.put({
              provider: current.provider,
              intervalDays: current.intervalDays,
              graceDays: current.graceDays,
              enabled: !current.enabled,
            }),
          )
        : Promise.resolve(),
    reread,
  );
  const run = useWrite(
    async () => {
      const r = await call(() => at().rotation.rotate.post());
      setResult(
        r.result === "rotated"
          ? `Rotated: ${cell.key} is now version ${r.version}. Reveal it from the grid to see it.`
          : r.result === "waiting"
            ? "Waiting for approval: a change request holds the new value, and the current one stays in use until a maintainer other than its author approves it."
            : `Nothing was done: ${SKIPPED[r.why ?? ""] ?? "it was skipped"}.`,
      );
    },
    async () => {
      setConfirming(false);
      await changed();
      await reread();
    },
  );

  if (confirming) {
    return (
      <Form
        title={`Rotate ${cell.key} now`}
        onSubmit={run.go}
        error={run.error}
        pending={run.pending}
        submit="Rotate now"
        onCancel={() => {
          setConfirming(false);
          // a failed run was counted: the panel shows it
          void reread();
        }}
      >
        <p>
          This makes a new value for <code>{cell.key}</code> in {env.name} now, instead of waiting
          for the schedule. The current value stops being the variable's current version, and
          whatever still holds it has to be given the new one.
        </p>
      </Form>
    );
  }
  return (
    <section className="stack card" aria-label={`Rotation of ${cell.key}`}>
      <InFolder folder={folder} />
      {status.error ? (
        <ErrorPanel error={status.error} retry={() => void status.refetch()} />
      ) : current === undefined ? (
        <Loading what="Loading rotation" />
      ) : current === null ? (
        <p>
          <code>{cell.key}</code> does not rotate. Set a rotation from the command line, for
          example: <code>orch rotation set {cell.key} --provider random --interval 30</code>
        </p>
      ) : (
        <>
          <p>
            <strong>{current.provider}</strong>, every {current.intervalDays} days
            {current.graceDays > 0 && `, with ${current.graceDays} days of grace`}{" "}
            {!current.enabled && <span className="tag">Switched off</span>}
          </p>
          {current.lastStatus === "never" ? (
            <p>Never rotated.</p>
          ) : current.lastStatus === "pending_approval" ? (
            <p>
              Waiting for approval: a change request holds the new value, and the current one stays
              in use until a maintainer other than its author approves it.
            </p>
          ) : (
            current.lastAt && (
              <p>
                Last {current.lastStatus === "ok" ? "rotated" : "attempted"}{" "}
                <time dateTime={stamp(current.lastAt)}>{when(current.lastAt)}</time>.
              </p>
            )
          )}
          {current.attempts > 0 && (
            <p className="error">
              {current.lastStatus === "failing" ? "Failing" : "The last attempt failed"}:{" "}
              {current.lastError ?? "failed"}, {current.attempts} failed in a row. The current value
              is still in use.
            </p>
          )}
          {current.enabled ? (
            <p className="muted">
              Next run: <time dateTime={stamp(current.nextAt)}>{when(current.nextAt)}</time>
            </p>
          ) : (
            <p className="muted">It will not rotate by itself while it is switched off.</p>
          )}
          {current.revokePending && (
            <p className="muted">
              A replaced credential is still valid and will be revoked when its grace ends.
            </p>
          )}
        </>
      )}
      {result && <p role="status">{result}</p>}
      {toggle.error && (
        <p role="alert" className="error">
          {toggle.error}
        </p>
      )}
      {current && (
        <div className="detail-actions">
          <button type="button" disabled={toggle.pending} onClick={() => void toggle.go()}>
            {current.enabled ? "Switch off" : "Switch on"}
          </button>
          <button type="button" onClick={() => setConfirming(true)}>
            Rotate now
          </button>
        </div>
      )}
    </section>
  );
}
