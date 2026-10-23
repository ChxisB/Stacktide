import type { Client } from "@orch/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, StrictMode } from "react";
import { ClientContext } from "./api";
import { AuthGate } from "./auth";
import { PageHead } from "./components";
import { FindingsPage } from "./findings";
import { Checklist, Tiles } from "./onboarding";
import { OrgProvider, RequireOrg } from "./org";
import { OrganizationsPage } from "./organizations";
import { PipelinePage } from "./pipeline";
import { ProjectsPage } from "./projects";
import { RunsPage } from "./runs";
import { SettingsPage } from "./settings";
import { type Page, Shell } from "./shell";
import { StatePage } from "./state";
import { SyncPage } from "./sync";
import { VariablesPage } from "./variables";

const Home = () => (
  <>
    <PageHead
      title="Welcome"
      eyebrow="Delivery"
      lede="Where your organization stands, and what to do next."
    />
    <RequireOrg>
      {(org) => (
        <>
          <Tiles orgId={org.id} />
          <Checklist orgId={org.id} />
        </>
      )}
    </RequireOrg>
  </>
);

const Projects = () => (
  <>
    <PageHead
      title="Projects"
      eyebrow="Delivery"
      lede="Connect GitLab or GitHub and choose the projects to manage."
    />
    <RequireOrg>{(org) => <ProjectsPage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

// the project choice sits in the header, so the page draws its own once it knows the organization
const variablesHead = (choice?: ReactNode) => (
  <PageHead
    title="Variables"
    eyebrow="Governance"
    lede="The variables of each project, by environment. Values stay masked until someone with access reveals one."
    actions={choice}
  />
);

const Variables = () => (
  <RequireOrg head={variablesHead()}>
    {(org) => <VariablesPage key={org.id} orgId={org.id} head={variablesHead} />}
  </RequireOrg>
);

const Sync = () => (
  <>
    <PageHead
      title="Sync"
      eyebrow="Infrastructure"
      lede="Compare variables with where they are used, then apply the difference."
    />
    <RequireOrg>{(org) => <SyncPage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

const Pipeline = () => (
  <>
    <PageHead
      title="Pipeline"
      eyebrow="Delivery"
      lede="Set up CI for a project through a merge request."
    />
    <RequireOrg>{(org) => <PipelinePage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

const Status = () => (
  <>
    <PageHead
      title="Pipeline status"
      eyebrow="Delivery"
      lede="Recent pipeline runs for each project, as their forge reports them."
    />
    <RequireOrg>{(org) => <RunsPage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

const Findings = () => (
  <>
    <PageHead
      title="Findings"
      eyebrow="Governance"
      lede="What the scans and policy checks found, and what was done about it."
    />
    <RequireOrg>{(org) => <FindingsPage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

const State = () => (
  <>
    <PageHead
      title="State"
      eyebrow="Infrastructure"
      lede="Terraform state for each stack: its versions and its lock."
    />
    <RequireOrg>{(org) => <StatePage key={org.id} orgId={org.id} />}</RequireOrg>
  </>
);

const Settings = () => (
  <>
    <PageHead
      title="Settings"
      eyebrow="Governance"
      lede="Connections, your access, API tokens, sign-in methods and worker pools."
    />
    <RequireOrg>{(org) => <SettingsPage key={org.id} org={org} />}</RequireOrg>
  </>
);

const Organizations = () => (
  <>
    <PageHead
      title="Organizations"
      eyebrow="Governance"
      lede="Organizations, their members and how people sign in to them."
    />
    <OrganizationsPage />
  </>
);

/** The pages, in navigation order; the first is home. Each screen adds itself here. */
const pages: readonly Page[] = [
  { path: "", label: "Home", group: "Delivery", icon: "grid", element: <Home /> },
  { path: "projects", label: "Projects", group: "Delivery", icon: "folder", element: <Projects /> },
  { path: "pipeline", label: "Pipeline", group: "Delivery", icon: "tmpl", element: <Pipeline /> },
  { path: "status", label: "Status", group: "Delivery", icon: "flow", element: <Status /> },
  { path: "state", label: "State", group: "Infrastructure", icon: "db", element: <State /> },
  { path: "sync", label: "Sync", group: "Infrastructure", icon: "sync", element: <Sync /> },
  {
    path: "variables",
    label: "Variables",
    group: "Governance",
    icon: "sliders",
    element: <Variables />,
  },
  {
    path: "findings",
    label: "Findings",
    group: "Governance",
    icon: "shield",
    element: <Findings />,
  },
  {
    path: "organizations",
    label: "Organizations",
    group: "Governance",
    icon: "users",
    element: <Organizations />,
  },
  { path: "settings", label: "Settings", group: "Governance", icon: "gear", element: <Settings /> },
];

export const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: false } },
  });

export function Providers({
  client,
  queries,
  children,
}: {
  client: Client;
  queries: QueryClient;
  children: ReactNode;
}) {
  return (
    <StrictMode>
      <ClientContext.Provider value={client}>
        <QueryClientProvider client={queries}>{children}</QueryClientProvider>
      </ClientContext.Provider>
    </StrictMode>
  );
}

/** The whole app for a given API client; `main.tsx` and the tests both mount this. */
export function App({ client, queries }: { client: Client; queries: QueryClient }) {
  return (
    <Providers client={client} queries={queries}>
      <AuthGate>
        <OrgProvider>
          <Shell pages={pages} />
        </OrgProvider>
      </AuthGate>
    </Providers>
  );
}
