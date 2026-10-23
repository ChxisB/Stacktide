import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Card, StatusBadge } from "./components";
import { href } from "./router";
import { Loading } from "./ui";

/** What the API says of a project (see `projectSchema`), as far as this screen shows it. */
export interface Project {
  id: string;
  name: string;
  /** GitLab's number of the project; none for one made by hand. */
  gitlabProjectId?: number | null;
  defaultBranch: string;
  types: { tag: string; confidence: "high" | "medium"; evidence: string[] }[];
  /** The forge the project is on, and what that forge cannot do (FRG-24). */
  forge: Forge;
  capabilities: Record<string, boolean>;
}

export type Forge = "gitlab" | "github";
/** How each forge is named on a screen, and what it calls the things one imports. */
export const FORGES: Record<Forge, { name: string; things: string; file: string }> = {
  gitlab: { name: "GitLab", things: "projects", file: ".gitlab-ci.yml" },
  github: { name: "GitHub", things: "repositories", file: ".github/workflows/orch.yml" },
};
const isForge = (type: string): type is Forge => type === "gitlab" || type === "github";

/** Why a screen leaves something out for a forge, one line for each capability flag a screen uses. */
const LACKS: Record<string, string> = {
  ciLint: "does not check a workflow before it is merged, so the review cannot lint it",
  deployments:
    "deployments are not read by the platform yet, so there is nothing to refresh or promote",
  runners: "runners are not listed by the platform yet, so a pool's health cannot be checked",
};
/** What a project's forge lacks, in a sentence, or nothing when it has the capability. */
export const lacks = (
  project: Pick<Project, "forge" | "capabilities">,
  flag: keyof typeof LACKS,
) =>
  project.capabilities[flag] === false
    ? `${FORGES[project.forge].name} ${LACKS[flag]}.`
    : undefined;

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

/**
 * The project a page is about: the only one, or the one chosen from a list. `children` gets it. With `head`,
 * the page's header is drawn here with the choice in its actions, beside the title, in every state of the list.
 */
