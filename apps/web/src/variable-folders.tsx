import { FOLDER_PATTERN, ROOT } from "@orch/core/folders";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, call, useClient } from "./api";
import { type Cell, type Env, Form, useWrite, variablesAt } from "./variable-parts";

/** A folder of the project, with how many variables sit directly in it (at the project and in every environment). */
export type FolderItem = { id: string; path: string; variableCount: number };

/**
 * The project's folders: one tree for all its environments, so choosing another environment keeps
 * the folder that is open. shortcut: the API answers every folder in one go (a tree is small), so
 * there is no paging here; page it when the list does.
 */
export const useFolders = (orgId: string, projectId: string) => {
  const client = useClient();
  return useQuery({
    queryKey: ["folders", orgId, projectId],
    queryFn: async (): Promise<FolderItem[]> =>
      (await call(() => client.organizations({ orgId }).projects({ projectId }).folders.get()))
        .items,
  });
};

export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The folder itself if it is in the list, else the nearest one above it that is: where to go when it went. */
export const nearest = (folders: FolderItem[], path: string): string => {
  let at = path;
  while (at !== ROOT && !folders.some((f) => f.path === at))
    at = at.slice(0, at.lastIndexOf("/")) || ROOT;
  return at;
};

/**
 * The project's folders for a page that has one open. A folder deleted or renamed elsewhere answers 404 to
 * the page's read (`error`): the list is read again and, if the folder is not in it, the page goes up to the
 * nearest one that is. The list is read when the page asks, so this is the way the page learns of it.
 */
export const useOpenFolder = (
  orgId: string,
  projectId: string,
  folder: string,
  setFolder: (folder: string) => void,
  error: unknown,
) => {
  const folders = useFolders(orgId, projectId);
  const refetch = folders.refetch;
  useEffect(() => {
    if (error instanceof ApiError && error.status === 404) void refetch();
  }, [error, refetch]);
  useEffect(() => {
    if (folders.data && folder !== nearest(folders.data, folder))
      setFolder(nearest(folders.data, folder));
  }, [folders.data, folder, setFolder]);
  return folders;
};

