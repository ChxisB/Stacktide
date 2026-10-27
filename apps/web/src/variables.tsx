import type { Client } from "@orch/api-client";
import { dotenvLine } from "@orch/core/dotenv";
import { ROOT } from "@orch/core/folders";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Callout, Card, Dialog, Drawer, Icon, RowMenu, useToast } from "./components";
import { ProjectPicker } from "./projects";
import { useAccess } from "./settings";
import { Loading } from "./ui";
import { Changes } from "./variable-changes";
import { Details } from "./variable-details";
import { AddEnvironment, EnvMenu } from "./variable-envs";
import {
  AddFolder,
  Crumbs,
  childrenOf,
  DeleteFolder,
  type FolderItem,
  FolderRows,
  MoveVariable,
  nameOf,
  RenameFolder,
  useOpenFolder,
} from "./variable-folders";
import { History } from "./variable-history";
import { Import } from "./variable-import";
import {
  AppliesTo,
  type Cell,
  COPIED_MS,
  type Env,
  Form,
  formTags,
  generate,
  Hidden,
  inFolder,
  type Kind,
  LEVEL_NAME,
  type Level,
  levelOf,
  QuickAdd,
  readValue,
  SOURCE,
  TagsField,
  toClipboard,
  useWrite,
  ValueField,
  variablesAt,
} from "./variable-parts";
import { Rotation } from "./variable-rotation";

/** How long a revealed value stays on screen. */
export const REVEAL_MS = 15_000;

const ISSUES: Record<string, string> = {
  missing: "refers to a variable that is not set",
  cycle: "refers to itself in a loop",
  unresolved: "depends on one that cannot be filled in",
  duplicate: "is defined twice",
  too_large: "is too large once filled in",
};
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

/**
 * What an environment sees in one folder (the root unless asked): the matrix and the list read it
 * alike, so they share one cache entry.
 */
const resolvedOf = (
  client: Client,
  orgId: string,
  projectId: string,
  envId: string,
  folder = ROOT,
) => ({
  queryKey: ["resolved", orgId, projectId, envId, folder],
  queryFn: () =>
    call(() =>
      client
        .organizations({ orgId })
        .projects({ projectId })
        .environments({ envId })
        ["resolved-variables"].get({ query: { folder } }),
    ),
});

/** The keys a level holds itself, to tell an override from a value that is only passed down. */
const useOwnKeys = (orgId: string, projectId: string | undefined, folder = ROOT) => {
  const client = useClient();
  const level = projectId ? "project" : "organization";
  return useQuery({
    queryKey: projectId ? ["variables", orgId, projectId, folder] : ["variables", orgId],
    queryFn: async () =>
      new Set(
        (
          await allPages((cursor) =>
            variablesAt(client, orgId, projectId ?? "", level, undefined).get({
              query: { limit: 100, cursor, folder },
            }),
          )
        ).map((v) => v.key),
      ),
  });
};

/** Re-reads what a write may have changed. `epoch` counts the reads, so a new value never sits beside an old revealed one. */
const useReload = (orgId: string) => {
  const queries = useQueryClient();
  const [epoch, setEpoch] = useState(0);
  const reload = async () => {
    await Promise.all([
      // every project of the organization: a value passed down from it shows in all of them
      queries.invalidateQueries({ queryKey: ["resolved", orgId] }),
      queries.invalidateQueries({ queryKey: ["variables", orgId] }),
      // a variable made or moved changes what a folder holds
      queries.invalidateQueries({ queryKey: ["folders", orgId] }),
    ]);
    setEpoch((n) => n + 1);
  };
  return { reload, epoch };
};

/**
 * The level a value overrides, if it does. A level with nothing readable (a member cannot list the
 * organization's) overrides nothing we can see. A variable is one of a folder: only the project's
 * of the same folder is overridden, and the organization's sit at the root, so a folder overrides none.
 */
const useLower = (orgId: string, projectId: string, folder = ROOT) => {
  const projectKeys = useOwnKeys(orgId, projectId, folder);
  const orgKeys = useOwnKeys(orgId, undefined);
  const lower = (cell: Cell): Level | undefined =>
    cell.level === "environment" && projectKeys.data?.has(cell.key)
      ? "project"
      : cell.level !== "organization" && folder === ROOT && orgKeys.data?.has(cell.key)
        ? "organization"
        : undefined;
  return { lower, pending: projectKeys.isPending || orgKeys.isPending };
};

type Panel =
  | { kind: "add"; key?: string; scope?: string }
  | { kind: "edit"; cell: Cell; env: Env }
  | { kind: "describe"; cell: Cell; env: Env; description: string; tags: string[] }
  | { kind: "delete"; cell: Cell; env: Env }
  | { kind: "move"; cell: Cell; env: Env }
  | { kind: "history"; cell: Cell; env: Env }
  | { kind: "rotation"; cell: Cell; env: Env }
  | { kind: "bulk"; cells: Cell[]; env: Env }
  | { kind: "import" }
  | { kind: "folder"; parent: string }
  | { kind: "folder-rename"; folder: FolderItem }
  | { kind: "folder-delete"; folder: FolderItem };

/** A panel of the drawer: a form or a screen. A delete is not one: it is a question, a dialog over whatever is open. */
type DrawerPanel = Exclude<Panel, { kind: "delete" | "bulk" }>;
const drawerPanel = (panel: Panel | undefined): DrawerPanel | undefined =>
  panel?.kind === "delete" || panel?.kind === "bulk" ? undefined : panel;

/** What a row's drawer says it is about: the variable, and the environment the row was in. */
const drawerTitle = (cell: Cell, env: Env) => `${cell.key} in ${env.name}`;
/** What a drawer is called: the form it holds, or the variable and environment a row's panel is about. */
const panelTitle = (panel: DrawerPanel) => {
  switch (panel.kind) {
    case "add":
      return "New variable";
    case "import":
      return "Import";
    case "folder":
      return "New folder";
    case "folder-rename":
      return `Rename ${nameOf(panel.folder.path)}`;
    case "folder-delete":
      return `Delete ${nameOf(panel.folder.path)}`;
    default:
      return drawerTitle(panel.cell, panel.env);
  }
};

const SUB: Record<DrawerPanel["kind"], string> = {
  add: "Add a variable and say where it applies",
  edit: "Write a new value; the old one stays in the history",
  describe: "Change its description and tags",
  move: "Put it in another folder; its history goes with it",
  history: "Audit its history and roll back changes",
  rotation: "How this secret is rotated",
  import: "Bring variables in from a .env file or JSON",
  folder: "Make a folder to keep variables together",
  "folder-rename": "Change its name; what is in it stays in it",
  "folder-delete": "Remove a folder with nothing in it",
};
/** The line under a drawer's title: what is open in it, the panel or else the variable's details. */
const panelSub = (panel: DrawerPanel | undefined) =>
  panel ? SUB[panel.kind] : "Details of this variable";

/** A variable's value onto the clipboard: a secret's is read from the audited route, a plain one is already in the list. Nothing, or why it failed. */
const copyOf = (client: Client, orgId: string, projectId: string, cell: Cell, at: Env) =>
  toClipboard(async () =>
    cell.kind === "plain" ? (cell.value ?? "") : readValue(client, orgId, projectId, cell, at),
  );

