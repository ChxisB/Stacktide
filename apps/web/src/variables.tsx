import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { ProjectPicker } from "./projects";
import { Loading } from "./ui";
import { History } from "./variable-history";
import { Import } from "./variable-import";
import {
  AppliesTo,
  type Cell,
  type Env,
  Form,
  type Kind,
  type Level,
  levelOf,
  SOURCE,
  useWrite,
  ValueField,
  variablesAt,
} from "./variable-parts";

/** How long a revealed value stays on screen. */
export const REVEAL_MS = 15_000;

const ISSUES: Record<string, string> = {
  missing: "refers to a variable that is not set",
  cycle: "refers to itself in a loop",
  unresolved: "depends on one that cannot be filled in",
  duplicate: "is defined twice",
  too_large: "is too large once filled in",
};
const MASK = "••••••••";
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const useEnvironments = (orgId: string, projectId: string) => {
  const client = useClient();
  return useQuery({
    queryKey: ["environments", orgId, projectId],
    queryFn: () =>
      allPages<Env>((cursor) =>
        client
          .organizations({ orgId })
          .projects({ projectId })
          .environments.get({ query: { limit: 100, cursor } }),
      ),
  });
};

/** The keys a level holds itself, to tell an override from a value that is only passed down. */
const useOwnKeys = (orgId: string, projectId: string | undefined) => {
  const client = useClient();
  const level = projectId ? "project" : "organization";
  return useQuery({
    queryKey: projectId ? ["variables", orgId, projectId] : ["variables", orgId],
    queryFn: async () =>
      new Set(
        (
          await allPages((cursor) =>
            variablesAt(client, orgId, projectId ?? "", level, undefined).get({
              query: { limit: 100, cursor },
            }),
          )
        ).map((v) => v.key),
      ),
  });
};

/** A secret's value on request: audited by the API, held in this component only, and hidden again after `ms`. */
function Reveal({
  fetchValue,
  ms,
  label,
}: {
  fetchValue: () => Promise<string>;
  ms: number;
  label: string;
}) {
  const [shown, setShown] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (shown === undefined) return;
    const timer = setTimeout(() => setShown(undefined), ms);
    return () => clearTimeout(timer);
  }, [shown, ms]);
  const show = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setShown(await fetchValue());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the value.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {shown === undefined ? (
        <>
          <span aria-hidden="true">{MASK}</span>
          <span className="visually-hidden">Hidden value</span>
        </>
      ) : (
        <code className="revealed">{shown}</code>
      )}
      {shown === undefined ? (
        <button
          type="button"
          className="small"
          disabled={busy}
          onClick={show}
          aria-label={`Reveal ${label}`}
        >
          Reveal
        </button>
      ) : (
        <button
          type="button"
          className="small"
          onClick={() => setShown(undefined)}
          aria-label={`Hide ${label}`}
        >
          Hide
        </button>
      )}
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </>
  );
}

type Panel =
  | { kind: "add"; key?: string; scope?: string }
  | { kind: "edit"; cell: Cell; env: Env }
  | { kind: "delete"; cell: Cell; env: Env }
  | { kind: "history"; cell: Cell; env: Env }
  | { kind: "import" };