/** The folders directly under `folder` (not the ones below those). */
export const childrenOf = (folders: FolderItem[], folder: string) => {
  const prefix = folder === ROOT ? "/" : `${folder}/`;
  return folders.filter(
    (f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/"),
  );
};

/** Where the list is: the project, the environment, then each folder down; every level above the last goes back to it. */
export function Crumbs({
  projectName,
  envName,
  folder,
  go,
}: {
  projectName: string;
  envName: string;
  folder: string;
  go: (folder: string) => void;
}) {
  const names = folder === ROOT ? [] : folder.slice(1).split("/");
  // `depth` names deep: 0 is the root, which the environment stands for
  const level = (depth: number, label: string) =>
    depth === names.length ? (
      <li key={depth} aria-current="page">
        {label}
      </li>
    ) : (
      <li key={depth}>
        <button
          type="button"
          className="quiet"
          onClick={() => go(depth === 0 ? ROOT : `/${names.slice(0, depth).join("/")}`)}
        >
          {label}
        </button>
      </li>
    );
  return (
    <nav aria-label="Folder path" className="path">
      <ol className="crumbs">
        <li>{projectName}</li>
        {level(0, envName)}
        {names.map((n, i) => level(i + 1, n))}
      </ol>
    </nav>
  );
}

/** The folders of the open folder as rows: name, how many variables, Open, Rename and Delete. Nothing at all when it holds none. */
export function FolderRows({
  folder,
  folders,
  open,
  rename,
  remove,
}: {
  folder: string;
  folders: FolderItem[];
  open: (folder: string) => void;
  rename: (folder: FolderItem) => void;
  remove: (folder: FolderItem) => void;
}) {
  if (folders.length === 0) return null;
  return (
    <div className="scroll">
      <table>
        <caption className="visually-hidden">Folders in {folder}</caption>
        <thead>
          <tr>
            <th scope="col">Folder</th>
            <th scope="col">Variables</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {folders.map((f) => (
            <tr key={f.id}>
              <th scope="row">
                <code>{nameOf(f.path)}</code>
              </th>
              <td>
                {f.variableCount} {f.variableCount === 1 ? "variable" : "variables"}
              </td>
              <td>
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Open ${nameOf(f.path)}`}
                  onClick={() => open(f.path)}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Rename ${nameOf(f.path)}`}
                  onClick={() => rename(f)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="quiet"
                  aria-label={`Delete ${nameOf(f.path)}`}
                  onClick={() => remove(f)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const RULE = "A folder name is 1 to 32 lower-case letters, digits, - or _";

/** The folders of the project, for a write to name one. */
const useFoldersAt = (orgId: string, projectId: string) =>
  useClient().organizations({ orgId }).projects({ projectId }).folders;

/** A name for a folder: the rule is checked here, so what it says is certain; a taken name or a folder too deep is the API's to say. */
function NameForm({
  title,
  submit,
  initial,
  hint,
  save,
  done,
  cancel,
}: {
  title: string;
  submit: string;
  initial: string;
  hint: ReactNode;
  save: (name: string) => Promise<unknown>;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const write = useWrite(async () => {
    if (!FOLDER_PATTERN.test(name)) throw new Error(RULE);
    await save(name);
  }, done);
  return (
    <Form
      title={title}
      onSubmit={write.go}
      error={write.error}
      pending={write.pending}
      submit={submit}
      onCancel={cancel}
    >
      <p className="muted">{hint}</p>
      <label>
        Folder name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoComplete="off"
          spellCheck={false}
        />
      </label>
    </Form>
  );
}

/** A new folder in `parent`. */
export function AddFolder({
  orgId,
  projectId,
  parent,
  done,
  cancel,
}: {
  orgId: string;
  projectId: string;
  parent: string;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const folders = useFoldersAt(orgId, projectId);
  return (
    <NameForm
      title="Add a folder"
      submit="Add folder"
      initial=""
      hint={
        <>
          It is made in <code>{parent}</code>.
        </>
      }
      save={(name) => call(() => folders.post({ parent, name }))}
      done={done}
      cancel={cancel}
    />
  );
}

/** A folder's new name, in the same parent: what is in it, and its folders, go with it. */
export function RenameFolder({
  orgId,
  projectId,
  folder,
  done,
  cancel,
}: {
  orgId: string;
  projectId: string;
  folder: FolderItem;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const folders = useFoldersAt(orgId, projectId);
  return (
    <NameForm
      title="Rename a folder"
      submit="Rename folder"
      initial={nameOf(folder.path)}
      hint={
        <>
          <code>{folder.path}</code> keeps its variables and folders under the new name.
        </>
      }
      save={(name) => call(() => folders({ folderId: folder.id }).patch({ name }))}
      done={done}
      cancel={cancel}
    />
  );
}

/** Deletes an empty folder; the API says why when it is not empty, and nothing changes. */
export function DeleteFolder({
  orgId,
  projectId,
  folder,
  done,
  cancel,
}: {
  orgId: string;
  projectId: string;
  folder: FolderItem;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const folders = useFoldersAt(orgId, projectId);
  const write = useWrite(() => call(() => folders({ folderId: folder.id }).delete()), done);
  return (
    <Form
      title="Delete a folder"
      onSubmit={write.go}
      error={write.error}
      pending={write.pending}
      submit="Delete folder"
      onCancel={cancel}
    >
      <p>
        Delete <code>{folder.path}</code>? Only a folder with no variables and no folders in it can
        be deleted.
      </p>
    </Form>
  );
}

/**
 * Moves a variable to another folder of the project: the same variable, its history with it. When the move would
 * leave other variables without something they read, the API refuses and names them; they are shown, and the
 * button then goes ahead anyway (`force`) for that folder only.
 */
export function MoveVariable({
  orgId,
  projectId,
  cell,
  env,
  folder,
  done,
  cancel,
}: {
  orgId: string;
  projectId: string;
  cell: Cell;
  env: Env;
  /** The folder it is in now. */
  folder: string;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const client = useClient();
  const folders = useFolders(orgId, projectId);
  const [chosen, setChosen] = useState<string>();
  const [breaks, setBreaks] = useState<string[]>();
  /** The API's sentence for that refusal: the list below says it better, so it is the one message not shown. */
  const [refusal, setRefusal] = useState<string>();
  const options = [ROOT, ...(folders.data ?? []).map((f) => f.path)].filter((p) => p !== folder);
  const to = chosen !== undefined && options.includes(chosen) ? chosen : options[0];
  const write = useWrite(async () => {
    if (to === undefined) return;
    try {
      await call(() =>
        variablesAt(
          client,
          orgId,
          projectId,
          cell.level,
          env.id,
        )({ varId: cell.id }).patch({ folder: to, ...(breaks && { force: true }) }),
      );
    } catch (e) {
      if (e instanceof ApiError && e.breaks) {
        setBreaks(e.breaks);
        setRefusal(e.message);
      }
      throw e;
    }
  }, done);
  return (
    <Form
      title={`Move ${cell.key}`}
      onSubmit={write.go}
      error={write.error === refusal ? undefined : write.error}
      pending={write.pending}
      submit={breaks ? "Move anyway" : "Move"}
      onCancel={cancel}
      disabled={to === undefined}
    >
      <p className="muted">
        It is in <code>{folder}</code>. Its history and its id go with it.
      </p>
      {to === undefined ? (
        <p>There is no other folder: add one first.</p>
      ) : (
        <label>
          Move to folder
          <select
            value={to}
            onChange={(e) => {
              setChosen(e.target.value);
              setBreaks(undefined);
              write.clear();
            }}
          >
            {options.map((p) => (
              <option key={p} value={p}>
                {p === ROOT ? "/ (the root)" : p}
              </option>
            ))}
          </select>
        </label>
      )}
      {breaks && (
        <div role="alert" className="error">
          <p>
            In <code>{to}</code>, these would no longer find what they read, and would show as
            unresolved:
          </p>
          <ul>
            {breaks.map((a) => (
              <li key={a}>
                <code>{a}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Form>
  );
}