/** The panel that describes and tags a variable; the list has no description, so it is read first. */
const describeOf = async (
  client: Client,
  orgId: string,
  projectId: string,
  cell: Cell,
  at: Env,
): Promise<Panel> => {
  const one = await call(() =>
    variablesAt(client, orgId, projectId, cell.level, at.id)({ varId: cell.id }).get(),
  );
  return { kind: "describe", cell, env: at, description: one.description, tags: one.tags };
};

/** What a variable's ⋯ menu offers; each item hands its work to the page that shows the variable (the list or the matrix). */
const menuItems = (
  v: Cell,
  at: Env,
  go: { details: () => void; tags: () => void; open: (next: Panel) => void; copy: () => void },
) => [
  { label: "Edit details", run: go.details },
  { label: "Add tags", run: go.tags },
  { label: "Version history", run: () => go.open({ kind: "history", cell: v, env: at }) },
  ...(v.kind === "secret"
    ? [{ label: "Rotation", run: () => go.open({ kind: "rotation", cell: v, env: at }) }]
    : []),
  ...(v.level !== "environment"
    ? [{ label: "Add override", run: () => go.open({ kind: "add", key: v.key, scope: at.id }) }]
    : []),
  { label: "Copy value", run: go.copy },
  { label: "Delete", danger: true, run: () => go.open({ kind: "delete", cell: v, env: at }) },
];

/**
 * Makes a variable in the environment it applies to, and in each other environment that is ticked: one create for
 * each, in that order. That is not atomic: at the first refusal it stops, keeps what it made, says so and is left
 * holding only the environments not yet made, so a retry makes just those.
 */
function AddVariable({
  orgId,
  projectId,
  envs,
  folder,
  initial,
  done,
  reload,
  cancel,
}: {
  orgId: string;
  projectId: string;
  envs: Env[];
  /** The open folder: the variable is made in it. */
  folder: string;
  initial: { key?: string | undefined; scope?: string | undefined };
  done: () => Promise<void>;
  /** Re-reads the lists without closing the drawer: after an Add more, or when only some of the environments were made. */
  reload: () => Promise<void>;
  cancel: () => void;
}) {
  const client = useClient();
  const nameBox = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState(initial.key ?? "");
  const [kind, setKind] = useState<Kind>("secret");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState(initial.scope ?? "project");
  // the other environments it is made in as well, and whether the drawer stays open for the next one
  const [also, setAlso] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [description, setDescription] = useState("");
  const [tagText, setTagText] = useState("");
  const others = levelOf(scope) === "environment" ? envs.filter((e) => e.id !== scope) : [];
  const named = (id: string) => envs.find((e) => e.id === id)?.name ?? id;
  const write = useWrite(
    async () => {
      const tags = formTags(tagText);
      const targets = [scope, ...others.map((e) => e.id).filter((id) => also.includes(id))];
      for (const [i, target] of targets.entries()) {
        try {
          await call(() =>
            variablesAt(client, orgId, projectId, levelOf(target), target).post({
              key,
              kind,
              value,
              ...inFolder(folder),
              ...(description ? { description } : {}),
              ...(tags.length ? { tags } : {}),
            }),
          );
        } catch (e) {
          // the first refused: nothing was made, so the form is as it was
          if (i === 0) throw e;
          const made = targets.slice(0, i).map(named);
          const [next = scope, ...rest] = targets.slice(i);
          setScope(next);
          setAlso(rest);
          await reload();
          throw new Error(
            `${made.join(", ")} ${made.length === 1 ? "was" : "were"} created; ${named(target)} was not: ${e instanceof Error ? e.message : "that did not work."}`,
          );
        }
      }
    },
    async () => {
      setValue("");
      if (!more) return done();
      setKey("");
      await reload();
      nameBox.current?.focus();
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
          ref={nameBox}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          required
          maxLength={255}
          pattern="[A-Za-z_][A-Za-z0-9_]*"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <ValueField
        kind={kind}
        value={value}
        onChange={setValue}
        label="Value"
        onGenerate={() => setValue(generate())}
      />
      <AppliesTo envs={envs} value={scope} onChange={setScope} organization={folder === ROOT} />
      {folder !== ROOT && (
        <p className="muted">
          It is made in <code>{folder}</code>.
        </p>
      )}
      {others.length > 0 && (
        <fieldset className="also">
          <legend>Also create in</legend>
          {others.map((e) => (
            <label key={e.id}>
              <input
                type="checkbox"
                checked={also.includes(e.id)}
                onChange={(ev) =>
                  setAlso(ev.target.checked ? [...also, e.id] : also.filter((id) => id !== e.id))
                }
              />
              {e.name}
            </label>
          ))}
        </fieldset>
      )}
      <label>
        What it is for (optional)
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={1000}
        />
      </label>
      <details className="advanced">
        <summary>Advanced options</summary>
        <div className="stack">
          <label>
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="secret">Secret (masked, shown only on request)</option>
              <option value="plain">Plain (shown to everyone who can see the project)</option>
              <option value="file">File (masked, may be several lines)</option>
            </select>
          </label>
          <TagsField label="Tags (optional)" value={tagText} onChange={setTagText} />
        </div>
      </details>
      <label className="tick">
        <input type="checkbox" checked={more} onChange={(e) => setMore(e.target.checked)} />
        Add more
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
  const toast = useToast();
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
      toast(`Saved a new value of ${cell.key}.`);
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
        <Callout tone="warn">
          This value belongs to {SOURCE[cell.level]}: changing it changes it everywhere it is passed
          down.
        </Callout>
      )}
      {cell.kind !== "plain" && <p className="muted">The current value is not shown here.</p>}
      <ValueField kind={cell.kind} value={value} onChange={setValue} label="New value" />
    </Form>
  );
}

