import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { allPages, call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { type Project, ProjectPicker, useConnections } from "./projects";
import { Loading } from "./ui";

interface Pool {
  id: string;
  name: string;
  tags: string[];
  image: string | null;
  enabled: boolean;
  isDefault: boolean;
}

interface Health {
  state: "healthy" | "degraded" | "offline" | "unknown";
  online: number;
  total: number;
  reason: "unlinked" | "not_permitted" | "unavailable" | null;
}

/** What `unknown` means, in words: none of GitLab's own text is shown. */
const WHY = {
  not_permitted: "the connection's token cannot list the project's runners",
  unlinked: "the project is not on GitLab",
  unavailable: "GitLab did not answer",
} as const;

/** Said in words, not colour; an answer that is not known is never worded like a healthy one. */
const said = (h: Health | string | undefined) => {
  if (h === undefined) return "Not checked";
  if (typeof h === "string") return `Not known: ${h}`;
  if (h.state === "unknown") return `Not known: ${h.reason ? WHY[h.reason] : "no reason given"}`;
  return `${h.state.charAt(0).toUpperCase()}${h.state.slice(1)}, ${h.online} of ${h.total} runners online`;
};

type Checked = { project: string; byPool: Record<string, Health | string> };

const usePools = (orgId: string) => {
  const client = useClient();
  return useQuery({
    queryKey: ["pools", orgId],
    queryFn: () =>
      allPages<Pool>((cursor) =>
        client.organizations({ orgId }).pools.get({ query: { limit: 100, cursor } }),
      ),
  });
};

function Check({
  orgId,
  project,
  connectionId,
  pools,
  onChecked,
}: {
  orgId: string;
  project: Project;
  connectionId: string;
  pools: Pool[];
  onChecked: (checked: Checked) => void;
}) {
  const client = useClient();
  const ask = useMutation({
    mutationFn: async () => {
      const at = client.organizations({ orgId }).projects({ projectId: project.id });
      const answers = await Promise.all(
        pools.map(async (p) => {
          try {
            const health = await call(() =>
              at.pools({ poolId: p.id }).status.get({ query: { connectionId } }),
            );
            return [p.id, health] as const;
          } catch (e) {
            return [p.id, e instanceof Error ? e.message : "that did not work"] as const;
          }
        }),
      );
      return Object.fromEntries(answers);
    },
    onSuccess: (byPool) => onChecked({ project: project.name, byPool }),
  });
  return (
    <div className="row">
      <button type="button" disabled={ask.isPending} onClick={() => ask.mutate()}>
        {ask.isPending ? "Checking…" : "Check health"}
      </button>
    </div>
  );
}

/** Asking GitLab takes the organization's connection and a project to ask about. */
function HealthCheck({
  orgId,
  pools,
  onChecked,
}: {
  orgId: string;
  pools: Pool[];
  onChecked: (checked: Checked) => void;
}) {
  const connections = useConnections(orgId);
  if (connections.error && !connections.data) {
    return <ErrorPanel error={connections.error} retry={() => void connections.refetch()} />;
  }
  if (!connections.data) return <Loading what="Loading connections" />;
  const [connection] = connections.data;
  if (!connection) {
    return (
      <p className="muted">
        Checking a pool's health needs a GitLab connection: add one under Connections.
      </p>
    );
  }
  return (
    <ProjectPicker orgId={orgId}>
      {(project) => (
        <Check
          orgId={orgId}
          project={project}
          connectionId={connection.id}
          pools={pools}
          onChecked={onChecked}
        />
      )}
    </ProjectPicker>
  );
}

/**
 * The organization's worker pools (POOL-5): what a stack's jobs ask of the runners, and, on request, how
 * each looks from one project. Read-only here: pools are made and changed with `orch pool` or the API.
 */
export function Pools({ orgId, actions }: { orgId: string; actions: readonly string[] }) {
  const pools = usePools(orgId);
  const [checked, setChecked] = useState<Checked>();
  return (
    <section className="stack" aria-labelledby="pools-title">
      <h2 id="pools-title">Worker pools</h2>
      <p className="muted">
        The runner tags a stack's jobs ask for, so its plans and applies run on your own runners.
        Tags route a job; they do not isolate it: anyone who can register a runner with these tags
        in GitLab receives these jobs, and the credentials they are given. Pools are managed with{" "}
        <code>orch pool</code>.
      </p>
      {pools.isPending && <Loading what="Loading pools" />}
      {pools.error && !pools.data && (
        <ErrorPanel error={pools.error} retry={() => void pools.refetch()} />
      )}
      {pools.data &&
        (pools.data.length === 0 ? (
          <p>No pool yet. A stack that names none runs on the runners GitLab picks for it.</p>
        ) : (
          <>
            <table>
              <caption className="visually-hidden">Worker pools</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Tags</th>
                  <th scope="col">Image</th>
                  <th scope="col">State</th>
                  {checked && <th scope="col">Health in {checked.project}</th>}
                </tr>
              </thead>
              <tbody>
                {pools.data.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.name}</th>
                    <td>
                      <span className="tags">
                        {p.tags.map((t) => (
                          <span className="tag" key={t}>
                            {t}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td>{p.image ?? <span className="muted">Standard image</span>}</td>
                    <td>
                      {p.enabled ? "Enabled" : "Disabled"}
                      {p.isDefault && ", Default"}
                    </td>
                    {checked && <td>{said(checked.byPool[p.id])}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {actions.includes("pool.status") && (
              <HealthCheck orgId={orgId} pools={pools.data} onChecked={setChecked} />
            )}
          </>
        ))}
    </section>
  );
}