export function ProjectPicker({
  orgId,
  head,
  children,
}: {
  orgId: string;
  head?: (choice: ReactNode) => ReactNode;
  children: (project: Project) => ReactNode;
}) {
  const projects = useProjects(orgId);
  const [chosen, setChosen] = useState<string>();
  const alone = (body: ReactNode) => (
    <>
      {head?.(null)}
      {body}
    </>
  );
  if (projects.error) return alone(<ErrorPanel error={projects.error} />);
  if (!projects.data) return alone(<Loading what="Loading projects" />);
  const project = projects.data.find((p) => p.id === chosen) ?? projects.data[0];
  if (!project) {
    return alone(
      <p>
        No projects yet. <a href={href("projects")}>Import one</a> first.
      </p>,
    );
  }
  const choice =
    projects.data.length > 1 ? (
      <label>
        Project
        <select value={project.id} onChange={(e) => setChosen(e.target.value)}>
          {projects.data.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
    ) : (
      <p>
        Project <strong>{project.name}</strong>
      </p>
    );
  return (
    <div className="stack wide">
      {head ? head(choice) : choice}
      {children(project)}
    </div>
  );
}

/** The organization's forge connections (a cloud account is not one), or only those of `forge`. */
export const useConnections = (orgId: string, forge?: Forge) => {
  const client = useClient();
  return useQuery({
    queryKey: forge ? ["connections", orgId, forge] : ["connections", orgId],
    queryFn: async () =>
      (
        await allPages((cursor) =>
          client.organizations({ orgId }).connections.get({ query: { limit: 100, cursor } }),
        )
      ).filter((c) => (forge ? c.type === forge : isForge(c.type))),
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

const ADDRESS: Record<Forge, { url: string; hint: string; token: string }> = {
  gitlab: {
    url: "https://gitlab.com",
    hint: "https://gitlab.example.com",
    token: "an access token with the read_api scope (or api)",
  },
  github: {
    url: "https://github.com",
    hint: "https://github.example.com",
    token: "a fine-grained token with read access to the repositories (or a classic one with repo)",
  },
};

/** Add a forge connection: the token is tested before it is stored, and kept here only while typing. */
export function AddConnection({
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
  const [forge, setForge] = useState<Forge>("gitlab");
  const [name, setName] = useState("GitLab");
  const [baseUrl, setBaseUrl] = useState(ADDRESS.gitlab.url);
  const [token, setToken] = useState("");
  const system = FORGES[forge].name;
  // the fields still holding the last forge's defaults take the new one's; typed ones stay
  const choose = (next: Forge) => {
    if (name === FORGES[forge].name) setName(FORGES[next].name);
    if (baseUrl === ADDRESS[forge].url) setBaseUrl(ADDRESS[next].url);
    setForge(next);
  };
  const add = useMutation({
    // gcTime 0: the mutation cache must not keep the token after the call
    gcTime: 0,
    mutationFn: () =>
      call(() =>
        client.organizations({ orgId }).connections.post({ type: forge, name, baseUrl, token }),
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
    <form onSubmit={submit} className="stack" aria-label={`Connect ${system}`}>
      <h2>Connect {system}</h2>
      <p className="muted">
        Use {ADDRESS[forge].token}. It is checked with {system} first, then stored encrypted; it is
        never shown again.
      </p>
      <label>
        Forge
        <select value={forge} onChange={(e) => choose(e.target.value as Forge)}>
          {(Object.keys(FORGES) as Forge[]).map((f) => (
            <option key={f} value={f}>
              {FORGES[f].name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
      </label>
      <label>
        {system} address
        <input
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          required
          placeholder={ADDRESS[forge].hint}
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

/**
 * Browse what the token can see, pick projects and import them; says what happened to each. With `want`
 * (a path from a repository address), the list starts on that name and the repository with that path is ticked once.
 */
function Browse({
  orgId,
  connectionId,
  forge,
  want,
}: {
  orgId: string;
  connectionId: string;
  forge: Forge;
  want?: string | undefined;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const { name: system, things } = FORGES[forge];
  const first = want?.split("/").pop() ?? "";
  const [typed, setTyped] = useState(first);
  const [search, setSearch] = useState(first);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const tick = useRef(want?.toLowerCase());
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
  // the address names one repository: tick it when it comes up, once, so a later untick sticks
  useEffect(() => {
    const row = found.data?.pages
      .flatMap((p) => p.items)
      .find((r) => r.path.toLowerCase() === tick.current);
    if (!row) return;
    tick.current = undefined;
    setPicked((now) => new Set(now).add(row.gitlabProjectId));
  }, [found.data]);

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
    rows.find((r) => r.gitlabProjectId === id)?.path ?? `${system} #${id}`;
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
      <form onSubmit={searching} className="row" aria-label={`Search ${system} ${things}`}>
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

      {found.isPending && <Loading what={`Asking ${system}`} />}
      {found.error && <ErrorPanel error={found.error} retry={() => void found.refetch()} />}
      {found.data && rows.length === 0 && (
        <p>
          {search
            ? `${system} shows no ${things} matching “${search}” for this token.`
            : `${system} shows no ${things} for this token. ${
                forge === "gitlab"
                  ? "Check that the token's user is a member of the projects you want."
                  : "Check that the token can read the repositories you want."
              }`}
        </p>
      )}
      {rows.length > 0 && (
        <fieldset className="list">
          <legend>{`${things[0]?.toUpperCase()}${things.slice(1)} in ${system}`}</legend>
          {rows.map((r) => (
            <label key={r.gitlabProjectId} className="item">
              <input
                type="checkbox"
                checked={picked.has(r.gitlabProjectId)}
                disabled={full && !picked.has(r.gitlabProjectId)}
                onChange={() => toggle(r.gitlabProjectId)}
              />
              <span>{r.path}</span>
              {r.archived && <StatusBadge tone="quiet">archived</StatusBadge>}
              {r.projectId && <StatusBadge tone="ok">imported</StatusBadge>}
              {!r.defaultBranch && <span className="muted">empty</span>}
            </label>
          ))}
        </fieldset>
      )}
      {found.hasNextPage && (
        <div className="row">
          <button
            type="button"
            onClick={() => void found.fetchNextPage()}
            disabled={found.isFetchingNextPage}
          >
            Show more
          </button>
        </div>
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

export const bare = (host: string) => host.replace(/^api\./, "");

/**
 * The host and repository path of a pasted address, or nothing for what is no web address.
 * shortcut: web addresses only (no git@host:path), a GitLab served from a sub-path is not matched, add when asked.
 */
export function addressOf(text: string): { host: string; path: string } | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return path ? { host: bare(url.host), path } : undefined;
}

/** The repository path an address names on a forge: GitHub's is owner/name, GitLab's ends where `/-/` begins. */
export const pathOn = (forge: Forge, path: string) =>
  forge === "github" ? path.split("/").slice(0, 2).join("/") : (path.split("/-/")[0] ?? path);

export const hostOf = (config: Record<string, unknown>) => {
  try {
    return bare(new URL(String(config.baseUrl)).host);
  } catch {
    return undefined;
  }
};

/** Onboarding by address: the connection the address belongs to takes over the import card below it. */
function RepositoryAddress({
  connections,
  onFound,
}: {
  connections: { id: string; type: string; config: Record<string, unknown> }[];
  onFound: (connectionId: string, path: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = addressOf(typed);
    if (!address) {
      setProblem("That is not a repository address, like https://github.com/acme/web.");
      return;
    }
    const connection = connections.find((c) => hostOf(c.config) === address.host);
    if (!connection || !isForge(connection.type)) {
      setProblem(`No connection reaches ${address.host}. Add one for it first.`);
      return;
    }
    setProblem(undefined);
    onFound(connection.id, pathOn(connection.type, address.path));
  };
  return (
    <form onSubmit={submit} className="row middle" aria-label="Repository address">
      <label>
        Repository address
        {/* text, not url: the browser would hold back a bad address before this form could say what is wrong */}
        <input
          inputMode="url"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="https://github.com/acme/web"
        />
      </label>
      <button type="submit">Find</button>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
    </form>
  );
}

/** The import flow of one organization: the connection (added here if there is none), then browsing. */
function Import({ orgId }: { orgId: string }) {
  const connections = useConnections(orgId);
  const [chosen, setChosen] = useState<string>();
  const [want, setWant] = useState<string>();
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
      <Card>
        <AddConnection
          orgId={orgId}
          onDone={(id) => {
            setChosen(id);
            setWant(undefined);
            setAdding(false);
          }}
          onCancel={current ? () => setAdding(false) : undefined}
        />
      </Card>
    );
  }
  const forge = isForge(current.type) ? current.type : "gitlab";
  return (
    <Card title={`Import from ${FORGES[forge].name}`}>
      <RepositoryAddress
        connections={list}
        onFound={(id, path) => {
          setChosen(id);
          setWant(path);
        }}
      />
      <div className="row middle">
        {list.length > 1 ? (
          <label>
            Connection
            <select
              value={current.id}
              onChange={(e) => {
                setChosen(e.target.value);
                setWant(undefined);
              }}
            >
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
      <Browse
        key={`${current.id} ${want ?? ""}`}
        orgId={orgId}
        connectionId={current.id}
        forge={forge}
        want={want}
      />
    </Card>
  );
}

/** The imported projects of an organization, and the way to import more. */
export function ProjectsPage({ orgId }: { orgId: string }) {
  const projects = useProjects(orgId);
  return (
    <div className="stack wide">
      <Card title="Imported projects">
        {projects.isPending && <Loading />}
        {projects.error && (
          <ErrorPanel error={projects.error} retry={() => void projects.refetch()} />
        )}
        {projects.data &&
          (projects.data.length === 0 ? (
            <p>No projects yet. Import some below.</p>
          ) : (
            <table>
              <caption className="visually-hidden">Imported projects</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Forge</th>
                  <th scope="col">Default branch</th>
                  <th scope="col">Detected</th>
                </tr>
              </thead>
              <tbody>
                {projects.data.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.name}</th>
                    <td>{FORGES[p.forge].name}</td>
                    <td>{p.defaultBranch}</td>
                    <td>
                      <Types types={p.types} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </Card>
      <Import orgId={orgId} />
    </div>
  );
}