function DescribeVariable({
  orgId,
  projectId,
  cell,
  env,
  description,
  tags,
  done,
  cancel,
}: {
  orgId: string;
  projectId: string;
  cell: Cell;
  env: Env;
  description: string;
  tags: string[];
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const client = useClient();
  const [text, setText] = useState(description);
  const [tagText, setTagText] = useState(tags.join(", "));
  const write = useWrite(() => {
    // checked here, not inside `call`, which would report the error as a lost connection
    const tags = formTags(tagText);
    return call(() =>
      variablesAt(
        client,
        orgId,
        projectId,
        cell.level,
        env.id,
      )({ varId: cell.id }).patch({ description: text, tags }),
    );
  }, done);
  return (
    <Form
      title={`Describe and tag ${cell.key}`}
      onSubmit={write.go}
      error={write.error}
      pending={write.pending}
      submit="Save"
      onCancel={cancel}
    >
      <label>
        What it is for
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
      </label>
      <TagsField label="Tags" value={tagText} onChange={setTagText} />
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
  const toast = useToast();
  const write = useWrite(
    () =>
      call(() =>
        variablesAt(client, orgId, projectId, cell.level, env.id)({ varId: cell.id }).delete(),
      ),
    async () => {
      await done();
      toast(`Deleted ${cell.key} from ${SOURCE[cell.level]}.`);
    },
  );
  return (
    <Dialog
      title={`Delete ${cell.key}`}
      sub={`Delete ${cell.key} from ${SOURCE[cell.level]}? Its history is kept, but nothing uses it any more.`}
      confirm="Delete variable"
      destructive
      busy={write.pending}
      error={write.error}
      onConfirm={write.go}
      close={cancel}
    >
      {cell.level !== "environment" && (
        <Callout tone="warn">Every environment that gets it from there loses it too.</Callout>
      )}
    </Dialog>
  );
}

/** The narrowest level first, so the one that reaches the most environments is the last to go. */
const LEVELS: Level[] = ["environment", "project", "organization"];

/**
 * Deletes the variables chosen in the list: one bulk call for each level they are at. That is not atomic across
 * levels: at the first refusal it stops, keeps what went, says so and is left holding only what did not, so a retry
 * makes just those calls.
 */
function BulkDelete({
  orgId,
  projectId,
  cells,
  env,
  reload,
  done,
  cancel,
}: {
  orgId: string;
  projectId: string;
  cells: Cell[];
  env: Env;
  reload: () => Promise<void>;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const client = useClient();
  const toast = useToast();
  const [rest, setRest] = useState(cells);
  const write = useWrite(
    async () => {
      const gone: string[] = [];
      for (const level of LEVELS) {
        const here = rest.filter((c) => c.level === level);
        if (here.length === 0) continue;
        try {
          await call(() =>
            variablesAt(client, orgId, projectId, level, env.id).bulk.post({
              ops: here.map(({ key }) => ({ op: "delete" as const, key })),
              dryRun: false,
            }),
          );
        } catch (e) {
          if (gone.length === 0) throw e;
          const left = rest.filter((c) => !gone.includes(c.key)).map((c) => c.key);
          setRest((r) => r.filter((c) => !gone.includes(c.key)));
          await reload();
          const verb = (keys: string[]) => (keys.length === 1 ? "was" : "were");
          throw new Error(
            `${gone.join(", ")} ${verb(gone)} deleted; ${left.join(", ")} ${verb(left)} not: ${e instanceof Error ? e.message : "that did not work"}`,
          );
        }
        gone.push(...here.map((c) => c.key));
      }
    },
    async () => {
      await done();
      toast(`Deleted ${cells.length} ${cells.length === 1 ? "variable" : "variables"}.`);
    },
  );
  return (
    <Dialog
      title={`Delete ${cells.length} ${cells.length === 1 ? "variable" : "variables"}`}
      sub="Their history is kept, but nothing uses them any more."
      confirm="Delete variables"
      destructive
      busy={write.pending}
      error={write.error}
      onConfirm={write.go}
      close={cancel}
    >
      <ul>
        {rest.map((c) => (
          <li key={c.key}>
            <code>{c.key}</code> from {SOURCE[c.level]}
          </li>
        ))}
      </ul>
      {rest.some((c) => c.level !== "environment") && (
        <Callout tone="warn">
          Every environment that gets one from the project or the organization loses it too.
        </Callout>
      )}
    </Dialog>
  );
}

/** The form or screen a row's action opens: the matrix and the list open the same ones. */
function PanelView({
  panel,
  orgId,
  projectId,
  envs,
  folder = ROOT,
  revealMs,
  refresh,
  finish,
  reload,
  close,
}: {
  panel: Panel;
  orgId: string;
  projectId: string;
  envs: Env[];
  /** The open folder: where a new variable or an import goes, and the folder a history or rotation names. */
  folder?: string;
  revealMs: number;
  refresh: () => Promise<void>;
  /** Where an answer that reports by toast ends: the drawer is closed too, since the toast sits under it. */
  finish: () => Promise<void>;
  reload: () => Promise<void>;
  close: () => void;
}) {
  switch (panel.kind) {
    case "add":
      return (
        <AddVariable
          key={`${panel.key}:${panel.scope}`}
          orgId={orgId}
          projectId={projectId}
          envs={envs}
          folder={folder}
          initial={panel}
          done={refresh}
          reload={reload}
          cancel={close}
        />
      );
    case "edit":
      return (
        <EditVariable
          key={panel.cell.id}
          orgId={orgId}
          projectId={projectId}
          cell={panel.cell}
          env={panel.env}
          done={finish}
          cancel={close}
        />
      );
    case "describe":
      return (
        <DescribeVariable
          key={panel.cell.id}
          orgId={orgId}
          projectId={projectId}
          cell={panel.cell}
          env={panel.env}
          description={panel.description}
          tags={panel.tags}
          done={refresh}
          cancel={close}
        />
      );
    case "move":
      return (
        <MoveVariable
          key={panel.cell.id}
          orgId={orgId}
          projectId={projectId}
          cell={panel.cell}
          env={panel.env}
          folder={folder}
          done={refresh}
          cancel={close}
        />
      );
    case "delete":
      return (
        <DeleteVariable
          key={panel.cell.id}
          orgId={orgId}
          projectId={projectId}
          cell={panel.cell}
          env={panel.env}
          done={finish}
          cancel={close}
        />
      );
    case "history":
      return (
        <History
          key={panel.cell.id}
          orgId={orgId}
          projectId={projectId}
          cell={panel.cell}
          env={panel.env}
          folder={folder}
          revealMs={revealMs}
          done={refresh}
        />
      );
    case "rotation":
      return (
        <Rotation
          key={panel.cell.id}
          orgId={orgId}
          projectId={projectId}
          cell={panel.cell}
          env={panel.env}
          folder={folder}
          changed={reload}
        />
      );
    case "bulk":
      return (
        <BulkDelete
          orgId={orgId}
          projectId={projectId}
          cells={panel.cells}
          env={panel.env}
          reload={reload}
          done={finish}
          cancel={close}
        />
      );
    case "import":
      return (
        <Import
          orgId={orgId}
          projectId={projectId}
          envs={envs}
          folder={folder}
          reload={reload}
          close={close}
        />
      );
    case "folder":
      return (
        <AddFolder
          orgId={orgId}
          projectId={projectId}
          parent={panel.parent}
          done={refresh}
          cancel={close}
        />
      );
    case "folder-rename":
      return (
        <RenameFolder
          key={panel.folder.id}
          orgId={orgId}
          projectId={projectId}
          folder={panel.folder}
          done={refresh}
          cancel={close}
        />
      );
    case "folder-delete":
      return (
        <DeleteFolder
          key={panel.folder.id}
          orgId={orgId}
          projectId={projectId}
          folder={panel.folder}
          done={refresh}
          cancel={close}
        />
      );
  }
}

/** What an environment holds of a key: a green tick where it is set, a yellow circle where it is not, a cross where it does not resolve. The picture is for the eye, the words beside it for the rest. */
function Mark({ state, words }: { state: "set" | "missing" | "broken"; words: string }) {
  return (
    <span className={`cell-mark ${state}`} title={words}>
      <Icon name={state === "set" ? "tick" : state === "missing" ? "circle" : "close"} />
      <span className="words">{words}</span>
    </span>
  );
}

/** Where a value comes from, as its tag says it: set here, or passed down, and what it overrides. */
const sourceOf = (cell: Cell, overrides: Level | undefined) =>
  cell.level === "environment"
    ? overrides
      ? `Overrides ${overrides}`
      : "Set here"
    : `From ${cell.level}${overrides ? `, overrides ${overrides}` : ""}`;

/** Whether a row passes the search and the tag: a key, a plain value or a tag may hold the text (a secret's value is not in the page, so it is not searched). */
const found = (key: string, v: Cell | undefined, text: string, tag: string) =>
  (!tag || !!v?.tags.includes(tag)) &&
  (key.toLowerCase().includes(text) ||
    (v?.kind === "plain" && (v.value ?? "").toLowerCase().includes(text)) ||
    !!v?.tags.some((t) => t.includes(text)));

/** The search, the tag filter (only when something is tagged) and Add New of the list and of the matrix; `extra` sits before Add New. */
function Toolbar({
  filters: { find, setFind, setTag },
  tagNames,
  active,
  extra,
  onAdd,
  onImport,
}: {
  filters: Filters;
  tagNames: string[];
  active: string;
  extra?: ReactNode;
  onAdd: () => void;
  onImport: () => void;
}) {
  return (
    <div className="toolbar">
      <div className="search">
        <Icon name="search" />
        <input
          type="search"
          aria-label="Search variables"
          placeholder="Search variables"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
      </div>
      {tagNames.length > 0 && (
        <select aria-label="Tag" value={active} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {tagNames.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}
      {extra}
      <RowMenu
        labelled
        label="Add New"
        items={[
          { label: "Add a variable", run: onAdd },
          { label: "Import variables", run: onImport },
        ]}
      />
    </div>
  );
}

/** An environment's values (those of one folder, the root unless asked) from the audited export route; a refusal comes back as words. */
const valuesOf = async (
  client: Client,
  orgId: string,
  projectId: string,
  envId: string,
  verb: string,
  folder = ROOT,
) => {
  try {
    return await call(() =>
      client
        .organizations({ orgId })
        .projects({ projectId })
        .environments({ envId })
        ["resolved-variables"].values.get({ query: inFolder(folder) }),
    );
  } catch (e) {
    throw e instanceof ApiError && e.status === 403
      ? new Error(`You cannot ${verb} values here`)
      : e;
  }
};

/** The values as one .env file handed to the browser, nothing kept: the page's note, or why there is no file. */
function saveDotenv(
  read: Awaited<ReturnType<typeof valuesOf>>,
  projectName: string,
  slug: string | undefined,
): { note: string } | { problem: string } {
  const bad = read.variables.find((v) => v.value.includes("\0"));
  if (bad) return { problem: `${bad.key} holds a NUL character, which a .env file cannot carry` };
  const text = read.variables
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((v) => `${dotenvLine(v)}\n`)
    .join("");
  const file = `${projectName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "variables"}-${slug}.env`;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  const held = read.variables.filter((v) => v.kind !== "plain").length;
  const lost = read.issues.length;
  return {
    note: `Downloaded ${file}: ${read.variables.length} variable${read.variables.length === 1 ? "" : "s"}, including ${held} secret or file value${held === 1 ? "" : "s"}${lost ? `; ${lost} did not resolve and ${lost === 1 ? "is" : "are"} not in it` : ""}.`,
  };
}

function Grid({
  orgId,
  projectId,
  projectName,
  envs,
  revealMs,
  filters,
  folder,
  setFolder,
}: {
  orgId: string;
  projectId: string;
  projectName: string;
  envs: Env[];
  revealMs: number;
  filters: Filters;
  /** The open folder, held with the environments by the page: the matrix shows that folder of each of them. */
  folder: string;
  setFolder: (folder: string) => void;
}) {
  const client = useClient();
  const [panel, setPanel] = useState<Panel>();
  // the keys whose row is open (several can be), and the one line whose details are in the drawer
  const [expanded, setExpanded] = useState<string[]>([]);
  const [openAt, setOpenAt] = useState<{ key: string; envId: string }>();
  const [refused, setRefused] = useState<string>();
  const [note, setNote] = useState<string>();
  // the environment whose changes feed is open in its drawer
  const [changes, setChanges] = useState<Env>();
  const copied = useRef<ReturnType<typeof setTimeout>>(undefined);
  // an answer that arrives after the page is gone (the list chosen, another page) saves no file
  const asked = useRef(0);
  useEffect(
    () => () => {
      clearTimeout(copied.current);
      asked.current += 1;
    },
    [],
  );
  const { reload, epoch } = useReload(orgId);
  const sets = useQueries({
    queries: envs.map((env) => resolvedOf(client, orgId, projectId, env.id, folder)),
  });
  const { lower, pending } = useLower(orgId, projectId, folder);
  const failed = sets.find((s) => s.error);
  const folders = useOpenFolder(orgId, projectId, folder, setFolder, failed?.error);
  const inside = childrenOf(folders.data ?? [], folder);
  if (failed?.error) {
    return <ErrorPanel error={failed.error} retry={() => sets.forEach((s) => void s.refetch())} />;
  }
  // the marks come from the key lists: wait for them, so no mark shows and then changes
  if (sets.some((s) => s.data === undefined) || pending) {
    return <Loading what="Loading variables" />;
  }

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
  const cellAt = (key: string, i: number) => sets[i]?.data?.variables.find((v) => v.key === key);
  // the tags of every environment shown; a chosen tag that none has any more reads as All tags
  const tagNames = [
    ...new Set(sets.flatMap((s) => (s.data?.variables ?? []).flatMap((v) => v.tags))),
  ].sort();
  const active = tagNames.includes(filters.tag) ? filters.tag : "";
  const text = filters.find.trim().toLowerCase();
  // a key stays while one environment's variable (or its failure to resolve) passes the search and the tag, as in the list
  const shownKeys = keys.filter((key) =>
    envs.some((_, i) => {
      const v = cellAt(key, i);
      return (v || sets[i]?.data?.issues.some((x) => x.key === key)) && found(key, v, text, active);
    }),
  );
  // the open line is read from the lists as they are now, so an edit or a delete shows in the details at once
  const detailsEnv = envs.find((e) => e.id === openAt?.envId);
  const open = openAt && detailsEnv ? cellAt(openAt.key, envs.indexOf(detailsEnv)) : undefined;
  const pick = (key: string, env: Env) => {
    setOpenAt({ key, envId: env.id });
    setPanel(undefined);
  };
  const closeDrawer = () => {
    setOpenAt(undefined);
    setPanel(undefined);
  };
  /** A line's own action: its panel in the drawer, and the details of another line (if open) out of the way. */
  const act = (cell: Cell, at: Env, next: Panel) => {
    setOpenAt((o) => (o?.key === cell.key && o.envId === at.id ? o : undefined));
    setPanel(next);
  };
  /** The value onto the clipboard, never into the page; a secret's is one audited read. */
  const copy = async (cell: Cell, at: Env) => {
    clearTimeout(copied.current);
    setRefused(undefined);
    setNote(undefined);
    const problem = await copyOf(client, orgId, projectId, cell, at);
    if (problem) {
      setRefused(problem);
      return;
    }
    setNote(`Copied the value of ${cell.key}`);
    copied.current = setTimeout(() => setNote(undefined), COPIED_MS);
  };
  const describeLine = async (cell: Cell, at: Env) => {
    setRefused(undefined);
    try {
      act(cell, at, await describeOf(client, orgId, projectId, cell, at));
    } catch (e) {
      setRefused(e instanceof Error ? e.message : "Could not read the variable.");
    }
  };
  const menuOf = (cell: Cell, at: Env) =>
    menuItems(cell, at, {
      details: () => pick(cell.key, at),
      tags: () => void describeLine(cell, at),
      open: (next) => act(cell, at, next),
      copy: () => void copy(cell, at),
    });
  const copySlug = async (env: Env) => {
    clearTimeout(copied.current);
    setRefused(undefined);
    setNote(undefined);
    const problem = await toClipboard(async () => env.slug);
    if (problem) {
      setRefused(problem);
      return;
    }
    setNote(`Copied the slug of ${env.name}`);
    copied.current = setTimeout(() => setNote(undefined), COPIED_MS);
  };
  const downloadEnv = async (env: Env) => {
    clearTimeout(copied.current);
    const turn = ++asked.current;
    setRefused(undefined);
    setNote(undefined);
    try {
      const read = await valuesOf(client, orgId, projectId, env.id, "download", folder);
      if (turn !== asked.current) return;
      const saved = saveDotenv(read, projectName, env.slug);
      if ("problem" in saved) setRefused(saved.problem);
      else setNote(saved.note);
    } catch (e) {
      if (turn === asked.current)
        setRefused(e instanceof Error ? e.message : "Could not read the values.");
    }
  };
  const columnMenu = (env: Env) => [
    { label: "Copy environment slug", run: () => void copySlug(env) },
    { label: "Download .env", run: () => void downloadEnv(env) },
    {
      label: "View changes",
      run: () => {
        closeDrawer();
        setChanges(env);
      },
    },
  ];
  const toggle = (key: string) =>
    setExpanded((now) => (now.includes(key) ? now.filter((k) => k !== key) : [...now, key]));
  const inDrawer = drawerPanel(panel);
  const titled = inDrawer
    ? panelTitle(inDrawer)
    : open && detailsEnv
      ? drawerTitle(open, detailsEnv)
      : undefined;
  // an answer that reports by toast leaves nothing open: the toast sits under the drawer
  const finish = async () => {
    await reload();
    closeDrawer();
  };
  const view = panel && (
    <PanelView
      panel={panel}
      orgId={orgId}
      projectId={projectId}
      envs={envs}
      folder={folder}
      revealMs={revealMs}
      refresh={refresh}
      finish={finish}
      reload={reload}
      close={() => setPanel(undefined)}
    />
  );

  return (
    <div className="stack wide">
      <Card title="Variables by environment">
        <Toolbar
          filters={filters}
          tagNames={tagNames}
          active={active}
          onAdd={() => setPanel({ kind: "add" })}
          onImport={() => setPanel({ kind: "import" })}
        />
        {/* the root stands for the environments shown, as the environment does in the list */}
        <div className="strip">
          <Crumbs
            projectName={projectName}
            envName={envs.map((e) => e.name).join(", ")}
            folder={folder}
            go={setFolder}
          />
        </div>
        {refused && (
          <p role="alert" className="error">
            {refused}
          </p>
        )}
        {note && <p role="status">{note}</p>}
        <FolderRows
          folder={folder}
          folders={inside}
          open={setFolder}
          rename={(f) => setPanel({ kind: "folder-rename", folder: f })}
          remove={(f) => setPanel({ kind: "folder-delete", folder: f })}
        />
        {keys.length === 0 ? (
          <p>
            {folder === ROOT
              ? "No variables yet. Add the first one below."
              : "No variables in this folder"}
          </p>
        ) : shownKeys.length === 0 ? (
          <p>No variables match “{filters.find.trim()}”.</p>
        ) : (
          <>
            <div className="matrix">
              <table>
                <caption className="visually-hidden">Variables by environment</caption>
                <thead>
                  <tr>
                    <th scope="col">Variable</th>
                    {envs.map((e) => (
                      <th key={e.id} scope="col">
                        <span className="col-head">
                          {e.name}
                          <RowMenu label={`Options for ${e.name}`} items={columnMenu(e)} />
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shownKeys.map((key) => {
                    const shown = expanded.includes(key);
                    return (
                      <Fragment key={key}>
                        <tr>
                          <th scope="row">
                            <button
                              type="button"
                              className="quiet key-toggle"
                              aria-expanded={shown}
                              onClick={() => toggle(key)}
                            >
                              <span className="chev">
                                <Icon name="down" />
                              </span>
                              <code>{key}</code>
                            </button>
                          </th>
                          {envs.map((env, i) => {
                            const cell = cellAt(key, i);
                            const issue = sets[i]?.data?.issues.find((x) => x.key === key);
                            return (
                              <td key={env.id}>
                                {cell ? (
                                  <button
                                    type="button"
                                    className="mx-cell"
                                    aria-label={`${key} in ${env.name}: ${cell.level === "environment" ? "Set here" : `From ${cell.level}`}`}
                                    onClick={() => pick(key, env)}
                                  >
                                    <Mark
                                      state="set"
                                      words={
                                        cell.level === "environment"
                                          ? "Set here"
                                          : `From ${cell.level}`
                                      }
                                    />
                                  </button>
                                ) : issue ? (
                                  <Mark
                                    state="broken"
                                    words={`Does not resolve: ${ISSUES[issue.code] ?? issue.code}`}
                                  />
                                ) : (
                                  <button
                                    type="button"
                                    className="mx-cell not-set"
                                    aria-label={`Set ${key} in ${env.name}: Not set`}
                                    onClick={() => setPanel({ kind: "add", key, scope: env.id })}
                                  >
                                    <Mark state="missing" words="Not set" />
                                  </button>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                        {shown && (
                          <tr className="env-open">
                            <td colSpan={envs.length + 1}>
                              <ul className="env-rows" aria-label={`${key} by environment`}>
                                {envs.map((env, i) => {
                                  const cell = cellAt(key, i);
                                  const issue = sets[i]?.data?.issues.find((x) => x.key === key);
                                  const label = `${key} in ${env.name}`;
                                  return (
                                    <li key={env.id} className="env-line">
                                      <span className="env-name">{env.name}</span>
                                      {cell ? (
                                        <>
                                          <button
                                            type="button"
                                            className="quiet env-value"
                                            aria-label={label}
                                            onClick={() => pick(key, env)}
                                          >
                                            {cell.kind === "plain" ? (
                                              <code>{cell.value || "(empty)"}</code>
                                            ) : (
                                              <Hidden />
                                            )}
                                          </button>
                                          <span className="tags">
                                            <span className="tag">
                                              {sourceOf(cell, lower(cell))}
                                            </span>
                                            {cell.kind !== "plain" && (
                                              <span className="tag">{cell.kind}</span>
                                            )}
                                            {cell.tainted && (
                                              <span className="tag">reads a secret</span>
                                            )}
                                          </span>
                                          <span className="line-actions">
                                            <button
                                              type="button"
                                              className="icon quiet"
                                              aria-label={`Edit value of ${label}`}
                                              title={`Edit value of ${label}`}
                                              onClick={() =>
                                                act(cell, env, { kind: "edit", cell, env })
                                              }
                                            >
                                              <Icon name="edit" />
                                            </button>
                                            <button
                                              type="button"
                                              className="icon quiet"
                                              aria-label={`Copy value of ${label}`}
                                              title={`Copy value of ${label}`}
                                              onClick={() => void copy(cell, env)}
                                            >
                                              <Icon name="copy" />
                                            </button>
                                            <RowMenu
                                              label={`More actions for ${label}`}
                                              items={menuOf(cell, env)}
                                            />
                                          </span>
                                        </>
                                      ) : issue ? (
                                        <span className="error">
                                          Does not resolve: {ISSUES[issue.code] ?? issue.code}
                                        </span>
                                      ) : (
                                        <>
                                          <span className="muted">Not set</span>
                                          <button
                                            type="button"
                                            className="small"
                                            aria-label={`Set ${label}`}
                                            onClick={() =>
                                              setPanel({ kind: "add", key, scope: env.id })
                                            }
                                          >
                                            Set
                                          </button>
                                        </>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted">
              {text || active ? `${shownKeys.length} of ${keys.length}` : keys.length}{" "}
              {keys.length === 1 ? "variable" : "variables"}
            </p>
          </>
        )}
        {/* keyed by the environments shown, so a half-typed secret is not carried into another set of them */}
        <QuickAdd
          key={envs.map((e) => e.id).join()}
          orgId={orgId}
          projectId={projectId}
          envs={envs}
          folder={folder}
          done={reload}
        />
      </Card>
      {titled && (
        <Drawer title={titled} sub={panelSub(inDrawer)} close={closeDrawer}>
          {open && detailsEnv && (
            <Details
              key={`${open.id}:${epoch}`}
              orgId={orgId}
              projectId={projectId}
              cell={open}
              env={detailsEnv}
              overrides={lower(open)}
              revealMs={revealMs}
              act={{
                describe: (description, tags) =>
                  setPanel({ kind: "describe", cell: open, env: detailsEnv, description, tags }),
                edit: () => setPanel({ kind: "edit", cell: open, env: detailsEnv }),
                // the form for an override is a drawer of its own: this one goes
                override: () => {
                  closeDrawer();
                  setPanel({ kind: "add", key: open.key, scope: detailsEnv.id });
                },
                move: () => setPanel({ kind: "move", cell: open, env: detailsEnv }),
                history: () => setPanel({ kind: "history", cell: open, env: detailsEnv }),
                rotation: () => setPanel({ kind: "rotation", cell: open, env: detailsEnv }),
                remove: () => setPanel({ kind: "delete", cell: open, env: detailsEnv }),
              }}
            />
          )}
          {inDrawer && view}
        </Drawer>
      )}
      {panel && !inDrawer && view}
      {changes && (
        <Drawer title={`Changes in ${changes.name}`} close={() => setChanges(undefined)}>
          <Changes
            orgId={orgId}
            projectId={projectId}
            envId={changes.id}
            opens={(key, at) => at === folder && !!cellAt(key, envs.indexOf(changes))}
            // the details open in the drawer that takes this one's place
            open={(key) => {
              setChanges(undefined);
              pick(key, changes);
            }}
          />
        </Drawer>
      )}
    </div>
  );
}

interface Issue {
  code: string;
  key: string;
  ref?: string | undefined;
  path?: string[] | undefined;
}
/** A row of the list: a variable the environment sees, or a key that could not be filled in. */
interface Row {
  key: string;
  v?: Cell;
  issue?: Issue;
}

/** The search and the tag of the list, held above it: ticking a second environment and unticking the first goes through the matrix, which must not lose them. */
type Filters = {
  find: string;
  setFind: (find: string) => void;
  tag: string;
  setTag: (tag: string) => void;
};

/** One environment's variables as a list: name, value (a mask unless plain) and the level it comes from. */
function Secrets({
  orgId,
  projectId,
  projectName,
  envs,
  envId,
  folder,
  setFolder,
  revealMs,
  filters,
}: {
  orgId: string;
  projectId: string;
  projectName: string;
  envs: Env[];
  envId: string;
  /** The open folder, held with the environment by the page, so another project starts at the root. */
  folder: string;
  setFolder: (folder: string) => void;
  revealMs: number;
  filters: Filters;
}) {
  const client = useClient();
  const { find, tag } = filters;
  const set = useQuery(resolvedOf(client, orgId, projectId, envId, folder));
  const folders = useOpenFolder(orgId, projectId, folder, setFolder, set.error);
  const inside = childrenOf(folders.data ?? [], folder);
  const [openKey, setOpenKey] = useState<string>();
  const [panel, setPanel] = useState<Panel>();
  // the changes feed is read when its drawer is open, not before
  const [changes, setChanges] = useState(false);
  // the keys ticked for Delete selected; shortcut: access lists organization-level actions only, so the boxes are
  // for an organization admin (who may delete at every level); upgrade when it lists a project's
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const canSelect = !!useAccess(orgId).data?.actions.includes("variable.org.delete");
  const { reload, epoch } = useReload(orgId);
  const { lower } = useLower(orgId, projectId, folder);
  const env = envs.find((e) => e.id === envId);
  const name = env?.name ?? "";
  // Reveal all and Download .env: every value of the environment, read from the audited export route
  // and held here and nowhere else (not in the query cache). Reveal all drops them on a timeout, Hide
  // all, another environment, another project (the page is keyed by it) and unmount; a download keeps
  // nothing. `asked` makes an answer that arrives after any of those land nowhere.
  const [shown, setShown] = useState<Map<string, string>>();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  const [note, setNote] = useState<string>();
  const asked = useRef(0);
  const copied = useRef<ReturnType<typeof setTimeout>>(undefined);
  // the "Copied" note goes by itself; a later note or an unmount must not be cut short by (or leave) its timer.
  // An unmount (the matrix ticked, another page) also makes an answer still on its way land nowhere: no file is saved for it
  useEffect(
    () => () => {
      clearTimeout(copied.current);
      asked.current += 1;
    },
    [],
  );
  const hide = () => {
    asked.current += 1;
    clearTimeout(copied.current);
    setShown(undefined);
    setBusy(false);
    setRefused(undefined);
    setNote(undefined);
  };
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(undefined), revealMs);
    return () => clearTimeout(timer);
  }, [shown, revealMs]);
  /** The values, or nothing when the read was refused, failed or is no longer wanted. */
  const readAll = async (verb: string) => {
    const turn = ++asked.current;
    clearTimeout(copied.current);
    setBusy(true);
    setRefused(undefined);
    setNote(undefined);
    try {
      const read = await valuesOf(client, orgId, projectId, envId, verb, folder);
      return turn === asked.current ? read : undefined;
    } catch (e) {
      if (turn === asked.current)
        setRefused(e instanceof Error ? e.message : "Could not read the values.");
    } finally {
      if (turn === asked.current) setBusy(false);
    }
  };
  const revealAll = async () => {
    const read = await readAll("reveal");
    if (read) setShown(new Map(read.variables.map((v) => [v.key, v.value])));
  };
  const download = async () => {
    const read = await readAll("download");
    if (!read) return;
    const saved = saveDotenv(read, projectName, env?.slug);
    if ("problem" in saved) setRefused(saved.problem);
    else setNote(saved.note);
  };
  /**
   * A variable's value onto the clipboard, never into the page: a secret's is read from the audited route (one
   * `variable.reveal` row) and goes from there to the clipboard; a plain value is already in the list.
   */
  const copyValue = async (cell: Cell, at: Env) => {
    clearTimeout(copied.current);
    setRefused(undefined);
    setNote(undefined);
    const problem = await copyOf(client, orgId, projectId, cell, at);
    if (problem) {
      setRefused(problem);
      return;
    }
    setNote(`Copied the value of ${cell.key}`);
    copied.current = setTimeout(() => setNote(undefined), COPIED_MS);
  };
  /** A row's own action: its panel in the drawer, and the details of another row (if open) out of the way. */
  const act = (key: string, next: Panel) => {
    setOpenKey((k) => (k === key ? k : undefined));
    setPanel(next);
  };
  // the list has no description, so the form for it reads the variable first
  const describeRow = async (cell: Cell, at: Env) => {
    setRefused(undefined);
    try {
      act(cell.key, await describeOf(client, orgId, projectId, cell, at));
    } catch (e) {
      setRefused(e instanceof Error ? e.message : "Could not read the variable.");
    }
  };
  const menuOf = (v: Cell, at: Env) =>
    menuItems(v, at, {
      details: () => pick(v.key),
      tags: () => void describeRow(v, at),
      open: (next) => act(v.key, next),
      copy: () => void copyValue(v, at),
    });
  // the open row is read from the list as it is now, so an edit or a delete shows in the details at once
  const open = set.data?.variables.find((v) => v.key === openKey);
  const pick = (key: string | undefined) => {
    setOpenKey(key);
    setPanel(undefined);
  };
  /** Re-reads the list and hides what was revealed, which a write may have made out of date; an open panel stays. */
  const renew = async () => {
    hide();
    await reload();
  };
  const refresh = async () => {
    // a write made the values held here out of date: hide them, and drop a read still on its way
    await renew();
    setPanel(undefined);
  };
  // a key that cannot be filled in is not among the variables: its row comes from the issues, one per key
  // (a loop is reported once, with every key of the ring in its path)
  const failing = new Map<string, Issue>();
  for (const i of set.data?.issues ?? [])
    for (const key of i.code === "cycle" ? (i.path ?? [i.key]) : [i.key])
      if (!failing.has(key)) failing.set(key, { ...i, key });
  const all: Row[] = [
    ...(set.data?.variables ?? []).map((v) => ({ key: v.key, v })),
    ...[...failing.values()].map((issue) => ({ key: issue.key, issue })),
  ].sort((a, b) => a.key.localeCompare(b.key));
  // the tags the environment's variables carry; a chosen tag that no longer is one reads as All tags
  const tagNames = [...new Set((set.data?.variables ?? []).flatMap((v) => v.tags))].sort();
  const active = tagNames.includes(tag) ? tag : "";
  // a secret's value is not in the page, so it is not searched
  const text = find.trim().toLowerCase();
  const rows = all.filter(({ key, v }) => found(key, v, text, active));
  // a choice is of the rows shown (a search that hides one leaves it out of the count and the delete); a key the
  // list no longer has (it was deleted) is let go
  const here = rows.flatMap(({ v }) => (v ? [v] : []));
  const chosen = here.filter((v) => picked.has(v.key));
  useEffect(() => {
    const now = new Set(set.data?.variables.map((v) => v.key));
    setPicked((p) =>
      [...p].every((k) => now.has(k)) ? p : new Set([...p].filter((k) => now.has(k))),
    );
  }, [set.data]);
  const tick = (key: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const tickAll = () =>
    setPicked((p) => {
      const next = new Set(p);
      for (const { key } of here) {
        if (chosen.length === here.length) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  // the new-variable form, an import, a row's own panels and its details are all in a drawer
  const inDrawer = drawerPanel(panel);
  const titled = inDrawer ? panelTitle(inDrawer) : open && env ? drawerTitle(open, env) : undefined;
  // an answer that reports by toast leaves nothing open: the toast sits under the drawer
  const finish = async () => {
    await renew();
    pick(undefined);
  };
  const view = panel && (
    <PanelView
      panel={panel}
      orgId={orgId}
      projectId={projectId}
      envs={envs}
      folder={folder}
      revealMs={revealMs}
      refresh={refresh}
      finish={finish}
      reload={renew}
      close={() => setPanel(undefined)}
    />
  );
  return (
    <div className="stack wide">
      <Card title={`Variables in ${name}`}>
        <Toolbar
          filters={filters}
          tagNames={tagNames}
          active={active}
          extra={
            <button
              type="button"
              className="quiet"
              title="Download .env"
              disabled={busy}
              onClick={() => void download()}
            >
              <Icon name="download" />
              Download .env
            </button>
          }
          onAdd={() => setPanel({ kind: "add", scope: envId })}
          onImport={() => setPanel({ kind: "import" })}
        />
        {/* the path reads left to right: the project, the environment, then each folder down */}
        <div className="strip">
          <Crumbs projectName={projectName} envName={name} folder={folder} go={setFolder} />
          <div className="row">
            <button type="button" onClick={() => setPanel({ kind: "folder", parent: folder })}>
              Add folder
            </button>
            <button type="button" onClick={() => setChanges(true)}>
              Changes
            </button>
            <button type="button" disabled={busy} onClick={shown ? hide : () => void revealAll()}>
              {shown ? "Hide all" : "Reveal all"}
            </button>
          </div>
        </div>
        <p className="muted">
          Reveal all and Download .env show or write every value of {name}
          {folder !== ROOT && ` in ${folder}`}, secrets included.
        </p>
        {refused && (
          <p role="alert" className="error">
            {refused}
          </p>
        )}
        {note && <p role="status">{note}</p>}
        {canSelect && env && chosen.length > 0 && (
          <fieldset className="strip bare" aria-label="Selected variables">
            <span>{chosen.length} selected</span>
            <button
              type="button"
              className="danger"
              onClick={() => setPanel({ kind: "bulk", cells: chosen, env })}
            >
              Delete selected
            </button>
          </fieldset>
        )}
        <FolderRows
          folder={folder}
          folders={inside}
          open={setFolder}
          rename={(f) => setPanel({ kind: "folder-rename", folder: f })}
          remove={(f) => setPanel({ kind: "folder-delete", folder: f })}
        />
        {set.error ? (
          <ErrorPanel error={set.error} retry={() => void set.refetch()} />
        ) : !set.data ? (
          <Loading what="Loading variables" />
        ) : all.length === 0 ? (
          <p>{folder === ROOT ? `No variables in ${name} yet.` : "No variables in this folder"}</p>
        ) : rows.length === 0 ? (
          <p>No variables match “{find.trim()}”.</p>
        ) : (
          <>
            <div className="scroll">
              <table>
                <caption className="visually-hidden">Variables in {name}</caption>
                <thead>
                  <tr>
                    {canSelect && (
                      <th scope="col" className="select">
                        <input
                          type="checkbox"
                          aria-label="Select all variables"
                          checked={here.length > 0 && chosen.length === here.length}
                          ref={(box) => {
                            if (box)
                              box.indeterminate = chosen.length > 0 && chosen.length < here.length;
                          }}
                          onChange={tickAll}
                        />
                      </th>
                    )}
                    <th scope="col">
                      <span className="key-mark" aria-hidden="true" />
                      Name
                    </th>
                    <th scope="col">Value</th>
                    <th scope="col">Source</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ key, v, issue }) => (
                    <tr key={key}>
                      {canSelect && (
                        <td className="select">
                          {v && (
                            <input
                              type="checkbox"
                              aria-label={`Select ${key}`}
                              checked={picked.has(key)}
                              onChange={() => tick(key)}
                            />
                          )}
                        </td>
                      )}
                      <th scope="row">
                        {/* the mark beside the button, not in it, so the name keeps the baseline the tags sit on; every row has the slot, one that does not resolve too, so names line up; the value cell already says "Hidden value", so the mark is for the eye alone; mark and name are one unit, so a narrow column wraps the tags and not the name from its mark */}
                        <span className="key-name">
                          <span
                            className="key-mark"
                            title={v?.kind === "secret" ? "Secret" : undefined}
                            aria-hidden="true"
                          >
                            {v?.kind === "secret" && <Icon name="key" />}
                          </span>
                          {v ? (
                            <button type="button" className="quiet" onClick={() => pick(key)}>
                              <code>{key}</code>
                            </button>
                          ) : (
                            <code>{key}</code>
                          )}
                        </span>
                        {v && v.tags.length > 0 && (
                          <span className="tags">
                            {v.tags.map((t) => (
                              <span key={t} className="tag">
                                {t}
                              </span>
                            ))}
                          </span>
                        )}
                      </th>
                      <td>
                        {v ? (
                          v.kind === "plain" ? (
                            <code>{v.value || "(empty)"}</code>
                          ) : shown?.has(key) ? (
                            <code className="revealed">{shown.get(key)}</code>
                          ) : (
                            <Hidden />
                          )
                        ) : (
                          <span className="error">
                            Does not resolve: {ISSUES[issue?.code ?? ""] ?? issue?.code}
                            {issue?.ref && (
                              <>
                                {" "}
                                (<mark>{`\${${issue.ref}}`}</mark>)
                              </>
                            )}
                          </span>
                        )}
                      </td>
                      <td>
                        {v ? (
                          <span className="tag">{LEVEL_NAME[v.level]}</span>
                        ) : (
                          <span className="muted">Unknown</span>
                        )}
                      </td>
                      <td className="row-actions">
                        {v && env && (
                          <>
                            <button
                              type="button"
                              className="quiet"
                              aria-label={`Edit ${key}`}
                              onClick={() => act(key, { kind: "edit", cell: v, env })}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="icon quiet"
                              aria-label={`Copy value of ${key}`}
                              title={`Copy value of ${key}`}
                              onClick={() => void copyValue(v, env)}
                            >
                              <Icon name="copy" />
                            </button>
                            <RowMenu label={`More actions for ${key}`} items={menuOf(v, env)} />
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* shortcut: the list is not paged (the resolved route answers every variable), so the foot is a count only */}
            <p className="muted">
              {text || active ? `${rows.length} of ${all.length}` : rows.length}{" "}
              {all.length === 1 ? "variable" : "variables"}
            </p>
          </>
        )}
        {/* keyed by the environment so a half-typed secret is not carried into another; a write hides what was revealed (it is out of date) but leaves an open panel alone */}
        {env && set.data && (
          <QuickAdd
            key={env.id}
            orgId={orgId}
            projectId={projectId}
            envs={[env]}
            folder={folder}
            done={renew}
          />
        )}
      </Card>
      {titled && env && (
        <Drawer title={titled} sub={panelSub(inDrawer)} close={() => pick(undefined)}>
          {open && (
            <Details
              key={`${open.id}:${epoch}`}
              orgId={orgId}
              projectId={projectId}
              cell={open}
              env={env}
              overrides={lower(open)}
              revealMs={revealMs}
              shown={shown?.get(open.key)}
              act={{
                describe: (description, tags) =>
                  setPanel({ kind: "describe", cell: open, env, description, tags }),
                edit: () => setPanel({ kind: "edit", cell: open, env }),
                // the form for an override is a drawer of its own: this one goes
                override: () => {
                  pick(undefined);
                  setPanel({ kind: "add", key: open.key, scope: env.id });
                },
                move: () => setPanel({ kind: "move", cell: open, env }),
                history: () => setPanel({ kind: "history", cell: open, env }),
                rotation: () => setPanel({ kind: "rotation", cell: open, env }),
                remove: () => setPanel({ kind: "delete", cell: open, env }),
              }}
            />
          )}
          {inDrawer && view}
        </Drawer>
      )}
      {panel && !inDrawer && view}
      {changes && env && (
        <Drawer title={`Changes in ${name}`} close={() => setChanges(false)}>
          <Changes
            orgId={orgId}
            projectId={projectId}
            envId={envId}
            opens={(key, at) => at === folder && !!set.data?.variables.some((v) => v.key === key)}
            // the details open in the drawer that takes this one's place
            open={(key) => {
              setChanges(false);
              pick(key);
            }}
          />
        </Drawer>
      )}
    </div>
  );
}

function ProjectVariables({
  orgId,
  projectId,
  projectName,
  revealMs,
  all,
  setAll,
}: {
  orgId: string;
  projectId: string;
  projectName: string;
  revealMs: number;
  all: boolean;
  setAll: (all: boolean) => void;
}) {
  const envs = useEnvironments(orgId, projectId);
  const queries = useQueryClient();
  // the environments ticked in the menu, by id; the first one until some are ticked (or when none ticked is left)
  const [picked, setPicked] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [find, setFind] = useState("");
  const [tag, setTag] = useState("");
  // the open folder is the project's, so another environment keeps it and another project starts at the root
  const [folder, setFolder] = useState(ROOT);
  if (envs.error) {
    return (
      <ErrorPanel
        error={envs.error}
        retry={() => void queries.invalidateQueries({ queryKey: ["environments"] })}
      />
    );
  }
  if (!envs.data) return <Loading what="Loading environments" />;
  const list = envs.data;
  const ticked = list.filter((e) => all || picked.includes(e.id));
  const selected = ticked.length > 0 ? ticked : list.slice(0, 1);
  // every environment ticked is kept for the next project, whose own environments are then all ticked
  const choose = (next: Env[]) => {
    setPicked(next.map((e) => e.id));
    setAll(next.length === list.length);
  };
  return (
    <div className="stack wide">
      {list.length === 0 ? (
        <Card>
          <p>This project has no environments yet. Add one to set values for it.</p>
          <div className="row">
            <button type="button" className="primary" onClick={() => setAdding(true)}>
              Add environment
            </button>
          </div>
        </Card>
      ) : (
        <>
          <div className="env-bar">
            <EnvMenu envs={list} selected={selected} choose={choose} add={() => setAdding(true)} />
          </div>
          {selected.length > 1 ? (
            <Grid
              key={folder}
              orgId={orgId}
              projectId={projectId}
              projectName={projectName}
              envs={selected}
              revealMs={revealMs}
              filters={{ find, setFind, tag, setTag }}
              folder={folder}
              setFolder={setFolder}
            />
          ) : (
            // keyed by the folder: what was revealed, ticked or opened in one is not carried into another,
            // where a key of the same name is another variable
            <Secrets
              key={folder}
              orgId={orgId}
              projectId={projectId}
              projectName={projectName}
              envs={list}
              envId={selected[0]?.id ?? ""}
              folder={folder}
              setFolder={setFolder}
              revealMs={revealMs}
              filters={{ find, setFind, tag, setTag }}
            />
          )}
        </>
      )}
      {adding && (
        <AddEnvironment orgId={orgId} projectId={projectId} close={() => setAdding(false)} />
      )}
    </div>
  );
}

/** Variables of one project, by environment: where each value comes from, add, change, delete, reveal. */
export function VariablesPage({
  orgId,
  head,
  revealMs = REVEAL_MS,
}: {
  orgId: string;
  /** The page's header, given the project choice to draw beside its title. */
  head?: (choice: ReactNode) => ReactNode;
  revealMs?: number;
}) {
  // held here, above the project's key, so choosing another project keeps All environments
  const [all, setAll] = useState(false);
  return (
    <ProjectPicker orgId={orgId} head={head}>
      {(project) => (
        <ProjectVariables
          key={project.id}
          orgId={orgId}
          projectId={project.id}
          projectName={project.name}
          revealMs={revealMs}
          all={all}
          setAll={setAll}
        />
      )}
    </ProjectPicker>
  );
}
