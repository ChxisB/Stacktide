import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { call, useClient } from "./api";
import { ErrorPanel } from "./auth";
import { Callout, Card, Confirm, Drawer, Empty, Named, useToast } from "./components";
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

const probe = (client: ReturnType<typeof useClient>, orgId: string, c: Connection) =>
  call(() => client.organizations({ orgId }).connections({ connectionId: c.id }).test.post());
type Outcome = Awaited<ReturnType<typeof probe>>;

/** What a test found, below the table and naming the connection it is about: it is not one row's news. */
function Tested({ name, outcome }: { name: string; outcome: Outcome }) {
  if (!outcome.ok) {
    return (
      <Callout tone="bad" title={name}>
        {outcome.message}
      </Callout>
    );
  }
  return (
    <div role="status">
      <Callout tone="ok" title={name}>
        {"user" in outcome ? (
          <>
            GitLab accepts it, as {outcome.user.name} (@{outcome.user.username}).{" "}
            {outcome.scopes ? `Scopes: ${outcome.scopes.join(", ")}.` : "Its scopes are not shown."}
            {outcome.expiresAt ? ` Expires ${outcome.expiresAt}.` : " It does not expire."}
            {outcome.version && ` GitLab ${outcome.version}.`}
            {(["no", "unknown"] as const).map((state) => {
              const list = outcome.capabilities.filter((c) => c.state === state);
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
          </>
        ) : (
          `${outcome.summary}.`
        )}
      </Callout>
    </div>
  );
}

function Row({
  orgId,
  connection,
  actions,
  testing,
  busy,
  onTest,
  onAsk,
}: {
  orgId: string;
  connection: Connection;
  actions: Access["actions"];
  /** This row's test is under way. */
  testing: boolean;
  /** Some row's test is under way. */
  busy: boolean;
  onTest: () => void;
  /** The delete question is opened. */
  onAsk: () => void;
}) {
  const client = useClient();
  const queries = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () =>
      call(() =>
        client.organizations({ orgId }).connections({ connectionId: connection.id }).delete(),
      ),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ["connections", orgId] });
      toast(`Deleted ${connection.name}.`);
    },
  });
  const address = connection.config.baseUrl;
  const keep = () => {
    remove.reset();
    setConfirming(false);
  };
  return (
    <tr>
      <th scope="row">{connection.name}</th>
      <td>{FORGES[connection.type as Forge]?.name ?? connection.type}</td>
      <td>{typeof address === "string" ? address : "Not recorded"}</td>
      <td>
        <time dateTime={stamp(connection.createdAt)}>{when(connection.createdAt)}</time>
      </td>
      <td>
        <div className="row">
          {actions.includes("connection.test") && (
            <button type="button" disabled={busy} onClick={onTest}>
              {testing ? "Testing…" : <Named word="Test" name={connection.name} />}
            </button>
          )}
          {actions.includes("connection.delete") && (
            <button
              type="button"
              onClick={() => {
                onAsk();
                setConfirming(true);
              }}
            >
              <Named word="Delete…" name={connection.name} />
            </button>
          )}
        </div>
        {confirming && (
          <Confirm
            title={`Delete ${connection.name}`}
            warn="Its stored token is deleted, and what reaches its forge through it stops working until another connection is set up."
            note="One that sync targets still use cannot be deleted."
            go={`Delete ${connection.name}`}
            busy={remove.isPending}
            error={remove.error?.message}
            onConfirm={() => remove.mutate()}
            close={keep}
          />
        )}
      </td>
    </tr>
  );
}

function Connections({ orgId, actions }: { orgId: string; actions: Access["actions"] }) {
  const client = useClient();
  const connections = useConnections(orgId);
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const test = useMutation({ mutationFn: (c: Connection) => probe(client, orgId, c) });
  return (
    <Card
      title="Connections"
      sub="The GitLab and GitHub access tokens this organization works through. A token is stored encrypted and is never shown again."
      actions={
        actions.includes("connection.create") && (
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            Add a connection…
          </button>
        )
      }
    >
      {connections.isPending && <Loading what="Loading connections" />}
      {connections.error && !connections.data && (
        <ErrorPanel error={connections.error} retry={() => void connections.refetch()} />
      )}
      {connections.data &&
        (connections.data.length === 0 ? (
          <Empty title="No connection yet" text="Nothing is connected to GitLab or GitHub yet." />
        ) : (
          <div className="scroll">
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
                  <Row
                    key={c.id}
                    orgId={orgId}
                    connection={c}
                    actions={actions}
                    testing={test.isPending && test.variables?.id === c.id}
                    busy={test.isPending}
                    onTest={() => test.mutate(c)}
                    // the news of an earlier test says nothing of what is about to be decided
                    onAsk={() => test.reset()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {test.data && test.variables && <Tested name={test.variables.name} outcome={test.data} />}
      {test.error && (
        <Callout tone="bad" title={test.variables?.name}>
          {test.error.message}
        </Callout>
      )}
      {adding && (
        <Drawer
          title="Add a connection"
          sub="The platform reads your projects with this token."
          close={() => setAdding(false)}
        >
          <AddConnection
            orgId={orgId}
            onDone={(_, name) => {
              setAdding(false);
              toast(`Connected ${name}.`);
            }}
            onCancel={() => setAdding(false)}
          />
        </Drawer>
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
