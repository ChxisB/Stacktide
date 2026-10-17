import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";
import { allPages, useClient } from "./api";
import { ErrorPanel, useMe } from "./auth";
import { Loading } from "./ui";

export interface Org {
  id: string;
  slug: string;
  name: string;
}

interface OrgState {
  orgs: UseQueryResult<Org[]>;
  /** The organization the pages are about: the chosen one, else the first. */
  org: Org | undefined;
  select: (id: string) => void;
}

const OrgContext = createContext<OrgState | undefined>(undefined);
// A per-browser, per-user convenience only: it may be blocked or empty, and the page works without it.
const stored = (userId: string) => `orch.org.${userId}`;
const remembered = (userId: string) => {
  try {
    return localStorage.getItem(stored(userId)) ?? undefined;
  } catch {
    return undefined;
  }
};
const remember = (userId: string, id: string) => {
  try {
    localStorage.setItem(stored(userId), id);
  } catch {
    // nothing to do: the choice lasts until the page is reloaded
  }
};

/** The organizations the signed-in user holds a role in, and which of them the pages show. */
export function OrgProvider({ children }: { children: ReactNode }) {
  const client = useClient();
  const me = useMe();
  const orgs = useQuery({
    queryKey: ["orgs"],
    queryFn: () =>
      allPages<Org>((cursor) => client.organizations.get({ query: { limit: 100, cursor } })),
  });
  const [chosen, setChosen] = useState(() => remembered(me.id));
  const org = orgs.data?.find((o) => o.id === chosen) ?? orgs.data?.[0];
  const select = (id: string) => {
    remember(me.id, id);
    setChosen(id);
  };
  return <OrgContext.Provider value={{ orgs, org, select }}>{children}</OrgContext.Provider>;
}

export function useOrgState(): OrgState {
  const state = useContext(OrgContext);
  if (!state) throw new Error("no organizations: render inside <OrgProvider>");
  return state;
}

/** The part of a page that is about an organization: waits for the list, and says so when the user has none. */
export function RequireOrg({ children }: { children: (org: Org) => ReactNode }) {
  const { orgs, org } = useOrgState();
  if (orgs.isPending) return <Loading what="Loading organizations" />;
  if (orgs.error) return <ErrorPanel error={orgs.error} retry={() => void orgs.refetch()} />;
  if (!org) {
    return (
      <p>
        You are not in an organization here. An organization is linked to a GitLab group, and its
        members get their roles from that group: ask a platform admin to create one for your group,
        then sign in again.
      </p>
    );
  }
  return children(org);
}

/** A choice between organizations when there are several; the name when there is one. */
export function OrgSwitcher() {
  const { orgs, org, select } = useOrgState();
  const list = orgs.data ?? [];
  if (!org) return null;
  if (list.length < 2) return <span className="org">{org.name}</span>;
  return (
    <label className="org">
      <span className="visually-hidden">Organization</span>
      <select value={org.id} onChange={(e) => select(e.target.value)}>
        {list.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
