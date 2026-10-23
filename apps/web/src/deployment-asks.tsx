import type { Client } from "@orch/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { call, useClient } from "./api";
import { useMe } from "./auth";

/** A request to deploy a build into a protected environment that is still alive: asked, or approved and not yet used. */
export interface Ask {
  id: string;
  sha: string;
  status: "open" | "approved";
  /** Asked by the person looking: they cannot approve it. */
  mine: boolean;
}

const short = (sha: string) => sha.slice(0, 8);
const message = (e: unknown) => (e instanceof Error ? e.message : "That did not work.");

/** The change requests of one environment: the same API a variable change is asked through. */
export const requestsAt = (client: Client, orgId: string, projectId: string, envId: string) =>
  client.organizations({ orgId }).projects({ projectId }).environments({ envId })[
    "change-requests"
  ];

/** What the card keeps for every environment of a project, so one invalidation reaches them all. */
export const asksKey = (orgId: string, projectId: string) => ["deployment-asks", orgId, projectId];

/**
 * The open and approved requests to deploy into an environment. Used ones and rejected or lapsed ones are
 * not shown: the API's list names them by status, and an approval past its expiry is not an approval.
 * shortcut: the newest hundred of each status; an environment with more waiting than that wants some rejected.
 */
export function useAsks(orgId: string, projectId: string, envId: string, enabled = true) {
  const client = useClient();
  const me = useMe();
  return useQuery({
    queryKey: [...asksKey(orgId, projectId), envId],
    enabled,
    queryFn: async (): Promise<Ask[]> => {
      const api = requestsAt(client, orgId, projectId, envId);
      const pages = await Promise.all(
        (["open", "approved"] as const).map((status) =>
          call(() => api.get({ query: { status, limit: 100 } })).then((page) =>
            page.items.map((r) => ({ r, status })),
          ),
        ),
      );
      const now = Date.now();
      return pages.flat().flatMap(({ r, status }) =>
        r.kind === "deploy" && r.subject?.sha && Date.parse(r.expiresAt) > now
          ? [
              {
                id: r.id,
                sha: r.subject.sha,
                status,
                mine: r.author.kind === "user" && r.author.id === me.id,
              },
            ]
          : [],
      );
    },
  });
}

/**
 * The requests to deploy into one protected environment (DEP-18), in its box: what is waiting, with Approve for
 * a request someone else made and Reject for any. Offered to everyone who sees the card, as Refresh is: the API
 * is the gate (a maintainer who is not the author approves), and a refusal is shown in its words.
 */
export function Asks({
  orgId,
  projectId,
  env,
}: {
  orgId: string;
  projectId: string;
  env: { id: string; name: string };
}) {
  const client = useClient();
  const queries = useQueryClient();
  const asks = useAsks(orgId, projectId, env.id);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();
  const decide = async (id: string, how: "approve" | "reject") => {
    setPending(id);
    setError(undefined);
    try {
      const one = requestsAt(client, orgId, projectId, env.id)({ crId: id });
      await call(() => (how === "approve" ? one.approve.post() : one.reject.post()));
      await queries.invalidateQueries({ queryKey: asksKey(orgId, projectId) });
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(undefined);
    }
  };
  return (
    <div className="deploy-last">
      <span className="muted">
        Protected: a deployment here needs an approval from someone other than the person who asks.
      </span>
      {asks.error && <p className="muted">Could not look up the requests: {message(asks.error)}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {(asks.data ?? []).map((a) => (
        <div key={a.id} className="row middle">
          <code>{short(a.sha)}</code>
          <span>
            {a.status === "approved"
              ? "Approved: Promote or Roll back starts it"
              : a.mine
                ? "You asked: someone else has to approve it"
                : "Waiting for approval"}
          </span>
          {a.status === "open" && !a.mine && (
            <button
              type="button"
              disabled={pending === a.id}
              aria-label={`Approve ${short(a.sha)} for ${env.name}`}
              onClick={() => void decide(a.id, "approve")}
            >
              Approve
            </button>
          )}
          <button
            type="button"
            disabled={pending === a.id}
            aria-label={`Reject ${short(a.sha)} for ${env.name}`}
            onClick={() => void decide(a.id, "reject")}
          >
            Reject
          </button>
        </div>
      ))}
    </div>
  );
}
