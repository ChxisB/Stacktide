import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError, allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Loading } from "./ui";

/** What the API says of a project (see `projectSchema`), as far as this screen shows it. */
export interface Project {
  id: string;
  name: string;
  defaultBranch: string;
  types: { tag: string; confidence: "high" | "medium"; evidence: string[] }[];
}

/** The most projects one import takes (the API's limit). */
const MAX_IMPORT = 25;

export const useProjects = (orgId: string) => {
  const client = useClient();
  return useQuery({
    queryKey: ["projects", orgId],
    queryFn: () =>
      allPages<Project>((cursor) =>
        client.organizations({ orgId }).projects.get({ query: { limit: 100, cursor } }),
      ),
  });
};

export const useConnections = (orgId: string) => {
  const client = useClient();
  return useQuery({
    queryKey: ["connections", orgId],
    queryFn: async () =>
      (
        await allPages((cursor) =>
          client.organizations({ orgId }).connections.get({ query: { limit: 100, cursor } }),
        )
      ).filter((c) => c.type === "gitlab"),
  });
};

/** The detected tags of a repository, with the paths that suggested them as a tooltip. */
export function Types({ types }: { types: Project["types"] }) {
  if (types.length === 0) return <span className="muted">none detected</span>;
  return (
    <span className="tags">
      {types.map((t) => (
        <span key={t.tag} className="tag" title={t.evidence.join(", ")}>
          {t.tag}
          {t.confidence === "medium" ? " (likely)" : ""}
        </span>
      ))}
    </span>
  );
}

