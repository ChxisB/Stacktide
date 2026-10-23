import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Card, Named } from "./components";
import { SignInMethods } from "./identities";
import type { Org } from "./org";
import { Pools } from "./pools";
import { AddConnection, FORGES, type Forge, useConnections } from "./projects";
import { SingleSignOn } from "./sso";
import { Tokens } from "./tokens";
import { Loading, stamp, when } from "./ui";

export const useAccess = (orgId: string) => {
  const client = useClient();
  return useQuery({
    queryKey: ["access", orgId],
    queryFn: () => call(() => client.organizations({ orgId }).access.get()),
  });
};

interface Connection {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: string | Date;
}

type Access = NonNullable<ReturnType<typeof useAccess>["data"]>;

function Row({
  orgId,
  connection,
  actions,
}: {
  orgId: string;
  connection: Connection;
  actions: Access["actions"];
}) {
  const client = useClient();
  const queries = useQueryClient();
  const at = () => client.organizations({ orgId }).connections({ connectionId: connection.id });
  const [confirming, setConfirming] = useState(false);
  const test = useMutation({ mutationFn: () => call(() => at().test.post()) });
  const remove = useMutation({
    mutationFn: () => call(() => at().delete()),
    onSuccess: () => queries.invalidateQueries({ queryKey: ["connections", orgId] }),
  });
  const address = connection.config.baseUrl;
  const result = test.data;
  return (
    <tr>
      <th scope="row">{connection.name}</th>
      <td>{FORGES[connection.type as Forge]?.name ?? connection.type}</td>
      <td>{typeof address === "string" ? address : "Not recorded"}</td>
      <td>
        <time dateTime={stamp(connection.createdAt)}>{when(connection.createdAt)}</time>
      </td>
      <td>
        <div className="stack">
          {confirming ? (
            <div className="row">
              <button
                type="button"
                className="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? "Deleting…" : `Delete ${connection.name}`}
              </button>
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => {
                  remove.reset();
                  setConfirming(false);
                }}
              >
                Keep
              </button>
            </div>
          ) : (
            <div className="row">
              {actions.includes("connection.test") && (
                <button type="button" disabled={test.isPending} onClick={() => test.mutate()}>
                  {test.isPending ? "Testing…" : <Named word="Test" name={connection.name} />}
                </button>
              )}
              {actions.includes("connection.delete") && (
                <button
                  type="button"
                  onClick={() => {
                    // the news of an earlier test says nothing of what is about to be decided
                    test.reset();
                    setConfirming(true);
                  }}
                >
                  Delete…
                </button>
              )}
            </div>
          )}
          {confirming && (
            <p className="muted">
              Its stored token is deleted, and what reaches its forge through it stops working until
              another connection is set up. One that sync targets still use cannot be deleted.
            </p>
          )}
          {result?.ok && !("user" in result) && <p role="status">{result.summary}.</p>}
          {result?.ok && "user" in result && (
            <p role="status">
              GitLab accepts it, as {result.user.name} (@{result.user.username}).{" "}
              {result.scopes ? `Scopes: ${result.scopes.join(", ")}.` : "Its scopes are not shown."}
              {result.expiresAt ? ` Expires ${result.expiresAt}.` : " It does not expire."}
              {result.version && ` GitLab ${result.version}.`}
              {(["no", "unknown"] as const).map((state) => {
                const list = result.capabilities.filter((c) => c.state === state);
                return (
                  list.length > 0 && (
                    <span key={state}>
                      {" "}
                      {state === "no" ? "Not available here:" : "Cannot be told:"}{" "}
                      {list.map((c) => `${c.label} (needs ${c.needs})`).join("; ")}.
                    </span>
                  )
                );
              })}
            </p>
          )}
          {result && !result.ok && (
            <p role="alert" className="error">
              {result.message}
            </p>
          )}
          {(test.error || remove.error) && (
            <p role="alert" className="error">
              {(test.error ?? remove.error)?.message}
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}

function Connections({ orgId, actions }: { orgId: string; actions: Access["actions"] }) {
  const connections = useConnections(orgId);
  const [adding, setAdding] = useState(false);
  return (
    <Card title="Connections">
      <p className="muted">
        The GitLab and GitHub access tokens this organization works through. A token is stored
        encrypted and is never shown again.
      </p>
      {connections.isPending && <Loading what="Loading connections" />}
      {connections.error && !connections.data && (
        <ErrorPanel error={connections.error} retry={() => void connections.refetch()} />
      )}
      {connections.data &&
        (connections.data.length === 0 ? (
          <p>No connection yet.</p>
        ) : (
          <table>
            <caption className="visually-hidden">Connections</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Forge</th>
                <th scope="col">Address</th>
                <th scope="col">Added</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {connections.data.map((c) => (
                <Row key={c.id} orgId={orgId} connection={c} actions={actions} />
              ))}
            </tbody>
          </table>
        ))}
      {adding ? (
        <AddConnection
          orgId={orgId}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        actions.includes("connection.create") && (
          <div className="row">
            <button type="button" onClick={() => setAdding(true)}>
              Add a connection…
            </button>
          </div>
        )
      )}
    </Card>
  );
}

/** What the signed-in person may do here: their role, the connections (admins only) and their own tokens. */
export function SettingsPage({ org }: { org: Org }) {
  const access = useAccess(org.id);
  if (access.isPending) return <Loading what="Loading settings" />;
  if (!access.data) {
    return <ErrorPanel error={access.error} retry={() => void access.refetch()} />;
  }
  const { role, actions } = access.data;
  return (
    <div className="stack wide">
      <Card title="Your access">
        <p>
          Your role in <strong>{org.name}</strong> is <strong>{role}</strong>.
        </p>
        <p className="muted">
          Roles come from your membership of the organization's GitLab group, so they are changed in
          GitLab. A change can take a few minutes to show here.
        </p>
      </Card>
      {actions.includes("connection.read") && <Connections orgId={org.id} actions={actions} />}
      {actions.includes("pool.read") && <Pools orgId={org.id} actions={actions} />}
      {actions.includes("sso.read") && <SingleSignOn orgId={org.id} actions={actions} />}
      <SignInMethods />
      <Tokens />
    </div>
  );
}
