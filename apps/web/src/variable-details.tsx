import { useQuery } from "@tanstack/react-query";
import { call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Card } from "./components";
import { Loading, when } from "./ui";
import {
  type Cell,
  type Env,
  LEVEL_NAME,
  type Level,
  Reveal,
  readValue,
  variablesAt,
} from "./variable-parts";

// `$${` is a literal and not a reference; `${KEY}` and `${/folder/KEY}` are (the same tokens core's resolver reads)
const REFERENCE = /(\$\$\{|\$\{(?:\/(?:[a-z0-9_-]+\/)*)?[A-Za-z_][A-Za-z0-9_]*\})/;

/** A plain value as it was written, with each `${KEY}` marked so the reader sees what it reads. */
function Written({ text }: { text: string }) {
  let at = 0;
  return (
    <code>
      {text.split(REFERENCE).map((part) => {
        const key = at;
        at += part.length;
        return part.startsWith("${") ? <mark key={key}>{part}</mark> : part;
      })}
    </code>
  );
}

/** One variable, as the list's row opened it: what it is, and every action the matrix offers on it. */
export function Details({
  orgId,
  projectId,
  cell,
  env,
  overrides,
  revealMs,
  shown,
  act,
}: {
  orgId: string;
  projectId: string;
  cell: Cell;
  env: Env;
  overrides: Level | undefined;
  revealMs: number;
  /** The value, when Reveal all is showing it. */
  shown?: string;
  act: {
    describe: (description: string, tags: string[]) => void;
    edit: () => void;
    override: () => void;
    move: () => void;
    history: () => void;
    rotation: () => void;
    remove: () => void;
  };
}) {
  const client = useClient();
  const label = `${cell.key} in ${env.name}`;
  // under ["variables", orgId] so a write's reload reads it again
  const read = useQuery({
    queryKey: ["variables", orgId, "item", cell.id],
    queryFn: () =>
      call(() =>
        variablesAt(client, orgId, projectId, cell.level, env.id)({ varId: cell.id }).get(),
      ),
  });
  const v = read.data;
  const stuck = cell.level === "environment" && env.protected === true;
  return (
    <Card label={cell.key}>
      {read.error ? (
        <ErrorPanel error={read.error} retry={() => void read.refetch()} />
      ) : !v ? (
        <Loading what="Loading details" />
      ) : (
        <dl>
          <dt>Value</dt>
          <dd>
            {cell.kind === "plain" ? (
              <Written text={v.value ?? ""} />
            ) : shown !== undefined ? (
              <code className="revealed">{shown}</code>
            ) : (
              <Reveal
                fetchValue={() => readValue(client, orgId, projectId, cell, env)}
                ms={revealMs}
                label={label}
              />
            )}
          </dd>
          <dt>Description</dt>
          <dd>{v.description || <span className="muted">No description</span>}</dd>
          <dt>Tags</dt>
          <dd>
            {v.tags.length === 0 ? (
              <span className="muted">No tags</span>
            ) : (
              <span className="tags">
                {v.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </span>
            )}
          </dd>
          <dt>Kind</dt>
          <dd>
            {v.kind}
            {cell.tainted && ", reads a secret"}
          </dd>
          <dt>Source</dt>
          <dd>{LEVEL_NAME[cell.level]}</dd>
          <dt>Version</dt>
          <dd>{v.version}</dd>
          <dt>Last updated</dt>
          <dd>{when(v.updatedAt)}</dd>
        </dl>
      )}
      {overrides && <p className="muted">{`Overrides the ${LEVEL_NAME[overrides]} value`}</p>}
      {/* an organization's variable sits at the root; a protected environment's change goes through a request */}
      {stuck && <p className="muted">A variable of a protected environment cannot be moved.</p>}
      <div className="detail-actions">
        <button
          type="button"
          className="quiet"
          disabled={!v}
          aria-label={`Edit description and tags of ${label}`}
          onClick={() => v && act.describe(v.description, v.tags)}
        >
          Edit description and tags
        </button>
        <button type="button" className="quiet" aria-label={`Edit ${label}`} onClick={act.edit}>
          Edit
        </button>
        {cell.level !== "environment" && (
          <button
            type="button"
            className="quiet"
            aria-label={`Override ${label}`}
            onClick={act.override}
          >
            Override
          </button>
        )}
        {cell.level !== "organization" && !stuck && (
          <button type="button" className="quiet" aria-label={`Move ${label}`} onClick={act.move}>
            Move to folder
          </button>
        )}
        <button
          type="button"
          className="quiet"
          aria-label={`History of ${label}`}
          onClick={act.history}
        >
          History
        </button>
        {cell.kind === "secret" && (
          <button
            type="button"
            className="quiet"
            aria-label={`Rotation of ${label}`}
            onClick={act.rotation}
          >
            Rotation
          </button>
        )}
        <button
          type="button"
          className="quiet danger"
          aria-label={`Delete ${label}`}
          onClick={act.remove}
        >
          Delete
        </button>
      </div>
    </Card>
  );
}