/** Add a GitLab connection: the token is tested before it is stored, and kept here only while typing. */
function AddConnection({
  orgId,
  onDone,
  onCancel,
}: {
  orgId: string;
  onDone: (id: string) => void;
  onCancel?: (() => void) | undefined;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const [name, setName] = useState("GitLab");
  const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const add = useMutation({
    // gcTime 0: the mutation cache must not keep the token after the call
    gcTime: 0,
    mutationFn: () =>
      call(() =>
        client.organizations({ orgId }).connections.post({ type: "gitlab", name, baseUrl, token }),
      ),
    onSuccess: async (connection) => {
      setToken("");
      await queries.invalidateQueries({ queryKey: ["connections", orgId] });
      onDone(connection.id);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate();
  };
  return (
    <form onSubmit={submit} className="stack" aria-label="Connect GitLab">
      <h2>Connect GitLab</h2>
      <p className="muted">
        Use an access token with the <code>read_api</code> scope (or <code>api</code>). It is
        checked with GitLab first, then stored encrypted; it is never shown again.
      </p>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </label>
      <label>
        GitLab address
        <input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          required
          placeholder="https://gitlab.example.com"
        />
      </label>
      <label>
        Access token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          minLength={8}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {add.error && (
        <p role="alert" className="error">
          {add.error.message}
        </p>
      )}
      <div className="row">
        <button type="submit" className="primary" disabled={add.isPending}>
          {add.isPending ? "Checking…" : "Connect"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

interface Found {
  gitlabProjectId: number;
  path: string;
  defaultBranch: string | null;
  archived: boolean;
  projectId: string | null;
}

/** Browse what the token can see, pick projects and import them; says what happened to each. */
function Browse({ orgId, connectionId }: { orgId: string; connectionId: string }) {
  const client = useClient();
  const queries = useQueryClient();
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const scope = client.organizations({ orgId }).connections({ connectionId });

  const found = useInfiniteQuery({
    queryKey: ["gitlab-projects", orgId, connectionId, search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(() =>
        scope["gitlab-projects"].get({
          query: {
            limit: 50,
            ...(pageParam ? { cursor: pageParam } : {}),
            ...(search ? { search } : {}),
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows: Found[] = found.data?.pages.flatMap((p) => p.items) ?? [];

  const run = useMutation({
    mutationFn: (ids: number[]) => call(() => scope.imports.post({ gitlabProjectIds: ids })),
    onSuccess: async ({ results }) => {
      // what failed stays picked, so it can be tried again
      setPicked(
        new Set(results.filter((r) => r.outcome === "failed").map((r) => r.gitlabProjectId)),
      );
      await Promise.all([
        queries.invalidateQueries({ queryKey: ["projects", orgId] }),
        queries.invalidateQueries({ queryKey: ["gitlab-projects", orgId, connectionId] }),
      ]);
    },
  });
  const labelOf = (id: number) =>
    rows.find((r) => r.gitlabProjectId === id)?.path ?? `GitLab project ${id}`;
  const toggle = (id: number) =>
    setPicked((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const searching = (event: FormEvent) => {
    event.preventDefault();
    setSearch(typed.trim());
  };
  const full = picked.size >= MAX_IMPORT;

  return (
    <div className="stack">
      <form onSubmit={searching} className="row" aria-label="Search GitLab projects">
        <label>
          <span className="visually-hidden">Search by name</span>
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search by name"
          />
        </label>
        <button type="submit">Search</button>
      </form>

      {found.isPending && <Loading what="Asking GitLab" />}
      {found.error && <ErrorPanel error={found.error} retry={() => void found.refetch()} />}
      {found.data && rows.length === 0 && (
        <p>
          {search
            ? `GitLab shows no projects matching “${search}” for this token.`
            : "GitLab shows no projects for this token. Check that the token's user is a member of the projects you want."}
        </p>
      )}
      {rows.length > 0 && (
        <fieldset className="list">
          <legend>Projects in GitLab</legend>
          {rows.map((r) => (
            <label key={r.gitlabProjectId} className="item">
              <input
                type="checkbox"
                checked={picked.has(r.gitlabProjectId)}
                disabled={full && !picked.has(r.gitlabProjectId)}
                onChange={() => toggle(r.gitlabProjectId)}
              />
              <span>{r.path}</span>
              {r.archived && <span className="tag">archived</span>}
              {r.projectId && <span className="tag">imported</span>}
              {!r.defaultBranch && <span className="muted">empty</span>}
            </label>
          ))}
        </fieldset>
      )}
      {found.hasNextPage && (
        <button
          type="button"
          onClick={() => void found.fetchNextPage()}
          disabled={found.isFetchingNextPage}
        >
          Show more
        </button>
      )}
      {full && (
        <p className="muted">
          That is the most one import takes ({MAX_IMPORT}); import these first.
        </p>
      )}

      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={picked.size === 0 || run.isPending}
          onClick={() => run.mutate([...picked])}
        >
          {run.isPending ? "Importing…" : `Import ${picked.size} selected`}
        </button>
        {/* picks outlive a search, so they can be out of sight */}
        <button type="button" disabled={picked.size === 0} onClick={() => setPicked(new Set())}>
          Clear selection
        </button>
      </div>
      {run.error && <ErrorPanel error={run.error} />}
      {run.data && (
        <section aria-label="Import results">
          <h3>Import results</h3>
          <ul className="results">
            {run.data.results.map((r) =>
              r.outcome === "failed" ? (
                <li key={r.gitlabProjectId} className="error">
                  <strong>{labelOf(r.gitlabProjectId)}</strong>: not imported. {r.message}
                </li>
              ) : (
                <li key={r.gitlabProjectId}>
                  <strong>{r.project.name}</strong>: {r.outcome} <Types types={r.project.types} />
                  {r.truncated && (
                    <span className="muted">
                      {" "}
                      The repository is large, so these types may be incomplete.
                    </span>
                  )}
                </li>
              ),
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The import flow of one organization: the connection (added here if there is none), then browsing. */
function Import({ orgId }: { orgId: string }) {
  const connections = useConnections(orgId);
  const [chosen, setChosen] = useState<string>();
  const [adding, setAdding] = useState(false);

  if (connections.isPending) return <Loading />;
  if (connections.error instanceof ApiError && connections.error.status === 403) {
    return <p className="muted">Importing projects needs an organization admin.</p>;
  }
  if (connections.error) {
    return <ErrorPanel error={connections.error} retry={() => void connections.refetch()} />;
  }
  const list = connections.data;
  const current = list.find((c) => c.id === chosen) ?? list[0];
  if (!current || adding) {
    return (
      <AddConnection
        orgId={orgId}
        onDone={(id) => {
          setChosen(id);
          setAdding(false);
        }}
        onCancel={current ? () => setAdding(false) : undefined}
      />
    );
  }
  return (
    <div className="stack">
      <h2>Import from GitLab</h2>
      <div className="row">
        {list.length > 1 ? (
          <label>
            Connection
            <select value={current.id} onChange={(e) => setChosen(e.target.value)}>
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span>
            Connection: <strong>{current.name}</strong>
          </span>
        )}
        <button type="button" onClick={() => setAdding(true)}>
          Add a connection
        </button>
      </div>
      <Browse key={current.id} orgId={orgId} connectionId={current.id} />
    </div>
  );
}

/** The imported projects of an organization, and the way to import more. */
export function ProjectsPage({ orgId }: { orgId: string }) {
  const projects = useProjects(orgId);
  return (
    <>
      {projects.isPending && <Loading />}
      {projects.error && (
        <ErrorPanel error={projects.error} retry={() => void projects.refetch()} />
      )}
      {projects.data &&
        (projects.data.length === 0 ? (
          <p>No projects yet. Import some from GitLab below.</p>
        ) : (
          <table>
            <caption className="visually-hidden">Imported projects</caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Default branch</th>
                <th scope="col">Detected</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.name}</th>
                  <td>{p.defaultBranch}</td>
                  <td>
                    <Types types={p.types} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      <Import orgId={orgId} />
    </>
  );
}