function AddVariable({
  orgId,
  projectId,
  envs,
  initial,
  done,
  cancel,
}: {
  orgId: string;
  projectId: string;
  envs: Env[];
  initial: { key?: string | undefined; scope?: string | undefined };
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const client = useClient();
  const [key, setKey] = useState(initial.key ?? "");
  const [kind, setKind] = useState<Kind>("secret");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState(initial.scope ?? "project");
  const [description, setDescription] = useState("");
  const write = useWrite(
    () => {
      return call(() =>
        variablesAt(client, orgId, projectId, levelOf(scope), scope).post({
          key,
          kind,
          value,
          ...(description ? { description } : {}),
        }),
      );
    },
    async () => {
      setValue("");
      await done();
    },
  );
  return (
    <Form
      title="Add a variable"
      onSubmit={write.go}
      error={write.error}
      pending={write.pending}
      submit="Add variable"
      onCancel={cancel}
    >
      <label>
        Name
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          required
          maxLength={255}
          pattern="[A-Za-z_][A-Za-z0-9_]*"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <label>
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="secret">Secret (masked, shown only on request)</option>
          <option value="plain">Plain (shown to everyone who can see the project)</option>
          <option value="file">File (masked, may be several lines)</option>
        </select>
      </label>
      <ValueField kind={kind} value={value} onChange={setValue} label="Value" />
      <AppliesTo envs={envs} value={scope} onChange={setScope} />
      <label>
        What it is for (optional)
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={1000}
        />
      </label>
    </Form>
  );
}

function EditVariable({
  orgId,
  projectId,
  cell,
  env,
  done,
  cancel,
}: {
  orgId: string;
  projectId: string;
  cell: Cell;
  env: Env;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const client = useClient();
  const [value, setValue] = useState(cell.kind === "plain" ? (cell.value ?? "") : "");
  const write = useWrite(
    () =>
      call(() =>
        variablesAt(
          client,
          orgId,
          projectId,
          cell.level,
          env.id,
        )({ varId: cell.id }).patch({
          value,
        }),
      ),
    async () => {
      setValue("");
      await done();
    },
  );
  return (
    <Form
      title={`Edit ${cell.key}`}
      onSubmit={write.go}
      error={write.error}
      pending={write.pending}
      submit="Save"
      onCancel={cancel}
    >
      {cell.level !== "environment" && (
        <p>
          This value belongs to {SOURCE[cell.level]}: changing it changes it everywhere it is passed
          down.
        </p>
      )}
      {cell.kind !== "plain" && <p className="muted">The current value is not shown here.</p>}
      <ValueField kind={cell.kind} value={value} onChange={setValue} label="New value" />
    </Form>
  );
}

function DeleteVariable({
  orgId,
  projectId,
  cell,
  env,
  done,
  cancel,
}: {
  orgId: string;
  projectId: string;
  cell: Cell;
  env: Env;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const client = useClient();
  const write = useWrite(
    () =>
      call(() =>
        variablesAt(client, orgId, projectId, cell.level, env.id)({ varId: cell.id }).delete(),
      ),
    done,
  );
  return (
    <Form
      title={`Delete ${cell.key}`}
      onSubmit={write.go}
      error={write.error}
      pending={write.pending}
      submit="Delete variable"
      onCancel={cancel}
    >
      <p>
        Delete <code>{cell.key}</code> from {SOURCE[cell.level]}?
        {cell.level !== "environment" && " Every environment that gets it from there loses it too."}{" "}
        Its history is kept, but nothing uses it any more.
      </p>
    </Form>
  );
}

function AddEnvironment({ orgId, projectId }: { orgId: string; projectId: string }) {
  const client = useClient();
  const queries = useQueryClient();
  const [name, setName] = useState("");
  const slug = slugOf(name);
  const write = useWrite(
    () =>
      call(() =>
        client.organizations({ orgId }).projects({ projectId }).environments.post({ name, slug }),
      ),
    async () => {
      setName("");
      await queries.invalidateQueries({ queryKey: ["environments", orgId, projectId] });
    },
  );
  return (
    <form
      className="row"
      aria-label="Add an environment"
      onSubmit={(e) => {
        e.preventDefault();
        void write.go();
      }}
    >
      <label>
        New environment
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
          placeholder="staging"
        />
      </label>
      <button type="submit" disabled={write.pending || slug === ""}>
        Add environment
      </button>
      {write.error && (
        <p role="alert" className="error">
          {write.error}
        </p>
      )}
    </form>
  );
}

function Grid({
  orgId,
  projectId,
  envs,
  revealMs,
}: {
  orgId: string;
  projectId: string;
  envs: Env[];
  revealMs: number;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const [panel, setPanel] = useState<Panel>();
  // a new value must never sit beside an old revealed one
  const [epoch, setEpoch] = useState(0);
  const sets = useQueries({
    queries: envs.map((env) => ({
      queryKey: ["resolved", orgId, projectId, env.id],
      queryFn: () =>
        call(() =>
          client
            .organizations({ orgId })
            .projects({ projectId })
            .environments({ envId: env.id })
            ["resolved-variables"].get(),
        ),
    })),
  });
  const projectKeys = useOwnKeys(orgId, projectId);
  const orgKeys = useOwnKeys(orgId, undefined);

  const failed = sets.find((s) => s.error);
  if (failed?.error) {
    return <ErrorPanel error={failed.error} retry={() => sets.forEach((s) => void s.refetch())} />;
  }
  // the markers come from the key lists: wait for them, so no marker shows and then changes
  if (sets.some((s) => s.data === undefined) || projectKeys.isPending || orgKeys.isPending) {
    return <Loading what="Loading variables" />;
  }

  const reload = async () => {
    await Promise.all([
      // every project of the organization: a value passed down from it shows in all of them
      queries.invalidateQueries({ queryKey: ["resolved", orgId] }),
      queries.invalidateQueries({ queryKey: ["variables", orgId] }),
    ]);
    setEpoch((n) => n + 1);
  };
  const refresh = async () => {
    await reload();
    setPanel(undefined);
  };
  const keys = [
    ...new Set(
      sets.flatMap((s) => [
        ...(s.data?.variables ?? []).map((v) => v.key),
        ...(s.data?.issues ?? []).map((i) => i.key),
      ]),
    ),
  ].sort();
  // a level with nothing readable (a member cannot list the organization's) overrides nothing we can see
  const lower = (cell: Cell) =>
    cell.level === "environment" && projectKeys.data?.has(cell.key)
      ? "project"
      : cell.level !== "organization" && orgKeys.data?.has(cell.key)
        ? "organization"
        : undefined;

  return (
    <div className="stack wide">
      {keys.length === 0 ? (
        <p>No variables yet. Add the first one below.</p>
      ) : (
        <div className="matrix">
          <table>
            <caption className="visually-hidden">Variables by environment</caption>
            <thead>
              <tr>
                <th scope="col">Variable</th>
                {envs.map((e) => (
                  <th key={e.id} scope="col">
                    {e.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key}>
                  <th scope="row">
                    <code>{key}</code>
                  </th>
                  {envs.map((env, i) => {
                    const data = sets[i]?.data;
                    const cell = data?.variables.find((v) => v.key === key);
                    const issue = data?.issues.find((x) => x.key === key);
                    const label = `${key} in ${env.name}`;
                    return (
                      <td key={env.id}>
                        {cell ? (
                          <CellView
                            key={`${cell.id}:${epoch}`}
                            cell={cell}
                            label={label}
                            overrides={lower(cell)}
                            revealMs={revealMs}
                            fetchValue={async () =>
                              (
                                await call(() =>
                                  variablesAt(
                                    client,
                                    orgId,
                                    projectId,
                                    cell.level,
                                    env.id,
                                  )({
                                    varId: cell.id,
                                  }).value.get({ query: {} }),
                                )
                              ).value
                            }
                            edit={() => setPanel({ kind: "edit", cell, env })}
                            remove={() => setPanel({ kind: "delete", cell, env })}
                            history={() => setPanel({ kind: "history", cell, env })}
                            override={() => setPanel({ kind: "add", key, scope: env.id })}
                          />
                        ) : issue ? (
                          <span className="error">{ISSUES[issue.code] ?? issue.code}</span>
                        ) : (
                          <>
                            <span className="muted">Not set</span>{" "}
                            <button
                              type="button"
                              className="small"
                              aria-label={`Set ${label}`}
                              onClick={() => setPanel({ kind: "add", key, scope: env.id })}
                            >
                              Set
                            </button>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {panel?.kind === "add" ? (
        <AddVariable
          key={`${panel.key}:${panel.scope}`}
          orgId={orgId}
          projectId={projectId}
          envs={envs}
          initial={panel}
          done={refresh}
          cancel={() => setPanel(undefined)}
        />
      ) : panel?.kind === "edit" ? (
        <EditVariable
          key={panel.cell.id}
          orgId={orgId}
          projectId={projectId}
          cell={panel.cell}
          env={panel.env}
          done={refresh}
          cancel={() => setPanel(undefined)}
        />
      ) : panel?.kind === "delete" ? (
        <DeleteVariable
          key={panel.cell.id}
          orgId={orgId}
          projectId={projectId}
          cell={panel.cell}
          env={panel.env}
          done={refresh}
          cancel={() => setPanel(undefined)}
        />
      ) : panel?.kind === "history" ? (
        <History
          key={panel.cell.id}
          orgId={orgId}
          projectId={projectId}
          cell={panel.cell}
          env={panel.env}
          done={refresh}
          close={() => setPanel(undefined)}
        />
      ) : panel?.kind === "import" ? (
        <Import
          orgId={orgId}
          projectId={projectId}
          envs={envs}
          reload={reload}
          close={() => setPanel(undefined)}
        />
      ) : (
        <div className="row">
          <button type="button" onClick={() => setPanel({ kind: "add" })}>
            Add a variable
          </button>
          <button type="button" onClick={() => setPanel({ kind: "import" })}>
            Import variables
          </button>
        </div>
      )}
    </div>
  );
}

function CellView({
  cell,
  label,
  overrides,
  revealMs,
  fetchValue,
  edit,
  remove,
  history,
  override,
}: {
  cell: Cell;
  label: string;
  overrides: Level | undefined;
  revealMs: number;
  fetchValue: () => Promise<string>;
  edit: () => void;
  remove: () => void;
  history: () => void;
  override: () => void;
}) {
  return (
    <div className="cell">
      <div>
        {cell.kind === "plain" ? (
          <code>{cell.value || "(empty)"}</code>
        ) : (
          <Reveal fetchValue={fetchValue} ms={revealMs} label={label} />
        )}
      </div>
      <div className="tags">
        <span className="tag">
          {cell.level === "environment"
            ? overrides
              ? `Overrides ${overrides}`
              : "Set here"
            : `From ${cell.level}${overrides ? `, overrides ${overrides}` : ""}`}
        </span>
        {cell.kind !== "plain" && <span className="tag">{cell.kind}</span>}
        {cell.tainted && <span className="tag">reads a secret</span>}
      </div>
      <div className="tags">
        <button type="button" className="small" aria-label={`Edit ${label}`} onClick={edit}>
          Edit
        </button>
        {cell.level !== "environment" && (
          <button
            type="button"
            className="small"
            aria-label={`Override ${label}`}
            onClick={override}
          >
            Override
          </button>
        )}
        <button
          type="button"
          className="small"
          aria-label={`History of ${label}`}
          onClick={history}
        >
          History
        </button>
        <button
          type="button"
          className="small danger"
          aria-label={`Delete ${label}`}
          onClick={remove}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function ProjectVariables({
  orgId,
  projectId,
  revealMs,
}: {
  orgId: string;
  projectId: string;
  revealMs: number;
}) {
  const envs = useEnvironments(orgId, projectId);
  const queries = useQueryClient();
  if (envs.error) {
    return (
      <ErrorPanel
        error={envs.error}
        retry={() => void queries.invalidateQueries({ queryKey: ["environments"] })}
      />
    );
  }
  if (!envs.data) return <Loading what="Loading environments" />;
  return (
    <>
      {envs.data.length === 0 ? (
        <p>This project has no environments yet. Add one to set values for it.</p>
      ) : (
        <Grid orgId={orgId} projectId={projectId} envs={envs.data} revealMs={revealMs} />
      )}
      <AddEnvironment orgId={orgId} projectId={projectId} />
    </>
  );
}

/** Variables of one project, by environment: where each value comes from, add, change, delete, reveal. */
export function VariablesPage({
  orgId,
  revealMs = REVEAL_MS,
}: {
  orgId: string;
  revealMs?: number;
}) {
  return (
    <ProjectPicker orgId={orgId}>
      {(project) => (
        <ProjectVariables
          key={project.id}
          orgId={orgId}
          projectId={project.id}
          revealMs={revealMs}
        />
      )}
    </ProjectPicker>
  );
}
